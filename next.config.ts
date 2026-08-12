import type { NextConfig } from "next";

import { buildSecurityHeaders } from "./src/shared/security-headers";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
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
