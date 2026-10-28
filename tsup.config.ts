import { defineConfig } from "tsup";

export default defineConfig([
  // ── CLI entry ─────────────────────────────────────────────────────────────
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    splitting: false,
    // The shebang is required for the global `silo` binary
    banner: { js: "#!/usr/bin/env node" },
  },
  // ── Proxy daemon entry ────────────────────────────────────────────────────
  // Bundled as a separate file so `silo start` can spawn it detached without
  // pulling in the entire CLI dependency graph.
  {
    entry: { "proxy-daemon": "src/proxy/daemon.ts" },
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    sourcemap: true,
    splitting: false,
    // No shebang — spawned by Node, not executed directly by the shell
  },
]);
