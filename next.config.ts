import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: true,
  poweredByHeader: false,
  // mapbox-gl ships as ESM ("type": "module") and react-map-gl re-exports it;
  // both must be transpiled by Next so the `react-map-gl/mapbox` + `mapbox-gl`
  // imports resolve correctly under the App Router / Turbopack.
  transpilePackages: ["mapbox-gl", "react-map-gl"],
  async headers() {
    return [
      {
        // Cache GeoJSON in the browser for 1 day, CDN/proxy for 7 days
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
