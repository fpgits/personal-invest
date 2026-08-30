import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
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
  transpilePackages: ["@vault/auth"],
  turbopack: { root: path.join(__dirname, "..") },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  /**
   * El portal es la puerta del vault y el resto de modulos se sirven detras
   * de el como zonas: /invest se proxyea al deployment de invest, que corre
   * con basePath "/invest". Al vivir todo bajo el dominio del portal, una
   * sola cookie de sesion cubre el vault entero, tambien en *.vercel.app.
   *
   * INVEST_URL = URL de produccion del proyecto invest en Vercel
   * (https://xxx.vercel.app). Sin barra final.
   */
  async rewrites() {
    const investUrl = process.env.INVEST_URL;
    if (!investUrl) return [];
    return [
      { source: "/invest", destination: `${investUrl}/invest` },
      { source: "/invest/:path*", destination: `${investUrl}/invest/:path*` },
    ];
  },
};

export default nextConfig;
