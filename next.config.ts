import type { NextConfig } from "next";
import packageJson from './package.json';

const isCapacitor = process.env.CAPACITOR_BUILD === 'true';
// Cada despliegue tiene su versión: mayor.menor de package.json + fecha y hora (Lima) de compilación, p. ej. 0.2.20261101.1530.
// Numérica para que la comparación con la versión mínima siga funcionando.
const buildTime = new Date();
const limaStamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(buildTime).replace(/\D/g, '');
const appVersion = `${packageJson.version.split('.').slice(0, 2).join('.')}.${limaStamp.slice(0, 8)}.${limaStamp.slice(8)}`;

const nextConfig: NextConfig = {
  /* config options here */
  experimental: { useTypeScriptCli: false },
  output: isCapacitor ? 'export' : undefined,
  images: isCapacitor ? { unoptimized: true } : undefined,
  async headers() {
    if (isCapacitor) return []
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' },
        ],
      },
      {
        source: '/tracking/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ]
  },
  // JRM IA lee la documentación funcional (docs/*.md) para responder dudas de uso del sistema
  outputFileTracingIncludes: {
    '/api/jrm-ai': ['./docs/**/*.md'],
  },
  // Almacén APT: /apt es el inventario multi-almacén; el APT clásico vive en /apt/clasico
  async redirects() {
    if (isCapacitor) return []
    return [
      { source: '/apt/inventario', destination: '/apt', permanent: false },
      { source: '/apt/inventario/:path*', destination: '/apt/:path*', permanent: false },
      // Las direcciones del APT anterior abren el APT clásico restaurado en /apt/clasico
      { source: '/apt/lote/:lote', destination: '/apt/clasico/lote/:lote', permanent: false },
      { source: '/apt/flujo/:path+', destination: '/apt/clasico/flujo/:path+', permanent: false },
      { source: '/apt/:old(cargas|calidad|operacion|ingresos|gantt|clientes|detalle|productos|pareto|heatmap|fecha-entrega|tendencias)', destination: '/apt/clasico/:old', permanent: false },
    ]
  },
  // Versión visible en el login: versión, commit y fecha/hora del despliegue (fijadas al compilar).
  env: {
    APP_VERSION: appVersion,
    APP_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_BUILD_ID || 'local',
    APP_BUILD_TIME: buildTime.toISOString(),
  },
};

export default nextConfig;
