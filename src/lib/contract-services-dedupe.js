const text = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleUpperCase('es-PE').replace(/\s+/g, ' ')
const present = value => value != null && String(value).trim() !== ''

function guides(service) {
  return new Set(String(service.referral_guide || '').split(/[,;\n]/).map(text).filter(Boolean))
}

function sameAmountAndService(a, b) {
  return a.contract_id === b.contract_id && text(a.service_type) === text(b.service_type) &&
    String(a.service_date || '').slice(0, 10) === String(b.service_date || '').slice(0, 10) &&
    Number(a.amount_pen) === Number(b.amount_pen)
}

function createdNear(a, b, maxMinutes = 15) {
  const left = Date.parse(a.created_at || '')
  const right = Date.parse(b.created_at || '')
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= maxMinutes * 60_000
}

function sameServiceEvidence(a, b) {
  if (!sameAmountAndService(a, b)) return false
  if (present(a.dispatch_id) && present(b.dispatch_id)) return a.dispatch_id === b.dispatch_id

  const aGuides = guides(a)
  const bGuides = guides(b)
  if ([...aGuides].some(guide => bGuides.has(guide))) return true

  const aPlate = text(a.plate)
  const bPlate = text(b.plate)
  const aDriver = text(a.driver_name)
  const bDriver = text(b.driver_name)
  if (aPlate && aPlate === bPlate && aDriver && aDriver === bDriver && createdNear(a, b, 60)) return true

  const aDescription = text(a.description)
  const bDescription = text(b.description)
  return Boolean(aDescription && aDescription === bDescription && createdNear(a, b))
}

function completeness(service) {
  return [service.dispatch_id, service.plate, service.driver_name, service.referral_guide,
    service.provider_name, service.provider_ruc, service.description, service.category,
    text(service.service_type) === 'MONTACARGA' ? service.hours : null].filter(present).length
}

/** Hides only a less-complete, active row with strong evidence of the same service. */
function excludeIncompleteServiceDuplicates(services) {
  const hiddenIds = new Set()
  for (const service of services) {
    if (!service?.id || text(service.status) === 'ANULADO') continue
    const score = completeness(service)
    const hasMoreCompleteMatch = services.some(candidate => candidate?.id !== service.id &&
      text(candidate?.status) !== 'ANULADO' && completeness(candidate) > score &&
      sameServiceEvidence(service, candidate))
    if (hasMoreCompleteMatch) hiddenIds.add(service.id)
  }
  return { services: services.filter(service => !hiddenIds.has(service.id)), suppressedCount: hiddenIds.size }
}

module.exports = { excludeIncompleteServiceDuplicates }
