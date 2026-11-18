import { afterEach, expect, it, vi } from "vitest";
import { pinRuntimeEndpoint } from "./gateway-endpoint.js";

afterEach(() => vi.unstubAllEnvs());
const answers = (...addresses: string[]) =>
  vi.fn(async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );

it("pins the numeric address of a public runtime without a private-endpoint grant", async () => {
  const endpoint = await pinRuntimeEndpoint("https://runtime.example.test:8443", {
    resolveHostname: answers("93.184.216.34"),
  });
  expect(endpoint).toMatchObject({
    origin: "https://93.184.216.34:8443",
    serverName: "runtime.example.test",
    hostHeader: "runtime.example.test:8443",
  });
});

it.each(["10.0.0.8", "100.64.10.8", "fd50::8"])(
  "requires an operator's exact origin grant for private address %s",
  async (address) => {
    const url = "https://runtime.example.test:8443";
    const resolveHostname = answers(address);
    await expect(pinRuntimeEndpoint(url, { resolveHostname })).rejects.toThrow(/operator/);
    vi.stubEnv("COMPUTER_RUNTIME_PRIVATE_ORIGINS", url);
    await expect(pinRuntimeEndpoint(url, { resolveHostname })).resolves.toMatchObject({
      serverName: "runtime.example.test",
    });
    await expect(
      pinRuntimeEndpoint("https://runtime.example.test:9443", { resolveHostname }),
    ).rejects.toThrow(/operator/);
    await expect(
      pinRuntimeEndpoint("https://another.example.test:8443", { resolveHostname }),
    ).rejects.toThrow(/operator/);
  },
);

it.each(["127.0.0.1", "::1", "169.254.169.254", "169.254.1.1", "fe80::1", "::ffff:127.0.0.1"])(
  "rejects forbidden DNS address %s even for a trusted origin",
  async (address) => {
    vi.stubEnv("COMPUTER_RUNTIME_PRIVATE_ORIGINS", "https://runtime.example.test");
    await expect(
      pinRuntimeEndpoint("https://runtime.example.test", { resolveHostname: answers(address) }),
    ).rejects.toThrow(/blocked/);
  },
);

it("rejects DNS rebinding and mixed forbidden answers before returning a dial target", async () => {
  const resolveHostname = vi
    .fn()
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 }]);
  await expect(
    pinRuntimeEndpoint("https://runtime.example.test", { resolveHostname }),
  ).resolves.toBeDefined();
  await expect(
    pinRuntimeEndpoint("https://runtime.example.test", { resolveHostname }),
  ).rejects.toThrow(/operator/);
  vi.stubEnv("COMPUTER_RUNTIME_PRIVATE_ORIGINS", "https://runtime.example.test");
  await expect(
    pinRuntimeEndpoint("https://runtime.example.test", {
      resolveHostname: answers("100.64.10.8", "169.254.169.254"),
    }),
  ).rejects.toThrow(/blocked/);
  await expect(
    pinRuntimeEndpoint("https://runtime.example.test", {
      resolveHostname: answers("100.64.10.8", "93.184.216.34"),
    }),
  ).rejects.toThrow(/mixed/);
});
