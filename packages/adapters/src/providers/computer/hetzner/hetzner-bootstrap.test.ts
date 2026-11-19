import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { computerCloudInit, runtimeCertificate } from "./hetzner-bootstrap.js";

it.each(["bookworm", "trixie"])(
  "starts the supervisor with Docker from the guest’s %s repository",
  (release) => {
    const root = mkdtempSync(path.join(tmpdir(), "computer-bootstrap-"));
    try {
      const appImage = `registry.example.test/app@sha256:${"a".repeat(64)}`;
      const computerImage = `registry.example.test/computer@sha256:${"b".repeat(64)}`;
      const config = JSON.parse(
        computerCloudInit({
          appImage,
          computerImage,
          homeKey: "bot-a",
          token: "fake-runtime-token",
          certificate: "fake-certificate",
          privateKey: "fake-key",
        }).split("\n")[1]!,
      );
      const files = config.write_files.map(
        (file: { path: string; content: string; permissions: string }) => ({
          ...file,
          content: Buffer.from(file.content, "base64").toString(),
        }),
      );
      const script = files.find((file: { path: string }) =>
        file.path.endsWith("/rakazo-runtime-bootstrap"),
      )!.content;
      const nginx = files.find((file: { path: string }) =>
        file.path.endsWith("rakazo-runtime.conf"),
      )!.content;
      const log = path.join(root, "commands.jsonl");
      mkdirSync(path.join(root, "apt/keyrings"), { recursive: true });
      mkdirSync(path.join(root, "apt/sources.list.d"));
      for (const command of ["chmod", "awk", "grep"]) {
        symlinkSync(`/usr/bin/${command}`, path.join(root, command));
      }
      for (const command of [
        "apt-get",
        "systemctl",
        "install",
        "docker",
        "rm",
        "nginx",
        "curl",
        "gpg",
        "ufw",
      ]) {
        const file = path.join(root, command);
        writeFileSync(
          file,
          `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.CAPTURE_COMMANDS,JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2),token:process.env.SANDBOX_SUPERVISOR_TOKEN})+"\\n");\nif (${JSON.stringify(command)} === "curl") require("node:fs").writeFileSync(process.argv.at(-1), "fake-key");\nif (${JSON.stringify(command)} === "gpg") process.stdout.write("pub:\\nfpr:::::::::"+(process.env.DOCKER_TEST_KEY ?? "9DC858229FC7DD38854AE2D88D81803C0EBFCD88")+":\\n");\nif (${JSON.stringify(command)} === "ufw" && process.argv.includes("status")) process.stdout.write("Status: active\\n");\nif (process.argv.includes("/app/infra/compose/restrict-computer-egress.sh")) process.stdout.write('#!/bin/sh\\nprintf \\'%s\\\\n\\' \\'{"command":"egress","args":[]}\\' >> "$CAPTURE_COMMANDS"\\nexit "'+(process.env.FAIL_EGRESS_TEST ?? "0")+'"\\n');\n`,
        );
        chmodSync(file, 0o700);
      }
      const file = path.join(root, "bootstrap.sh");
      const osRelease = path.join(root, "os-release");
      writeFileSync(osRelease, `ID=debian\nVERSION_CODENAME=${release}\n`);
      writeFileSync(
        file,
        script
          .replaceAll("/etc/os-release", osRelease)
          .replaceAll("/etc/apt", path.join(root, "apt"))
          .replaceAll("/usr/local/sbin/rakazo-computer-egress", path.join(root, "egress.sh")),
      );
      execFileSync("/bin/sh", [file], {
        env: { PATH: root, CAPTURE_COMMANDS: log, SANDBOX_SUPERVISOR_TOKEN: "fake-runtime-token" },
      });
      expect(readFileSync(path.join(root, "apt/sources.list.d/docker.list"), "utf8")).toContain(
        `https://download.docker.com/linux/debian ${release} stable`,
      );
      // systemd executes the installed file directly when the VM starts again.
      execFileSync(path.join(root, "egress.sh"), ["--apply"], {
        env: { CAPTURE_COMMANDS: log },
      });
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const docker = calls.filter((call) => call.command === "docker");
      expect(docker).toHaveLength(4);
      expect(docker[0].args).toEqual(["pull", computerImage]);
      expect(docker[1].args).toEqual(["pull", appImage]);
      expect(docker[2].args).toContain("/app/infra/compose/restrict-computer-egress.sh");
      expect(docker[3].args.slice(-5)).toEqual([
        appImage,
        "pnpm",
        "--filter",
        "@rakazo/sandbox-supervisor",
        "start",
      ]);
      expect(docker[3].args).toContain("/var/lib/rakazo:/var/lib/rakazo");
      expect(docker[3].args).toContain("SUPERVISOR_HOST=127.0.0.1");
      expect(docker[3].args).toContain("SANDBOX_SUPERVISOR_TOKEN");
      expect(docker[3].args).toContain("SANDBOX_COMPUTER_EGRESS=restricted");
      expect(docker[3].args.join(" ")).not.toContain("fake-runtime-token");
      expect(docker[3].token).toBe("fake-runtime-token");
      expect(calls.findIndex((call) => call.command === "egress")).toBeLessThan(
        calls.findIndex(
          (call) => call.command === "docker" && call.args.includes("rakazo-runtime"),
        ),
      );
      expect(
        calls.some(
          (call) => call.command === "install" && call.args.includes("/var/lib/rakazo/homes/bot-a"),
        ),
      ).toBe(true);
      expect(
        calls.some((call) => call.command === "ufw" && call.args.join(" ") === "allow 443/tcp"),
      ).toBe(true);
      expect(nginx).toContain("if ($runtime_authorized = 0) { return 403; }");
      expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade;");
      expect(nginx).toContain("listen 443 ssl;");
      expect(files.every((entry: { permissions: string }) => entry.permissions === "0600")).toBe(
        true,
      );
      writeFileSync(log, "");
      expect(() =>
        execFileSync("/bin/sh", [file], {
          env: { PATH: root, CAPTURE_COMMANDS: log, FAIL_EGRESS_TEST: "73" },
          stdio: "pipe",
        }),
      ).toThrow();
      const refused = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        refused.some((call) => call.command === "docker" && call.args.includes("rakazo-runtime")),
      ).toBe(false);
      writeFileSync(log, "");
      expect(() =>
        execFileSync("/bin/sh", [file], {
          env: { PATH: root, CAPTURE_COMMANDS: log, DOCKER_TEST_KEY: "unexpected" },
          stdio: "pipe",
        }),
      ).toThrow();
      expect(readFileSync(log, "utf8")).not.toContain("docker-ce");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("generates an independent private key and certificate with the fingerprint the transport verifies", async () => {
  const first = await runtimeCertificate();
  const second = await runtimeCertificate();
  const certificate = new X509Certificate(first.certificate);
  expect(createHash("sha256").update(certificate.raw).digest("base64url")).toBe(first.fingerprint);
  expect(first.fingerprint).not.toBe(second.fingerprint);
  expect(first.privateKey).not.toBe(second.privateKey);
  expect(certificate.verify(certificate.publicKey)).toBe(true);
});
