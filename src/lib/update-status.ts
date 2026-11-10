// Estado de las actualizaciones automáticas para el banner del TMS y del WMS (mismo archivo en las dos apps).
//  · ERP (stock y contratos): robot de la PC del ERP a las 07, 10, 13, 16 y 19 h de Lima (UTC−5, sin horario de verano).
//  · Ingresos WMS: robot cada 30 minutos.
// «Actualizar ahora» agrega una ejecución; no cambia estos horarios.
export const ERP_HOURS = [7, 10, 13, 16, 19] as const
const LIMA_OFFSET_H = -5
const MIN = 60_000, HOUR = 60 * MIN
export type Level = 'ok' | 'running' | 'late' | 'error' | 'unknown'
export type SourceState = { level: Level; lastAt: Date | null; nextAt: Date | null; detail: string }
export type RequestInfo = { status: string; requested_at?: string | null; started_at?: string | null; finished_at?: string | null; message?: string | null } | null

/** Horas del ERP como instantes UTC alrededor de `now` (ayer, hoy y mañana en Lima). */
function erpSlots(now: Date) {
  const lima = new Date(now.getTime() + LIMA_OFFSET_H * HOUR)
  const base = Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate())
  return [-1, 0, 1].flatMap(d => ERP_HOURS.map(h => new Date(base + d * 24 * HOUR + (h - LIMA_OFFSET_H) * HOUR)))
}
export const nextErpRun = (now: Date) => erpSlots(now).find(s => s > now) as Date
export const lastErpSlot = (now: Date) => [...erpSlots(now)].reverse().find(s => s <= now) as Date

const date = (v: string | null | undefined) => (v ? new Date(v) : null)

/** ERP: la carga más antigua de las dos (stock y contratos) es la que define si está al día. */
export function erpState(e: { stock_at?: string | null; contratos_at?: string | null; loading_since?: string | null; request?: RequestInfo } | null, now: Date): SourceState {
  const next = nextErpRun(now)
  if (!e) return { level: 'unknown', lastAt: null, nextAt: next, detail: 'Sin datos' }
  const stock = date(e.stock_at), contratos = date(e.contratos_at)
  const lastAt = stock && contratos ? (stock < contratos ? stock : contratos) : stock || contratos
  const loading = date(e.loading_since), req = e.request
  // La carga dura ~15 min: 40 min después de la hora programada ya debería estar aplicada.
  const slot = lastErpSlot(now), overdue = now.getTime() - slot.getTime() > 40 * MIN && (!lastAt || lastAt < new Date(slot.getTime() - 5 * MIN))
  if (loading && now.getTime() - loading.getTime() > 30 * MIN) return { level: 'error', lastAt, nextAt: next, detail: 'Una carga quedó sin terminar' }
  if (req && req.status === 'ERROR' && (!lastAt || (date(req.finished_at) || now) > lastAt)) return { level: 'error', lastAt, nextAt: next, detail: req.message || 'La última actualización falló' }
  // Una solicitud «en curso» de más de 60 min es un corte del robot: el robot la cierra al consultar.
  const started = date(req?.started_at)
  if (req?.status === 'RUNNING' && started && now.getTime() - started.getTime() > 60 * MIN) return { level: 'error', lastAt, nextAt: next, detail: 'El robot no informó el resultado de la última solicitud' }
  if (loading || (req && ['PENDING', 'RUNNING'].includes(req.status))) return { level: 'running', lastAt, nextAt: next, detail: req?.status === 'PENDING' ? 'Solicitud en cola' : 'Actualizando…' }
  if (!lastAt) return { level: 'late', lastAt, nextAt: next, detail: 'Nunca se cargó' }
  return overdue ? { level: 'late', lastAt, nextAt: next, detail: 'No se actualizó en la última hora programada' } : { level: 'ok', lastAt, nextAt: next, detail: 'Al día' }
}

/** Ingresos WMS: robot cada 30 min; más de 45 min sin una carga correcta es atraso. */
export function ingresosState(i: { last_ok_at?: string | null; last_error_at?: string | null; last_error?: string | null; running_since?: string | null; pending?: boolean; last_auto_at?: string | null } | null, now: Date): SourceState {
  if (!i) return { level: 'unknown', lastAt: null, nextAt: null, detail: 'Sin datos' }
  const lastAt = date(i.last_ok_at), lastAuto = date(i.last_auto_at), err = date(i.last_error_at)
  let nextAt = lastAuto ? new Date(lastAuto.getTime() + 30 * MIN) : null
  if (nextAt && nextAt < now) nextAt = new Date(now.getTime() + MIN) // el robot pregunta cada minuto
  if (err && (!lastAt || err > lastAt)) return { level: 'error', lastAt, nextAt, detail: i.last_error || 'La última actualización falló' }
  if (i.running_since || i.pending) return { level: 'running', lastAt, nextAt, detail: i.pending ? 'Solicitud en cola' : 'Actualizando…' }
  if (!lastAt || now.getTime() - lastAt.getTime() > 45 * MIN) return { level: 'late', lastAt, nextAt, detail: 'Más de 45 minutos sin actualizar' }
  return { level: 'ok', lastAt, nextAt, detail: 'Al día' }
}

/** «hace 25 min», «hace 2 h 10 min», «hace 3 d». */
export function since(from: Date | null, now: Date) {
  if (!from) return 'sin registro'
  const m = Math.max(0, Math.round((now.getTime() - from.getTime()) / MIN))
  if (m < 1) return 'hace instantes'
  if (m < 60) return `hace ${m} min`
  if (m < 48 * 60) return `hace ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
  return `hace ${Math.floor(m / 1440)} d`
}
/** «en 25 min» o la hora de Lima si falta más de una hora. */
export function until(to: Date | null, now: Date) {
  if (!to) return '—'
  const m = Math.round((to.getTime() - now.getTime()) / MIN)
  if (m <= 1) return 'en instantes'
  if (m < 60) return `en ${m} min`
  return to.toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })
}
