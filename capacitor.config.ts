import type { CapacitorConfig } from '@capacitor/cli';

// El APK carga el app del conductor en vivo desde producción (Vercel): así cada despliegue web llega
// a los conductores sin reinstalar. No quitar server: lo exige scripts/build-apk.cjs y lo verifica
// scripts/check-release-guards.cjs en cada PR.
const config: CapacitorConfig = {
  appId: 'com.jrm.tms',
  appName: 'JRM-TMS',
  webDir: 'out',
  server: {
    url: 'https://jrm-tms.vercel.app',
    appStartPath: '/app/login'
  }
};

export default config;
