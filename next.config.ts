import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "standalone" is for this container's node server. Netlify (NETLIFY=true)
  // and Vercel (VERCEL set) build with their own native Next.js runtimes —
  // standalone output would break them.
  ...(process.env.NETLIFY === "true" || process.env.VERCEL
    ? {}
    : { output: "standalone" as const }),
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
