import type { NextConfig } from "next";
import packageJson from './package.json';

const isCapacitor = process.env.CAPACITOR_BUILD === 'true';

const nextConfig: NextConfig = {
  /* config options here */
  output: isCapacitor ? 'export' : undefined,
  images: isCapacitor ? { unoptimized: true } : undefined,
  // Versión visible en el login: versión, commit y fecha/hora del despliegue (fijadas al compilar).
  env: {
    APP_VERSION: packageJson.version,
    APP_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_BUILD_ID || 'local',
    APP_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
