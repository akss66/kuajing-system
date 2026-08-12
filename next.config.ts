import type { NextConfig } from "next";

import { buildSecurityHeaders } from "./src/shared/security-headers";

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
};

export default nextConfig;
