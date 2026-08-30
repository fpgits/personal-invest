import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vault",
  description: "El espacio personal de Fernando: todo en un sitio",
};

/**
 * Sin next/font: la pila del sistema no depende de la red en build ni en
 * runtime, no produce layout shift y ya trae cifras tabulares.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
