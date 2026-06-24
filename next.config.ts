import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ["node:sqlite"],
  webpack: (config) => {
    // db.ts uses `node:` built-ins (fs/path/sqlite). The auto-sync scheduler pulls
    // db into the instrumentation graph, so webpack tries to bundle those and
    // fails on the `node:` scheme. Externalize every `node:` import so it resolves
    // to the real Node built-in at runtime instead of being bundled.
    const existing = config.externals ?? [];
    config.externals = [
      ...(Array.isArray(existing) ? existing : [existing]),
      ({ request }: { request?: string }, cb: (err?: unknown, result?: string) => void) =>
        request?.startsWith("node:") ? cb(undefined, `commonjs ${request}`) : cb(),
    ];
    return config;
  },
};

export default nextConfig;
