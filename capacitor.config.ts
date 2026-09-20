import type { CapacitorConfig } from '@capacitor/cli';

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
