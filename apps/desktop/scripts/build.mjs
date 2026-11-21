import { build } from "esbuild";

await build({
  entryPoints: {
    main: "src/main/main.ts",
    "this-computer/paired-screen-windows": "src/main/this-computer/paired-screen-windows.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: [
    "electron",
    "electron-updater",
    "koffi",
    "@sentry/electron",
    // Windows screen sharing only loads for the first incoming screen request.
    "./this-computer/paired-screen-windows.js",
  ],
  // Only the release workflow's builds report errors; local and agent builds never do.
  define: {
    "process.env.RAKAZO_DESKTOP_RELEASE": JSON.stringify(process.env.RAKAZO_DESKTOP_RELEASE ?? ""),
    // Self-hosted builds associated with their own passkey domain (see src/main/auth/passkeys.ts).
    "process.env.RAKAZO_PASSKEY_RP_ID": JSON.stringify(process.env.RAKAZO_PASSKEY_RP_ID ?? ""),
  },
});
