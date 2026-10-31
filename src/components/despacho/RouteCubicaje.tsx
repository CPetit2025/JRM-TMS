'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Boxes, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmtDateTime } from '@/lib/apt/format'

// Cubicaje de la ruta por familia de producto (kg y m³, sin LPN). Por parada: el peso estimado de la solicitud si existe,
// repartido según la mezcla de familias de su OT; si no, lo «listo» de la OT en el ERP (pendiente con stock), una sola
// vez por OT. m³ = kg / densidad de la familia (Cubicaje por familia). Solo informa: no bloquea la programación.
const supabase = createClient()

type Familia = { familia: string; pendiente_kg: number; listo_kg: number; lineas_sin_peso: number; kg_por_m3: number | null; m3_listo: number | null }
type Respuesta = { success: true; sin_datos?: boolean; corte_stock: string | null; ots: Array<{ ot: string; familias: Familia[] }> }
export type CubicajeStop = { id: string; ot: string | null; estimated_weight?: number | null }
type Fila = { familia: string; kg: number; densidad: number | null }

// Igual que split_part(erp_key(ot), '-', 1) en la base
const otKey = (ot: string) => ot.trim().toUpperCase().replace(/\s+/g, ' ').split('-')[0]
const fmtKg = (v: number) => `${Math.round(v).toLocaleString('es-PE')} kg`
const fmtM3 = (v: number) => `${v.toLocaleString('es-PE', { maximumFractionDigits: 2 })} m³`

export function cubicajeRuta(stops: CubicajeStop[], ots: Respuesta['ots']) {
  const porOt = new Map(ots.map(o => [o.ot, o.familias]))
  const usadas = new Set<string>()
  const filas = new Map<string, Fila>()
  let sinOrigen = 0
  const sumar = (familia: string, kg: number, densidad: number | null) => {
    if (kg <= 0) return
    const f = filas.get(familia) ?? { familia, kg: 0, densidad }
    f.kg += kg
    filas.set(familia, f)
  }
  for (const s of stops) {
    const est = Number(s.estimated_weight || 0)
    const fams = s.ot ? porOt.get(otKey(s.ot)) : undefined
    if (est > 0) {
      // Mezcla de familias de la OT: por lo listo, o por el pendiente si aún no hay stock
      const base = fams?.reduce((t, f) => t + f.listo_kg, 0) ? 'listo_kg' : 'pendiente_kg'
      const total = fams?.reduce((t, f) => t + f[base], 0) ?? 0
      if (fams && total > 0) fams.forEach(f => sumar(f.familia, est * f[base] / total, f.kg_por_m3))
      else sumar('SIN FAMILIA', est, null)
    } else if (fams && s.ot && !usadas.has(otKey(s.ot))) {
      fams.forEach(f => sumar(f.familia, f.listo_kg, f.kg_por_m3))
    } else sinOrigen++
    if (s.ot) usadas.add(otKey(s.ot))
  }
  const lista = [...filas.values()].sort((a, b) => b.kg - a.kg)
  const kg = lista.reduce((t, f) => t + f.kg, 0)
  const m3 = lista.reduce((t, f) => t + (f.densidad ? f.kg / f.densidad : 0), 0)
  const kgSinMedida = lista.reduce((t, f) => t + (f.densidad ? 0 : f.kg), 0)
  return { filas: lista, kg, m3, kgSinMedida, sinOrigen }
}

function Barra({ label, valor, capacidad, fmt, parcial }: { label: string; valor: number; capacidad: number | null; fmt: (v: number) => string; parcial?: boolean }) {
  const pct = capacidad && capacidad > 0 ? valor / capacidad * 100 : null
  const tone = pct == null ? 'bg-slate-300' : pct > 100 ? 'bg-red-600' : pct > 90 ? 'bg-amber-500' : 'bg-emerald-600'
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-slate-700">{label}</span>
        <span className="tabular-nums text-slate-900"><b>{fmt(valor)}</b>{parcial && <span className="text-amber-700"> parcial</span>}
          {capacidad ? <> / {fmt(capacidad)} · <b className={pct! > 100 ? 'text-red-700' : pct! > 90 ? 'text-amber-700' : 'text-emerald-700'}>{Math.round(pct!)}%</b></> : <span className="text-slate-500"> · sin capacidad</span>}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct == null ? undefined : Math.round(pct)}>
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
      </div>
    </div>
  )
}

export function RouteCubicaje({ stops, capacidadKg, capacidadM3, onCalc }: { stops: CubicajeStop[]; capacidadKg?: number | null; capacidadM3?: number | null; onCalc?: (calc: { kg: number; m3: number; kgSinMedida: number } | null) => void }) {
  const ots = useMemo(() => [...new Set(stops.map(s => s.ot).filter((o): o is string => Boolean(o)))].sort(), [stops])
  const key = ots.join('|')
  const [state, setState] = useState<{ key: string; data: Respuesta | null; error: boolean }>({ key: '', data: null, error: false })
  useEffect(() => {
    if (!key) return
    let alive = true
    Promise.resolve(supabase.rpc('route_cubicaje', { p_ots: key.split('|') })).then(({ data, error }) => {
      if (!alive) return
      const ok = !error && (data as { success?: boolean } | null)?.success
      setState({ key, data: ok ? data as Respuesta : null, error: !ok })
    }, () => { if (alive) setState({ key, data: null, error: true }) })
    return () => { alive = false }
  }, [key])
  const loading = Boolean(key) && state.key !== key
  const data = state.key === key ? state.data : null
  const calc = useMemo(() => cubicajeRuta(stops, data?.ots ?? []), [stops, data])
  // Totales para las alertas del armado de ruta (null mientras se calcula)
  useEffect(() => { onCalc?.(loading || !stops.length ? null : { kg: calc.kg, m3: calc.m3, kgSinMedida: calc.kgSinMedida }) }, [onCalc, loading, stops.length, calc.kg, calc.m3, calc.kgSinMedida])
  if (!stops.length) return null

  return (
    <section aria-label="Carga de la ruta" className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-bold text-slate-900"><Boxes className="h-4 w-4 text-[#002855]" aria-hidden="true" />Carga de la ruta (cubicaje)</p>
        <Link href="/despacho/cubicaje" target="_blank" className="text-xs font-semibold text-[#002855] underline">Densidades por familia</Link>
      </div>
      {loading ? <p className="flex items-center gap-1 text-xs text-slate-500"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Calculando carga…</p>
        : <>
          <div className="space-y-2">
            <Barra label="Peso" valor={calc.kg} capacidad={capacidadKg ?? null} fmt={fmtKg} />
            <Barra label="Volumen" valor={calc.m3} capacidad={capacidadM3 ?? null} fmt={fmtM3} parcial={calc.kgSinMedida > 0} />
          </div>
          {calc.filas.length > 0 && <table className="mt-2 w-full text-xs">
            <thead><tr className="text-left text-[11px] uppercase text-slate-500"><th className="py-1 font-semibold">Familia</th><th className="py-1 text-right font-semibold">kg</th><th className="py-1 text-right font-semibold">m³</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {calc.filas.map(f => <tr key={f.familia}>
                <td className="py-1 pr-2 text-slate-800">{f.familia}</td>
                <td className="py-1 text-right tabular-nums">{fmtKg(f.kg)}</td>
                <td className="py-1 text-right tabular-nums">{f.densidad ? fmtM3(f.kg / f.densidad) : <span className="font-semibold text-amber-700">sin medida</span>}</td>
              </tr>)}
            </tbody>
          </table>}
          {(calc.kgSinMedida > 0 || calc.sinOrigen > 0 || state.error) && <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-800">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{state.error ? 'No se pudo leer la referencia del ERP; se usa solo el peso estimado de las solicitudes. ' : ''}
              {calc.kgSinMedida > 0 ? `${fmtKg(calc.kgSinMedida)} sin densidad configurada: el volumen es parcial. ` : ''}
              {calc.sinOrigen > 0 ? `${calc.sinOrigen} parada(s) sin peso estimado ni stock listo en el ERP.` : ''}</span>
          </p>}
          <p className="mt-1.5 text-[11px] text-slate-500">Peso: estimado de la solicitud o, si falta, lo listo de la OT en el ERP{data?.corte_stock ? ` (stock al ${fmtDateTime(data.corte_stock)})` : ''}. Referencial: no bloquea la programación.</p>
        </>}
    </section>
  )
}
