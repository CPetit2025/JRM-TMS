import { Capacitor, registerPlugin } from '@capacitor/core'

type NativePoint = {
  id: string; dispatch_id: string; driver_id: string; recorded_at: string
  latitude: number; longitude: number; accuracy_m: number; speed_mps?: number
}
export type NativeBatteryStatus = { exempt: boolean; powerSave: boolean; manufacturer: string; credential: boolean }

// supabaseUrl/anonKey/deviceToken: credencial del dispositivo para que el servicio suba los puntos por sí mismo.
// forget, batteryStatus, requestBatteryExemption y openAppSettings existen desde el APK con seguimiento nativo;
// en un APK anterior la llamada falla y el app sigue como antes.
const plugin = registerPlugin<{
  start(options: { dispatchId: string; driverId: string; supabaseUrl?: string; anonKey?: string; deviceToken?: string }): Promise<void>
  stop(): Promise<void>
  forget(): Promise<void>
  pending(): Promise<{ points: NativePoint[] }>
  acknowledge(options: { ids: string[] }): Promise<void>
  batteryStatus(): Promise<NativeBatteryStatus>
  requestBatteryExemption(): Promise<void>
  openAppSettings(): Promise<void>
}>('RouteTracker')

export const nativeRouteTracker = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('RouteTracker') ? plugin : null

// Credencial del dispositivo por usuario (se registra una vez; el cierre de sesión la revoca en el servidor)
const deviceKey = (userId: string) => `jrm_tracking_device_v1:${userId}`
type DeviceClient = { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }

export async function trackingDeviceToken(client: DeviceClient, userId: string): Promise<string | null> {
  try {
    const saved = localStorage.getItem(deviceKey(userId))
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved
    const { data, error } = await client.rpc('register_tracking_device', { p_label: 'App conductor Android' })
    const token = (data as { success?: boolean; token?: string } | null)?.token
    if (error || !token || !/^[0-9a-f]{64}$/.test(token)) return null
    localStorage.setItem(deviceKey(userId), token)
    return token
  } catch { return null }
}

export function forgetTrackingDevice(userId: string | null | undefined) {
  try { if (userId) localStorage.removeItem(deviceKey(userId)) } catch { /* sin almacenamiento */ }
}
