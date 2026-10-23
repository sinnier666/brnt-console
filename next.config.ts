import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "standalone" is for this container's node server. Netlify builds with
  // NETLIFY=true and its own Next.js runtime — standalone output would break it.
  ...(process.env.NETLIFY === "true" ? {} : { output: "standalone" as const }),
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
