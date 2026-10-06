export type RequestRescheduling = { request_id: string; fecha_anterior: string | null; fecha_nueva: string; at: string }
export function withRescheduling<T extends { id: string }>(requests: T[], history: RequestRescheduling[]): (T & { rescheduling?: RequestRescheduling })[] {
  return requests.map(request => ({ ...request, rescheduling: history.find(item => item.request_id === request.id) }))
}
export function serviceDate(date?: string | null) {
  const value = date?.slice(0,10)
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : 'Sin fecha'
}
export const wasRescheduled = (request: { status: string; rescheduling?: RequestRescheduling }) => request.status === 'REPROGRAMADA' || !!request.rescheduling
