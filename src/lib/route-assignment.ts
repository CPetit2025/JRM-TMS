// RETORNO_COMPLETADO es el cierre operativo de una ruta propia: la unidad y el conductor ya quedaron libres;
// solo falta su liquidación documentaria.
export const OCCUPIED_DISPATCH_STATUSES = ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'RETORNO', 'ESPERANDO_AUTORIZACION', 'ENTREGADO'] as const

type Route = { id: string; dispatch_number: string; vehicle_plate: string; driver_id?: string | null; status: string; scheduled_departure?: string | null }

/** An additional service belongs to the existing dispatch, never a second simultaneous dispatch. */
export function routeAssignment<T extends Route>(routes: T[], plate: string, driverId?: string | null) {
  const occupied = routes.filter(route => (OCCUPIED_DISPATCH_STATUSES as readonly string[]).includes(route.status))
  const unit = plate ? occupied.find(route => route.vehicle_plate === plate) : undefined
  const driver = driverId ? occupied.find(route => route.driver_id === driverId) : undefined
  const route = unit || driver
  if (!route) return null
  const matches = unit && driverId && unit.driver_id === driverId && (!driver || driver.id === unit.id)
  return { route, kind: matches ? (canAddRouteService({ status: unit.status, plate: unit.vehicle_plate, scheduled_departure: unit.scheduled_departure }) ? 'ADD_SERVICE' : 'CLOSING') : 'CONFLICT' } as const
}

const limaDay = (value: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))

/** «Agregar servicio» solo en rutas en curso o por salir del día o futuras: las de días anteriores se cierran a las 00:00. */
export function canAddRouteService(route: { status: string; plate?: string | null; scheduled_departure?: string | null }, now = new Date()) {
  if (route.plate === 'EXTERNO' || !['PROGRAMADO', 'EN_CURSO', 'EN RUTA'].includes(route.status)) return false
  return !route.scheduled_departure || limaDay(route.scheduled_departure) >= limaDay(now)
}
