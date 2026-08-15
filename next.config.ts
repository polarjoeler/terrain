import type { NextConfig } from "next";

// Serve Radar at its own subdomain from the same app. These rewrites run in
// Vercel's routing layer (not middleware), so they don't touch RSC streaming.
// They only fire for the radar host, so Terrain is completely unaffected.
const radarHost = [{ type: "host" as const, value: "radar.tembocommerce.app" }];

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/", has: radarHost, destination: "/radar" },
      { source: "/scan", has: radarHost, destination: "/radar/scan" },
      { source: "/scan/:id", has: radarHost, destination: "/radar/scan/:id" },
      { source: "/detections", has: radarHost, destination: "/admin/radar" },
    ];
  },
};

export default nextConfig;
