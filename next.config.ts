import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // hide the floating dev-tools indicator bubble (overlaps the sidebar footer)
  devIndicators: false,
};

export default nextConfig;
