import { createHash } from "node:crypto";
import { shellQuote } from "../../screens/computer-support.js";

export async function runtimeCertificate() {
  const { X509CertificateGenerator } = await import("@peculiar/x509");
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: "CN=rakazo-runtime",
      keys,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000),
    },
    crypto,
  );
  const key = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString(
    "base64",
  );
  return {
    certificate: certificate.toString("pem"),
    privateKey: `-----BEGIN PRIVATE KEY-----\n${key.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`,
    fingerprint: createHash("sha256").update(Buffer.from(certificate.rawData)).digest("base64url"),
  };
}

interface BootstrapOptions {
  appImage: string;
  computerImage: string;
  token: string;
  homeKey: string;
  certificate: string;
  privateKey: string;
}

/** Cloud-init installs the same supervisor and immutable desktop image as a local deployment. */
export function computerCloudInit(options: BootstrapOptions) {
  const home = `/var/lib/rakazo/homes/${options.homeKey}`;
  // Nginx must fit the full Bearer header plus hash entry overhead.
  const nginx = `map_hash_bucket_size 128;
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
map $http_authorization $runtime_authorized { default 0; "Bearer ${options.token}" 1; }
server {
  listen 443 ssl;
  ssl_certificate /etc/rakazo-runtime/server.crt;
  ssl_certificate_key /etc/rakazo-runtime/server.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 100m;
  if ($runtime_authorized = 0) { return 403; }
  location / {
    proxy_pass http://127.0.0.1:7091;
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
  location ~ "^/desktop/(?<desktop_port>[0-9]{4,5})/(?<desktop_path>.*)$" {
    proxy_pass http://127.0.0.1:$desktop_port/$desktop_path$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
}
`;
  const command = [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    "apt-get update",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io nginx iptables",
    "systemctl enable --now docker",
    // Some cloud images enable UFW with only SSH open.
    "if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -qx 'Status: active'; then ufw allow 443/tcp; fi",
    `install -d -m 750 -o 1000 -g 1000 ${shellQuote(home)}`,
    `docker pull ${shellQuote(options.computerImage)}`,
    `docker pull ${shellQuote(options.appImage)}`,
    // The image carries the maintained host rules. Install them before any bot computer can start.
    `docker run --rm --network none --entrypoint /bin/cat ${shellQuote(options.appImage)} /app/infra/compose/restrict-computer-egress.sh > /usr/local/sbin/rakazo-computer-egress`,
    "chmod 0755 /usr/local/sbin/rakazo-computer-egress",
    "/bin/bash /usr/local/sbin/rakazo-computer-egress",
    [
      "docker run -d --name rakazo-runtime --restart unless-stopped --init --user root --network host --security-opt no-new-privileges:true --pids-limit 256 --memory 512m",
      "  -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/rakazo:/var/lib/rakazo",
      "  -e NODE_ENV=production -e DATA_DIR=/var/lib/rakazo -e SUPERVISOR_HOST=127.0.0.1",
      "  -e SANDBOX_SCREEN_NETWORK=published -e SANDBOX_SCREEN_HOST=127.0.0.1 -e SANDBOX_CONTROL_VIA_LOOPBACK=true",
      "  -e SANDBOX_COMPUTER_EGRESS=restricted -e SANDBOX_SUPERVISOR_TOKEN",
      `  -e RAKAZO_COMPUTER_IMAGE=${shellQuote(options.computerImage)}`,
      `  ${shellQuote(options.appImage)} pnpm --filter @rakazo/sandbox-supervisor start`,
    ].join(" \\\n"),
    "rm -f /etc/nginx/sites-enabled/default",
    "nginx -t",
    "systemctl enable nginx",
    "systemctl restart nginx",
    "",
  ];
  const script = command.join("\n");
  const files = [
    { path: "/etc/rakazo-runtime/server.crt", content: options.certificate },
    { path: "/etc/rakazo-runtime/server.key", content: options.privateKey },
    { path: "/etc/nginx/conf.d/rakazo-runtime.conf", content: nginx },
    {
      path: "/etc/rakazo-runtime/environment",
      content: `SANDBOX_SUPERVISOR_TOKEN=${options.token}\n`,
    },
    { path: "/usr/local/sbin/rakazo-runtime-bootstrap", content: script },
  ].map(({ path, content }) => ({
    path,
    permissions: "0600",
    encoding: "b64",
    content: Buffer.from(content).toString("base64"),
  }));
  const data = `#cloud-config\n${JSON.stringify({
    ssh_pwauth: false,
    disable_root: true,
    write_files: files,
    runcmd: [
      [
        "sh",
        "-c",
        "set -a; . /etc/rakazo-runtime/environment; sh /usr/local/sbin/rakazo-runtime-bootstrap",
      ],
    ],
  })}\n`;
  if (Buffer.byteLength(data) > 32768)
    throw new Error("Computer bootstrap exceeds the provider's user-data limit");
  return data;
}
export function validateCloudImages(settings: Record<string, string>) {
  for (const key of ["appImage", "computerImage"])
    if (
      !/^[a-z0-9][a-z0-9./_-]*(?::[0-9]+)?\/[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(
        settings[key] ?? "",
      )
    )
      throw new Error("Computer images must use a registry and SHA-256 digest");
}
