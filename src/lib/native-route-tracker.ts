import { Capacitor, registerPlugin } from '@capacitor/core'

type NativePoint = {
  id: string; dispatch_id: string; driver_id: string; recorded_at: string
  latitude: number; longitude: number; accuracy_m: number; speed_mps?: number
}

const plugin = registerPlugin<{
  start(options: { dispatchId: string; driverId: string }): Promise<void>
  stop(): Promise<void>
  pending(): Promise<{ points: NativePoint[] }>
  acknowledge(options: { ids: string[] }): Promise<void>
}>('RouteTracker')

export const nativeRouteTracker = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('RouteTracker') ? plugin : null
