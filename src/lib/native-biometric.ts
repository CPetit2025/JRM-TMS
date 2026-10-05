import { Capacitor, registerPlugin } from '@capacitor/core'

interface BiometricLock {
  status(): Promise<{ available: boolean; enabled: boolean }>
  configure(options: { enabled: boolean }): Promise<void>
  clear(): Promise<void>
}

export const nativeBiometric = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BiometricLock')
  ? registerPlugin<BiometricLock>('BiometricLock') : null
