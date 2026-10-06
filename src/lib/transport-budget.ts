/** Gross budget retains the owner's input; profit is protected, with cents preserved. */
export function operatingBudget(gross: number): number {
  const cents = Math.round(gross * 100)
  return (cents - Math.round(cents * 0.2)) / 100
}

/** Default route split follows approved service estimates; any remainder stays in the last service. */
export function splitFreight(total: number, services: { id: string; service_cost?: number | null }[]) {
  const cents = Math.round(total * 100)
  const weights = services.map(s => Math.max(0, Number(s.service_cost || 0)))
  const sum = weights.reduce((a, b) => a + b, 0)
  let remaining = cents
  return services.map((s, index) => {
    const part = index === services.length - 1 ? remaining : Math.min(remaining,
      Math.floor(cents * (sum > 0 ? weights[index] / sum : 1 / services.length)))
    remaining -= part
    return { id: s.id, amount: part / 100 }
  })
}
