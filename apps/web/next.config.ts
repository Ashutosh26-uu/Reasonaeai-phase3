import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  rewrites() {
    return Promise.resolve([
      {
        destination: `${process.env.REASONATE_API_ORIGIN ?? "http://localhost:4111"}/v1/:path*`,
        source: "/v1/:path*",
      },
    ]);
  },
  transpilePackages: ["@reasonateai/ui"],
};

export default nextConfig;
