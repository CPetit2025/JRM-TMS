export const OCCUPIED_DISPATCH_STATUSES = ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'RETORNO', 'RETORNO_COMPLETADO', 'ESPERANDO_AUTORIZACION', 'ENTREGADO'] as const

type Route = { id: string; dispatch_number: string; vehicle_plate: string; driver_id?: string | null; status: string }

/** An additional service belongs to the existing dispatch, never a second simultaneous dispatch. */
export function routeAssignment<T extends Route>(routes: T[], plate: string, driverId?: string | null) {
  const occupied = routes.filter(route => (OCCUPIED_DISPATCH_STATUSES as readonly string[]).includes(route.status))
  const unit = plate ? occupied.find(route => route.vehicle_plate === plate) : undefined
  const driver = driverId ? occupied.find(route => route.driver_id === driverId) : undefined
  const route = unit || driver
  if (!route) return null
  const matches = unit && driverId && unit.driver_id === driverId && (!driver || driver.id === unit.id)
  return { route, kind: matches ? (['PROGRAMADO', 'EN_CURSO', 'EN RUTA'].includes(unit.status) ? 'ADD_SERVICE' : 'CLOSING') : 'CONFLICT' } as const
}
