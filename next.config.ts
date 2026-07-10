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
  // All /api/* requests are served by the Python backend in backend/. Set
  // FASTAPI_URL to point at it in production; the default matches
  // `uvicorn app.main:app --port 8000` for local development.
  async rewrites() {
    const backend = process.env.FASTAPI_URL ?? "http://127.0.0.1:8000"
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }]
  },
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
