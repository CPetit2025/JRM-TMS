/** Minimum anticipation is measured from original registration, in continuous hours. */
export type DeliveryZone = 'LIMA' | 'PROVINCIA' | 'EXTERIOR'
export type TransportLeadTimeSettings = {
  enabled: boolean
  zones: Record<DeliveryZone, { enabled: boolean; hours: number }>
  version?: number
  captured_at?: string
}
export const DEFAULT_LEAD_TIME_SETTINGS: TransportLeadTimeSettings = {
  enabled: true,
  zones: {
    LIMA: { enabled: true, hours: 24 },
    PROVINCIA: { enabled: true, hours: 48 },
    EXTERIOR: { enabled: true, hours: 72 },
  },
  version: 1,
}
export type LeadTimeStatus = 'COMPLIANT' | 'INSUFFICIENT' | 'DISABLED' | 'UNASSESSED'
export function evaluateLeadTime(input: {
  registeredAt: string | null | undefined
  requiredAt: string | null | undefined
  zone: DeliveryZone | null | undefined
  settings: TransportLeadTimeSettings | null | undefined
}): { status: LeadTimeStatus; enough: boolean | null; minimumAt: string | null; hours: number | null; anticipationHours: number | null } {
  const { registeredAt, requiredAt, zone, settings } = input
  const rule = zone && settings?.zones?.[zone]
  if (settings && (!settings.enabled || (rule && !rule.enabled))) {
    return { status: 'DISABLED', enough: true, minimumAt: null, hours: rule?.hours ?? null, anticipationHours: null }
  }
  const registered = registeredAt ? Date.parse(registeredAt) : NaN
  const requested = requiredAt ? Date.parse(requiredAt) : NaN
  if (!rule || !Number.isFinite(rule.hours) || !Number.isFinite(registered)) {
    return { status: 'UNASSESSED', enough: null, minimumAt: null, hours: rule?.hours ?? null, anticipationHours: null }
  }
  const minimum = registered + rule.hours * 3_600_000
  if (!Number.isFinite(requested)) return { status: 'UNASSESSED', enough: null, minimumAt: new Date(minimum).toISOString(), hours: rule.hours, anticipationHours: null }
  const enough = requested >= minimum
  return { status: enough ? 'COMPLIANT' : 'INSUFFICIENT', enough, minimumAt: new Date(minimum).toISOString(), hours: rule.hours, anticipationHours: (requested - registered) / 3_600_000 }
}

/** A missing historical snapshot must remain unassessed, never apply today's policy retroactively. */
export function settingsForRequest(policy: TransportLeadTimeSettings | null | undefined, _currentSettings?: TransportLeadTimeSettings): TransportLeadTimeSettings | null {
  void _currentSettings
  return policy?.zones ? policy : null
}

/** Peru uses UTC-05:00 year round. Do not parse browser-local dates when saving. */
export function limaDateTimeToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  const instant = new Date(`${date}T${time}:00-05:00`)
  if (!Number.isFinite(instant.getTime())) return null
  const parts = limaInputParts(instant.toISOString())
  return parts.date === date && parts.time === time ? instant.toISOString() : null
}
export function limaInputParts(iso: string | null | undefined): { date: string; time: string } {
  const millis = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(millis)) return { date: '', time: '' }
  const lima = new Date(millis - 5 * 3_600_000).toISOString()
  return { date: lima.slice(0, 10), time: lima.slice(11, 16) }
}
export function formatLeadTimeStatus(status: LeadTimeStatus): string {
  return { COMPLIANT: 'Cumple anticipación', INSUFFICIENT: 'Anticipación insuficiente', DISABLED: 'Control desactivado', UNASSESSED: 'Sin evaluación precisa' }[status]
}
