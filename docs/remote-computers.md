# Computers on an existing Linux host

A Space can run dedicated bot desktops on a Linux host its operator has already prepared.
Rakazo creates and manages desktop containers there; it never creates, stops or deletes the host.
This uses the normal Computer panel, takeover, terminal, shell and file tools. Pi continues to run
in the API/worker. The desktop is the Rakazo Linux image with Chromium, Xvfb, Fluxbox and noVNC,
independent of the host's logged-in desktop.

This is an operator-installed runtime, not arbitrary SSH, VNC, Windows/RDP or device enrollment.
Use a dedicated host with Linux Docker Engine, its iptables firewall backend, systemd and nginx.
The supervisor controls Docker and must be trusted as a host administrator. Keep Docker's socket,
the supervisor's HTTP listener and desktop ports inaccessible from other machines.

## Prepare the host

The following commands are for a fresh Debian/Ubuntu host, run as root. Choose matching published
app and computer releases for the host architecture. Replace both image placeholders with immutable
`registry/image@sha256:<digest>` references before running anything. The app image includes the
supervisor and the maintained egress installer. Image pulls and host installation are operator work;
saving a Space connection does not install this software.

```sh
set -eu
umask 077
APP_IMAGE='registry/app@sha256:<digest>'
COMPUTER_IMAGE='registry/computer@sha256:<digest>'
apt-get update
apt-get install -y --no-install-recommends docker.io nginx iptables openssl python3
systemctl enable --now docker
install -d -m 0700 /etc/rakazo-runtime
install -d -m 0750 -o 1000 -g 1000 /var/lib/rakazo /var/lib/rakazo/homes
openssl rand -hex 32 > /etc/rakazo-runtime/token
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout /etc/rakazo-runtime/server.key -out /etc/rakazo-runtime/server.crt \
  -days 3650 -subj /CN=rakazo-runtime
python3 - <<'PY'
from pathlib import Path
root = Path('/etc/rakazo-runtime')
token = root.joinpath('token').read_text().strip()
root.joinpath('environment').write_text('SANDBOX_SUPERVISOR_TOKEN=' + token + '\n')
PY
docker pull "$APP_IMAGE"
docker pull "$COMPUTER_IMAGE"
docker run --rm --network none --entrypoint /bin/cat "$APP_IMAGE" \
  /app/infra/compose/restrict-computer-egress.sh > /usr/local/sbin/rakazo-computer-egress
chmod 0755 /usr/local/sbin/rakazo-computer-egress
/bin/bash /usr/local/sbin/rakazo-computer-egress

docker run -d --name rakazo-runtime --restart unless-stopped --init \
  --user 1000:1000 --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  --network host --security-opt no-new-privileges:true --pids-limit 256 --memory 512m \
  -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/rakazo:/var/lib/rakazo \
  --env-file /etc/rakazo-runtime/environment \
  -e NODE_ENV=production -e DATA_DIR=/var/lib/rakazo -e SUPERVISOR_HOST=127.0.0.1 \
  -e SANDBOX_SCREEN_NETWORK=published -e SANDBOX_SCREEN_HOST=127.0.0.1 \
  -e SANDBOX_CONTROL_VIA_LOOPBACK=true -e SANDBOX_COMPUTER_EGRESS=restricted \
  -e SANDBOX_COMPUTER_DNS=1.1.1.1,8.8.8.8 \
  -e "RAKAZO_COMPUTER_IMAGE=$COMPUTER_IMAGE" \
  "$APP_IMAGE" pnpm --filter @rakazo/sandbox-supervisor start
```

The non-root supervisor creates new home directories as UID/GID 1000. It does not need per-bot
pre-created folders. The host egress installer persists firewall rules through systemd. Restricted
mode verifies enforcement before starting computers and refuses to start if the host or metadata
network remains reachable. Keep that restriction enabled; the host holds runtime credentials.
See [Docker computers](./self-host-docker-computers.md) for resource limits and networking details.

## Expose an authenticated HTTPS gateway

This example adds a dedicated nginx listener on port 8443 without replacing other sites. Allow
that port only from the Rakazo API, worker and web server networks. It authenticates every HTTP
resource and WebSocket upgrade, including desktop assets. The token stays in root-readable files.

```sh
umask 077
python3 - <<'PY'
from pathlib import Path
root = Path('/etc/rakazo-runtime')
token = root.joinpath('token').read_text().strip()
config = r'''map $http_upgrade $rakazo_upgrade { default upgrade; '' close; }
map $http_authorization $rakazo_authorized { default 0; "Bearer TOKEN" 1; }
server {
  listen 8443 ssl;
  ssl_certificate /etc/rakazo-runtime/server.crt;
  ssl_certificate_key /etc/rakazo-runtime/server.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 100m;
  if ($rakazo_authorized = 0) { return 403; }
  location / {
    proxy_pass http://127.0.0.1:7091;
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
  location ~ ^/desktop/(?<rakazo_port>[0-9]{4,5})/(?<rakazo_path>.*)$ {
    proxy_pass http://127.0.0.1:$rakazo_port/$rakazo_path$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $rakazo_upgrade;
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
}
'''
Path('/etc/nginx/conf.d/rakazo-runtime.conf').write_text(config.replace('TOKEN', token))
PY
nginx -t
systemctl enable --now nginx
systemctl reload nginx
```

For the **Certificate fingerprint** field, compute SHA-256 of the certificate's DER bytes and
encode it as unpadded base64url:

```sh
openssl x509 -in /etc/rakazo-runtime/server.crt -outform DER |
  openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

Transfer the token from `/etc/rakazo-runtime/token` to the connection form through your private
administrative channel. Do not put it in a URL, issue, chat or shared log. The self-signed certificate
is authenticated by its exact fingerprint before any bearer token or command is transmitted.
Certificate rotation requires a new connection with the new pin.

## Connect a Space

Enable `COMPUTER_SETTINGS_ENABLED=true` on the API. The Space owner or an organization admin chooses
**Space settings → Computers → Remote computer**, then supplies the HTTPS runtime origin, access
token and certificate fingerprint. This provider is offered only for Space connections and does
not request paid VM provisioning approval. Credentials use the native encrypted secret store and
are never returned by the settings API.

Public runtime endpoints need no private-origin grant. For a LAN/Tailnet endpoint, the deployment
operator must set an exact origin on **both API and worker**, for example:

```env
COMPUTER_RUNTIME_PRIVATE_ORIGINS=https://runtime.example.com:8443
```

Use a comma-separated list for several origins. This grants only private-network runtime access;
it does not disable TLS pinning. All DNS answers are checked before every operation, then the
connection dials a checked numeric address while retaining the original TLS hostname and HTTP
Host/Origin. Mixed public/private answers are rejected. Loopback, link-local and metadata addresses
are refused even if listed. The web server must also have a network route to the checked runtime
address; it receives an encrypted, signed screen capability, not the runtime token in a browser URL.

Connection selection affects new computers. Existing computers retain their recorded connection
until explicit reset/move. Team and Private Computer modes keep their existing meaning; choose
Private Computers for one desktop per bot. An unreachable runtime is reported instead of falling
back to the deployment's local Docker host.

Stop shuts down the desktop container and retains its home. Restart preserves files and browser
profiles under `/var/lib/rakazo/homes`. Destroy/reset removes the managed container, not the host
or its retained home directory; the operator owns backups, retention and eventual disk cleanup.
The host remains running and its hosting charges continue until the operator changes them.

Offline tests cover the supervisor protocol, shared provider conformance, connection/Space refusal,
private-origin policy, DNS rebinding and pinned HTTP/WebSocket transport. Installation commands,
image pulls and a real existing-host desktop have not been exercised by those tests. An operator
should verify shell execution, file persistence, the live Computer panel and takeover on their
prepared host before relying on it.
