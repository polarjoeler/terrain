import type { NextConfig } from "next";

// Serve Radar at its own subdomain from the same app. These rewrites run in
// Vercel's routing layer (not middleware), so they don't touch RSC streaming.
// They only fire for the radar host, so Terrain is completely unaffected.
const radarHost = [{ type: "host" as const, value: "radar.tembocommerce.app" }];

const nextConfig: NextConfig = {
  async rewrites() {
    // beforeFiles: these run BEFORE the filesystem, so the radar host's "/" is
    // rewritten to /radar before Next serves the real homepage. As a plain array
    // (afterFiles) the "/" rewrite is skipped because "/" already matches the
    // Terrain homepage — which is why radar.tembocommerce.app showed Terrain.
    // All entries are host-gated, so the Terrain host is unaffected.
    return {
      beforeFiles: [
        { source: "/", has: radarHost, destination: "/radar" },
        { source: "/scan", has: radarHost, destination: "/radar/scan" },
        { source: "/scan/:id", has: radarHost, destination: "/radar/scan/:id" },
        { source: "/dashboard", has: radarHost, destination: "/radar/dashboard" },
        { source: "/detections", has: radarHost, destination: "/admin/radar" },
      ],
    };
  },
};

export default nextConfig;
