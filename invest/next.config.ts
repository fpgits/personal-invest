import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  // El vault es personal: nadie tiene motivo para meterlo en un iframe.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  /**
   * Este modulo se sirve como zona del portal del vault, bajo /invest.
   * Mantener sincronizado con MODULE_BASE_PATH en src/lib/utils.ts.
   */
  basePath: "/invest",
  // ccxt es enorme y usa require dinamico. Fuera del bundler, dentro del runtime node.
  serverExternalPackages: ["ccxt", "@libsql/client"],
  // El auth compartido del monorepo es TypeScript sin compilar; Next lo transpila.
  transpilePackages: ["@vault/auth"],
  // Raiz del monorepo explicita: sin esto Turbopack la adivina por el .git
  // mas cercano y puede ignorar el package.json raiz (y con el, los workspaces).
  turbopack: { root: path.join(__dirname, "..") },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "assets.coingecko.com" },
      { protocol: "https", hostname: "coin-images.coingecko.com" },
      { protocol: "https", hostname: "static2.finnhub.io" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
