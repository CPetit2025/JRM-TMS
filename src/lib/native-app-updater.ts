import { Capacitor, registerPlugin } from '@capacitor/core'

interface AppUpdater {
  download(options: { url: string; sha256: string }): Promise<{ ready: boolean; bytes: number }>
  install(): Promise<void>
}

export const nativeAppUpdater = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AppUpdater')
  ? registerPlugin<AppUpdater>('AppUpdater') : null
