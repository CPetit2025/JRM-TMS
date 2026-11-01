import type { Metadata } from "next";
import "./globals.css";
import { webBuildId, webVersion } from "@/lib/app-version";
import { LegacyAiKeyCleanup } from "@/components/LegacyAiKeyCleanup";

export const metadata: Metadata = {
  title: "Torre de Control - JRM | TMS",
  description: "Plataforma Integral de Gestión de Despacho y Transporte",
};

import { Toaster } from 'sonner'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" data-build-id={webBuildId} data-app-version={webVersion}>
      <body className="font-sans antialiased min-h-dvh bg-slate-50">
        {children}
        <LegacyAiKeyCleanup />
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
