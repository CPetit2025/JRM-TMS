import { Capacitor } from '@capacitor/core'
import { Geolocation } from '@capacitor/geolocation'
import { LocalNotifications } from '@capacitor/local-notifications'
import { nativeRouteTracker, type NativeBatteryStatus } from '@/lib/native-route-tracker'

// Lo que el teléfono necesita para que la ruta no se pierda. null = no se puede saber (APK anterior sin esa consulta).
export type PhoneReadiness = {
  location_ok: boolean | null; background_location: boolean | null; notifications_ok: boolean | null
  battery_exempt: boolean | null; power_save: boolean; manufacturer: string
}

const plugin = (name: string) => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(name)
const safe = async <T>(run: () => Promise<T>) => { try { return await run() } catch { return null } }

/** Solo en el APK con seguimiento nativo; en el navegador devuelve null. */
export async function phoneReadiness(): Promise<PhoneReadiness | null> {
  if (!nativeRouteTracker) return null
  const [status, location, notifications] = await Promise.all([
    safe<NativeBatteryStatus>(() => nativeRouteTracker!.batteryStatus()),
    plugin('Geolocation') ? safe(() => Geolocation.checkPermissions()) : null,
    plugin('LocalNotifications') ? safe(() => LocalNotifications.checkPermissions()) : null,
  ])
  return {
    location_ok: location ? location.location === 'granted' : null,
    background_location: typeof status?.backgroundLocation === 'boolean' ? status.backgroundLocation : null,
    notifications_ok: notifications ? notifications.display === 'granted' : null,
    battery_exempt: status ? status.exempt : null,
    power_save: !!status?.powerSave, manufacturer: status?.manufacturer || '',
  }
}

export const requestLocation = () => safe(() => Geolocation.requestPermissions({ permissions: ['location'] }))
export const requestNotifications = () => safe(() => LocalNotifications.requestPermissions())
