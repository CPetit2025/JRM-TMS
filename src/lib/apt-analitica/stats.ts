// Estadística ponderada por cantidad (permanencia, antigüedad). Sin datos, todo devuelve null: nunca cero.

export interface WeightedPoint { value: number; weight: number }

export function weightedMean(points: WeightedPoint[]): number | null {
  let w = 0, s = 0
  for (const p of points) { if (p.weight > 0) { w += p.weight; s += p.value * p.weight } }
  return w > 0 ? s / w : null
}

/** Cuantil ponderado: el menor valor cuya cantidad acumulada alcanza q × total (q en 0–1) */
export function weightedQuantile(points: WeightedPoint[], q: number): number | null {
  const pts = points.filter(p => p.weight > 0).sort((a, b) => a.value - b.value)
  const total = pts.reduce((s, p) => s + p.weight, 0)
  if (!(total > 0)) return null
  const target = q * total
  let acc = 0
  for (const p of pts) {
    acc += p.weight
    if (acc >= target - 1e-9) return p.value
  }
  return pts[pts.length - 1].value
}

export function totalWeight(points: WeightedPoint[]) { return points.reduce((s, p) => s + (p.weight > 0 ? p.weight : 0), 0) }

/** Cociente con denominador ausente o cero = null (no disponible) */
export function ratio(num: number | null | undefined, den: number | null | undefined): number | null {
  if (num === null || num === undefined || den === null || den === undefined || !(Math.abs(den) > 0)) return null
  return num / den
}

export interface Bucket { label: string; min: number; max: number | null; weight: number; count: number }

/** Rangos por días a partir de sus límites inferiores ([0, 1, 3, 7] → 0, 1–2, 3–6, ≥ 7) */
export function bucketize(points: WeightedPoint[], bounds: number[]): Bucket[] {
  const b = [...new Set(bounds)].sort((x, y) => x - y)
  const out: Bucket[] = b.map((min, i) => {
    const next = b[i + 1]
    const max = next === undefined ? null : next - 1
    const label = max === null ? `≥ ${min} d` : min === max ? `${min} d` : `${min}–${max} d`
    return { label, min, max, weight: 0, count: 0 }
  })
  for (const p of points) {
    if (!(p.weight > 0)) continue
    let k = -1
    for (let i = out.length - 1; i >= 0; i--) if (p.value >= out[i].min) { k = i; break }
    if (k < 0) continue
    out[k].weight += p.weight
    out[k].count++
  }
  return out
}

export function summarize(points: WeightedPoint[]) {
  return {
    weight: totalWeight(points),
    mean: weightedMean(points),
    median: weightedQuantile(points, 0.5),
    p90: weightedQuantile(points, 0.9),
    p95: weightedQuantile(points, 0.95),
    max: points.reduce<number | null>((m, p) => p.weight > 0 && (m === null || p.value > m) ? p.value : m, null),
    sameDay: ratio(points.filter(p => p.value === 0).reduce((s, p) => s + p.weight, 0), totalWeight(points)),
  }
}
export type DwellSummary = ReturnType<typeof summarize>
