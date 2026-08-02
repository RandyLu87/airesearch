import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: false,
  transpilePackages: ["@airesearch/research-schema", "@airesearch/research-ui"],
};

export default nextConfig;
