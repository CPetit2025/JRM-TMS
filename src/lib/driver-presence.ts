export type DriverGpsState = 'checking' | 'active' | 'denied' | 'unavailable'
type PresenceClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }> }

// Presence never enters the route queue or contributes kilometers. Only the server chooses the driver.
export function createDriverPresenceReporter(client: PresenceClient) {
  let state: DriverGpsState = 'checking'
  let position: GeolocationPosition | null = null
  let sentAt = 0
  let busy = false
  let stopped = false
  return {
    position(value: GeolocationPosition) { position = value; state = 'active' },
    gps(value: DriverGpsState) { state = value },
    stop() { stopped = true },
    async send(force = false) {
      if (stopped || busy || !navigator.onLine || (!force && Date.now() - sentAt < 15000)) return
      busy = true
      try {
        const coords = position?.coords
        const valid = state === 'active' && coords && Number.isFinite(coords.latitude) && Number.isFinite(coords.longitude) &&
          Number.isFinite(coords.accuracy) && coords.accuracy >= 0 && coords.accuracy <= 2000 &&
          coords.latitude >= -90 && coords.latitude <= 90 && coords.longitude >= -180 && coords.longitude <= 180 &&
          position && Number.isFinite(position.timestamp) && position.timestamp >= Date.now() - 86400000 && position.timestamp <= Date.now() + 30000
        const { error } = await client.rpc('driver_app_heartbeat', {
          p_gps_state: state,
          p_lat: valid ? coords.latitude : null, p_lon: valid ? coords.longitude : null,
          p_accuracy: valid ? coords.accuracy : null,
          p_speed_mps: valid && coords.speed !== null && Number.isFinite(coords.speed) && coords.speed >= 0 && coords.speed <= 100 ? coords.speed : null,
          p_recorded_at: valid && position ? new Date(position.timestamp).toISOString() : null,
        })
        if (!error) sentAt = Date.now()
      } finally { busy = false }
    },
  }
}
