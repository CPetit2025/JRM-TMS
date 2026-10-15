import type { PreuseInspection } from './preuse'
export const preuseText = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-PE').replace(/[^a-z0-9]/g, '')
export const preuseMatches = (value: string, search: string) => search.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).every(term => preuseText(value).includes(preuseText(term)))
export function preuseResult(row: PreuseInspection): 'APTO' | 'OBSERVADO' | 'NO_APTO' {
  if (!row.can_operate) return 'NO_APTO'
  return row.answers.some(answer => answer.response === 'R') ? 'OBSERVADO' : 'APTO'
}
export type PreuseFilters = { from: string; to: string; search: string; driver: string; plate: string; inspector: string; result: string }
export type PreuseSort = { key: 'record_sequence' | 'captured_at' | 'driver_name' | 'vehicle_plate' | 'result' | 'inspector_name'; descending: boolean }
export function filterPreuse(rows: PreuseInspection[], filters: PreuseFilters) {
  return rows.filter(row => row.operation_date >= filters.from && row.operation_date <= filters.to
    && preuseMatches([row.driver_name, row.vehicle_plate, row.license, row.inspector_name, row.record_sequence || ''].join(' '), filters.search)
    && preuseMatches(row.driver_name, filters.driver) && preuseMatches(row.vehicle_plate, filters.plate)
    && preuseMatches(row.inspector_name, filters.inspector) && (!filters.result || preuseResult(row) === filters.result))
}
const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true })
export function sortPreuse(rows: PreuseInspection[], sort: PreuseSort) {
  return [...rows].sort((a, b) => {
    const direction = sort.descending ? -1 : 1
    if (sort.key === 'captured_at') return direction * (Date.parse(a.captured_at) - Date.parse(b.captured_at)) || collator.compare(a.operation_id, b.operation_id)
    if (sort.key === 'record_sequence') return direction * ((a.record_sequence || 0) - (b.record_sequence || 0))
    return direction * collator.compare(sort.key === 'result' ? preuseResult(a) : a[sort.key], sort.key === 'result' ? preuseResult(b) : b[sort.key])
  })
}
