import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // pdf-parse (lectura de PDF en /api/tools/read-doc) debe ejecutarse desde
  // node_modules sin empaquetar: pdfjs-dist resuelve su worker con rutas
  // relativas que el bundler rompe (fake worker no encontrado).
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
