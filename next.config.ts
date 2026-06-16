import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "www.congress.gov" },
      { protocol: "https", hostname: "bioguide.congress.gov" },
    ],
  },
  transpilePackages: ["mapbox-gl", "react-map-gl"],
  async headers() {
    return [
      {
        source: "/geo/:file*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ]
  },
};

export default nextConfig;
