import type { CapacitorConfig } from '@capacitor/cli';

// El APK carga el app del conductor en vivo desde producción (Vercel): así cada despliegue web llega
// a los conductores sin reinstalar. No quitar server: lo exige scripts/build-apk.cjs y lo verifica
// scripts/check-release-guards.cjs en cada PR.
const warehouseApp = process.env.CAPACITOR_APP === 'warehouse';
const config: CapacitorConfig = {
  appId: warehouseApp ? 'com.jrm.almacen' : 'com.jrm.tms',
  appName: warehouseApp ? 'JRM Almacén' : 'JRM-TMS',
  webDir: 'out',
  server: {
    url: warehouseApp
      ? (process.env.JRM_APP === 'wms-staging' ? 'https://jrm-wms-staging.vercel.app' : 'https://jrm-wms.vercel.app')
      : 'https://jrm-tms.vercel.app',
    appStartPath: warehouseApp ? '/almacen/login' : '/app/login'
  }
};

export default config;
