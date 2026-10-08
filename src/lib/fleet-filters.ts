export type FleetFilters = { search: string; status: string; group: string; type: string; carrier: string; ownership: string; assignment: string; documents: string; app: string }
export const emptyFleetFilters: FleetFilters = { search: '', status: '', group: '', type: '', carrier: '', ownership: '', assignment: '', documents: '', app: '' }
type Carrier = { id: string; business_name?: string; type?: string }
type Driver = { id: string; first_name?: string; last_name?: string; document_number?: string; license_number?: string; is_active?: boolean; profile_id?: string | null; carrier_id?: string }
type Vehicle = { id: string; plate?: string; internal_code?: string; brand?: string; model?: string; type?: string; status?: string; carrier_id?: string; ownership_status?: string; assigned_driver_id?: string | null; soat_expiration?: string | null; technical_review_expiration?: string | null }
const normalized = (value?: string | null) => (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '')
export const TRANSPORT_VEHICLE_TYPES = ['CAMION', 'CAMIONETA', 'FURGON', 'TRAILER', 'TRACTO', 'SEMIRREMOLQUE'] as const
export const isTransportUnit = (type?: string | null) => TRANSPORT_VEHICLE_TYPES.some(value => value === normalized(type))
const matches = (query: string, fields: (string | null | undefined)[]) => query.trim().split(/\s+/).every(word => fields.some(field => normalized(field).includes(normalized(word))))
export const isIndustrialUnit = (type?: string) => ['MONTACARGAS','APILADOR','TRANSPALETA','ELEVADOR'].includes(normalized(type))
export function filterFleetVehicles<T extends Vehicle>(vehicles: T[], drivers: Driver[], carriers: Carrier[], filters: FleetFilters, today: string) {
  return vehicles.filter(vehicle => {
    const driver = drivers.find(d => d.id === vehicle.assigned_driver_id), carrier = carriers.find(c => c.id === vehicle.carrier_id)
    const docs = [vehicle.soat_expiration, vehicle.technical_review_expiration]
    const expired = docs.some(date => date && date.slice(0,10) < today), missing = docs.some(date => !date)
    return matches(filters.search, [vehicle.plate, vehicle.internal_code, vehicle.brand, vehicle.model, driver?.first_name, driver?.last_name, carrier?.business_name]) &&
      (!filters.status || vehicle.status === filters.status) && (!filters.type || normalized(vehicle.type) === normalized(filters.type)) &&
      (!filters.group || isIndustrialUnit(vehicle.type) === (filters.group === 'EQUIPOS')) &&
      (!filters.carrier || vehicle.carrier_id === filters.carrier) && (!filters.ownership || vehicle.ownership_status === filters.ownership) &&
      (!filters.assignment || Boolean(vehicle.assigned_driver_id) === (filters.assignment === 'ASIGNADO')) &&
      (!filters.documents || (filters.documents === 'VENCIDOS' ? expired : filters.documents === 'INCOMPLETOS' ? missing : !expired && !missing))
  }).sort((a,b) => `${a.type || ''} ${a.plate || ''}`.localeCompare(`${b.type || ''} ${b.plate || ''}`, 'es', { numeric: true }))
}
export function filterFleetDrivers<T extends Driver>(drivers: T[], vehicles: Vehicle[], carriers: Carrier[], filters: FleetFilters) {
  return drivers.filter(driver => {
    const vehicle = vehicles.find(v => v.assigned_driver_id === driver.id), carrier = carriers.find(c => c.id === driver.carrier_id)
    return matches(filters.search, [driver.first_name, driver.last_name, driver.document_number, driver.license_number, vehicle?.plate, carrier?.business_name]) &&
      (!filters.status || Boolean(driver.is_active) === (filters.status === 'ACTIVO')) &&
      (!filters.carrier || driver.carrier_id === filters.carrier) &&
      (!filters.assignment || Boolean(vehicle) === (filters.assignment === 'ASIGNADO')) &&
      (!filters.app || Boolean(driver.profile_id) === (filters.app === 'VINCULADO'))
  }).sort((a,b) => `${a.last_name || ''} ${a.first_name || ''}`.localeCompare(`${b.last_name || ''} ${b.first_name || ''}`, 'es'))
}
