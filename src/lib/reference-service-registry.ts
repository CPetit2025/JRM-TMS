/** Costs come from the same freight/unloading reservations used by route planning.
 * These services are authorized against their reference, never an invented OT. */
export interface ReferenceServiceRegistryRow {
  id: string
  request_id: string
  request_number: string
  reference_type: 'OC' | 'OS' | 'RQ'
  reference_number: string
  request_type: string
  dispatch_id: string
  dispatch_number: string
  service_date: string | null
  plate: string | null
  driver_name: string | null
  amount_pen: number
  service_type: string
  status: 'RESERVADO' | 'CONSUMIDO' | 'LIBERADO'
  stage: 'COMPROMETIDO' | 'REALIZADO' | 'ANULADO'
  operation_state: string | null
  description: string | null
  provider_name: string | null
}

export function referenceRegistryTotals(rows: ReferenceServiceRegistryRow[]) {
  // Operational cancellation does not reverse costs already incurred. Only a
  // LIBERADO ledger movement frees an amount; ANULADO + CONSUMIDO stays spent.
  return rows.reduce((totals, row) => {
    const amount = Number(row.amount_pen) || 0
    if (row.status === 'RESERVADO') totals.reserved += amount
    else if (row.status === 'CONSUMIDO') totals.consumed += amount
    else if (row.status === 'LIBERADO') totals.released += amount
    return totals
  }, { reserved: 0, consumed: 0, released: 0 })
}
