export type DriverGpsState = 'checking' | 'active' | 'denied' | 'unavailable'
type PresenceClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }> }
// Estado del teléfono que acompaña al aviso (batería, red, app visible, puntos por enviar): permite distinguir en el
// monitor un corte de señal de un teléfono en ahorro de batería o con el app en segundo plano.
export type DriverClientInfo = Record<string, string | number | boolean | null>

// Presence never enters the route queue or contributes kilometers. Only the server chooses the driver.
export function createDriverPresenceReporter(client: PresenceClient, clientInfo?: () => DriverClientInfo) {
  let state: DriverGpsState = 'checking'
  let position: GeolocationPosition | null = null
  let sentAt = 0
  let busy = false
  let stopped = false
  let withClient = Boolean(clientInfo)
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
        const args: Record<string, unknown> = {
          p_gps_state: state,
          p_lat: valid ? coords.latitude : null, p_lon: valid ? coords.longitude : null,
          p_accuracy: valid ? coords.accuracy : null,
          p_speed_mps: valid && coords.speed !== null && Number.isFinite(coords.speed) && coords.speed >= 0 && coords.speed <= 100 ? coords.speed : null,
          p_recorded_at: valid && position ? new Date(position.timestamp).toISOString() : null,
        }
        let info: DriverClientInfo | null = null
        if (withClient && clientInfo) { try { info = clientInfo() } catch { info = null } }
        let { error } = await client.rpc('driver_app_heartbeat', info ? { ...args, p_client: info } : args)
        // Servidor sin la versión con estado del teléfono (p. ej. una vista previa): se sigue con el aviso simple
        if (error && withClient && /PGRST202|p_client|Could not find the function/i.test(JSON.stringify(error))) {
          withClient = false
          ;({ error } = await client.rpc('driver_app_heartbeat', args))
        }
        if (!error) sentAt = Date.now()
      } finally { busy = false }
    },
  }
}
