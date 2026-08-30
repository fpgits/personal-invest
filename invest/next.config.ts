import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ccxt es enorme y usa require dinamico. Fuera del bundler, dentro del runtime node.
  serverExternalPackages: ["ccxt", "@libsql/client"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "assets.coingecko.com" },
      { protocol: "https", hostname: "coin-images.coingecko.com" },
      { protocol: "https", hostname: "static2.finnhub.io" },
    ],
  },
};

export default nextConfig;
