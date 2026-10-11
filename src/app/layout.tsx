import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider } from "@/components/auth/auth-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OE AI — Modelo unificado de OE BUSINESS",
  description:
    "Conversa con OE AI LLM, el modelo unificado de OE BUSINESS formado por una red de 128 modelos de distintas familias. Historial, conexiones, Instantáneo/Reflexivo y Centro de APIs en /apis.",
  keywords: ["OE AI", "OE BUSINESS", "OE AI LLM", "chat IA", "multimodelo", "red de modelos", "APIs de IA"],
  authors: [{ name: "OE BUSINESS" }],
  icons: { icon: "/oe-logo.svg" },
  openGraph: {
    title: "OE AI — Un ecosistema multimodelo. Una sola plataforma.",
    description:
      "OE AI LLM está listo: 128 modelos conforman la red del modelo unificado. Conversa, explora las conexiones y descubre el catálogo en /apis.",
    siteName: "OE AI",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen flex flex-col`}
      >
        <AuthProvider>
          {children}
        </AuthProvider>
        <Toaster />
      </body>
    </html>
  );
}
