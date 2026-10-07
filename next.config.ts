import type { NextConfig } from "next";
import packageJson from './package.json';

const isCapacitor = process.env.CAPACITOR_BUILD === 'true';

const nextConfig: NextConfig = {
  /* config options here */
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
  // Versión visible en el login: versión, commit y fecha/hora del despliegue (fijadas al compilar).
  env: {
    APP_VERSION: packageJson.version,
    APP_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_BUILD_ID || 'local',
    APP_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
