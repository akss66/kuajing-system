import type { NextConfig } from "next";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSecurityHeaders } from "./src/shared/security-headers";

const projectRoot = dirname(fileURLToPath(import.meta.url));

function containsPath(root: string, target: string) {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !child.startsWith("/"));
}

function resolveTurbopackRoot() {
  const nodeModules = realpathSync.native(resolve(projectRoot, "node_modules"));
  let root = projectRoot;
  while (!containsPath(root, nodeModules)) {
    const parent = dirname(root);
    if (parent === root) {
      throw new Error("Unable to find a common Turbopack filesystem root");
    }
    root = parent;
  }
  return root;
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  experimental: {
    serverActions: {
      bodySizeLimit: "101mb",
    },
  },
  async headers() {
    return [
      {
        headers: buildSecurityHeaders({ production: process.env.NODE_ENV === "production" }),
        source: "/(.*)",
      },
    ];
  },
  poweredByHeader: false,
  turbopack: {
    // Worktrees may link node_modules from the primary checkout. Turbopack
    // must include both the worktree and the resolved dependency directory.
    root: resolveTurbopackRoot(),
  },
};

export default nextConfig;
