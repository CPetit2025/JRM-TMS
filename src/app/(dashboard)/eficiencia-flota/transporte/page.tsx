'use client'

import { Suspense, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download } from 'lucide-react'
import { fleetApi, fmt, mes, pct, soles } from '@/lib/fleet/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { GRUPO_LABEL, type FeEcon, type FeTransporte, type FeYear } from '@/lib/fleet/types'
import { LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { ConfianzaPill, Note, Panel, RecPill, useFeFilters, useFeQuery } from '@/components/fleet/ui'

// Unidades de transporte: costo por tonelada‑km (combustible a precio constante, mantenimiento repartido y mano de obra),
// vehículo frente a asignación, decisión económica de reemplazo, mantenimiento por km por año e indicadores por unidad.

const C_COMB = '#2a78d6'
const C_MANT = '#eb6834'
const C_MO = '#1baf7a'
const CAP_FUENTE: Record<string, string> = { ficha: 'ficha', flota: 'Flota', p95: 'práctica' }

// Diagnóstico: el costo alto ¿es del vehículo o de cómo se usa?
function diagnostico(u: FeTransporte, volMin: number, rendMin: number, mantMax: number): string {
  const veh = (u.rend_rel != null && u.rend_rel < rendMin) || (u.mant_rel != null && u.mant_rel > mantMax)
  const asig = !!u.ociosa || (u.capacidad_fuente !== 'p95' && u.llenado != null && u.llenado < volMin)
  if (veh && asig) return 'Vehículo y asignación'
  if (veh) return 'Vehículo'
  if (asig) return 'Asignación (cargas chicas)'
  if (u.rend_rel == null && u.mant_rel == null) return 'Sin grupo para comparar'
  return 'En línea con su grupo'
}

const ahorroTxt = (e: FeEcon | null) => (e == null ? '—' : e.ahorro > 0 ? `+${fmt(e.ahorro)}` : fmt(e.ahorro))

type Met = 'costo_km' | 'km' | 'kmgal' | 'mant' | 'comb' | 'mant_km'
const METS: Array<{ k: Met; label: string; d: number }> = [
  { k: 'costo_km', label: 'S/ por km', d: 2 }, { k: 'mant_km', label: 'Mant. S/ por km', d: 2 }, { k: 'km', label: 'Km', d: 0 },
  { k: 'kmgal', label: 'Km por galón', d: 1 }, { k: 'mant', label: 'Mantenimiento S/', d: 0 }, { k: 'comb', label: 'Combustible S/', d: 0 },
]

function MiniBars({ u, max }: { u: FeTransporte; max: number }) {
  const ys = u.anios.filter(y => y.anio >= 2021 && y.mant_km != null)
  if (!ys.length) return <p className="text-xs text-slate-400">Sin km y mantenimiento en el mismo mes</p>
  const W = 200, H = 70, bw = Math.min(22, (W - 8) / ys.length - 6)
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" role="img" aria-label={`Mantenimiento por km de ${u.code}`}>
      <line x1="0" x2={W} y1={H} y2={H} stroke="#cbd5e1" />
      {ys.map((y, i) => {
        const x = 4 + i * ((W - 8) / ys.length) + ((W - 8) / ys.length - bw) / 2
        const h = Math.max(2, Math.min(y.mant_km!, max) / max * (H - 12))
        return (
          <g key={y.anio}>
            <title>{`${y.anio}: S/ ${fmt(y.mant_km, 2)} por km · ${fmt(y.km)} km · mantenimiento ${soles(y.mant)}`}</title>
            <rect x={x} y={H - h} width={bw} height={h} rx={3} fill={C_MANT} fillOpacity={y.meses_km < 12 ? 0.55 : 1} />
            <text x={x + bw / 2} y={H - h - 3} textAnchor="middle" fontSize="8.5" fill="#475569">{fmt(y.mant_km, 2)}</text>
            <text x={x + bw / 2} y={H + 11} textAnchor="middle" fontSize="9" fill="#64748b">{String(y.anio).slice(2)}</text>
          </g>
        )
      })}
    </svg>
  )
}

function Transporte() {
  const f = useFeFilters()
  const { data: d, error, loading, reload } = useFeQuery(fleetApi.resumen, f)
  const [met, setMet] = useState<Met>('costo_km')
  const [busy, setBusy] = useState(false)
  const us = useMemo(() => d?.transporte ?? [], [d])
  const chart = useMemo(() => us.filter(u => u.costo_tkm_total != null && (u.kg_viaje ?? 0) >= 1000)
    .map(u => ({ code: u.code, comb: Number((u.comb_tkm ?? 0).toFixed(3)), mant: Number((u.mant_tkm ?? 0).toFixed(3)), mo: Number((u.mo_tkm ?? 0).toFixed(3)), total: u.costo_tkm_total }))
    .sort((a, b) => (a.total ?? 0) - (b.total ?? 0)), [us])
  const years = useMemo(() => Array.from(new Set(us.flatMap(u => u.anios.map(y => y.anio)))).filter(y => y >= 2019).sort(), [us])
  const maxMk = useMemo(() => Math.max(0.5, ...us.flatMap(u => u.anios.filter(y => y.anio >= 2021).map(y => y.mant_km ?? 0))), [us])

  if (!d && loading) return <LoadingBlock label="Calculando unidades…" className="h-80" />
  if (error && !d) return <ErrorBlock message={error} onRetry={reload} />
  if (!d || !us.length) return <EmptyState title="Sin unidades de transporte con datos en el periodo">Amplíe el periodo o cargue la historia en Datos y parámetros.</EmptyState>

  const exportar = async () => {
    setBusy(true)
    try {
      const m = await fleetApi.mensual(f)
      exportAptXlsx(`Eficiencia_Flota_${d.desde.slice(0, 7)}_${d.hasta.slice(0, 7)}`, {
        Unidades: us.map(u => ({ Unidad: u.code, Tipo: u.tipo, Grupo: GRUPO_LABEL[u.grupo], 'Año fab.': u.anio_fab, Edad: u.edad, Decisión: u.rec, Confianza: u.confianza,
          Motivos: u.motivos.join(' · '), 'Meses con km': u.meses_km, Km: u.km, 'Km por año': u.km_anio, 'Km/gal': u.kmgal, 'Km/gal grupo': u.kmgal_grupo,
          'Comb. S/km (precio constante)': u.comb_km, 'Mant. S/km (repartido)': u.mant_km, 'S/km': u.costo_km, 'S/km pagado': u.costo_km_real, 'S/km con mano de obra': u.costo_km_total,
          'Meses con rutas': u.meses_t, Toneladas: u.ton, 't·km': u.tkm, 'Kg/viaje': u.kg_viaje, 'Capacidad kg': u.capacidad, Llenado: u.llenado, '% volumen': u.m3,
          'S/ por t': u.costo_t, 'S/ por t·km': u.costo_tkm, 'S/ por t·km con mano de obra': u.costo_tkm_total, 'Tendencia mant. S/km/año': u.tend_mant_km,
          'Valor nuevo S/': u.valor, 'Valor referencial': u.valor_ref ? 'Sí' : 'No', 'Seguir 1 año S/': u.econ?.seguir, 'Unidad nueva S/año': u.econ?.nuevo,
          'Ahorro reemplazo S/año (tasa baja)': u.econ_bajo?.ahorro, 'Ahorro reemplazo S/año': u.econ?.ahorro, 'Ahorro reemplazo S/año (tasa alta)': u.econ_alto?.ahorro,
          'Años para reemplazo': u.econ?.anios, 'Preventivo a tiempo': u.prev_a_tiempo })),
        'Por año': us.flatMap(u => u.anios.map((y: FeYear) => ({ Unidad: u.code, Año: y.anio, 'Meses con km': y.meses_km, Km: y.km, Galones: y.gal, 'Km/gal': y.kmgal,
          'Combustible S/': y.comb, 'Mantenimiento S/': y.mant, 'Mant. S/km': y.mant_km, 'Total S/km': y.costo_km, Viajes: y.viajes, Toneladas: y.ton }))),
        Mensual: m.filas.map(r => ({ Activo: r.code, Clase: r.clase, Mes: r.mes.slice(0, 7), Fuente: r.fuente, Km: r.km, Galones: r.gal, 'Km/gal': r.kmgal,
          'Combustible S/': r.comb, 'Mantenimiento S/': r.mant, Viajes: r.viajes, Kg: r.kg, 't·km': r.tkm, '% volumen': r.m3, 'Días fuera': r.dias_fuera, 'S/ por km': r.costo_km })),
      })
    } finally { setBusy(false) }
  }

  return (
    <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Periodo {mes(d.desde)} → {mes(d.hasta)}. Combustible a precio constante (S/ {fmt(d.precio_ref, 2)} por galón) y llantas e intervenciones mayores repartidas en {d.params.amortizar_meses ?? 24} meses. Costos por km: meses con km, combustible y mantenimiento; por tonelada, además, rutas y peso.</p>
        <button type="button" onClick={exportar} disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
          <Download className="h-3.5 w-3.5" /> {busy ? 'Exportando…' : 'Excel'}
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="S/ por tonelada‑km" hint={`Combustible, mantenimiento y mano de obra (conductor S/ ${fmt(d.mano_obra?.conductor_mes)} al mes y ayudantes S/ ${fmt(d.mano_obra?.ayudante_hora, 2)} por hora de viaje) entre toneladas × km. Unidades con cargas de al menos 1 t.`}>
          {chart.length ? (
            <div style={{ height: Math.max(180, chart.length * 46 + 50) }}>
              <ResponsiveContainer>
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 40, top: 4, bottom: 4 }} barCategoryGap={10}>
                  <CartesianGrid horizontal={false} stroke="#eef2f7" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={v => fmt(v, 2)} />
                  <YAxis type="category" dataKey="code" width={70} tick={{ fontSize: 12, fill: '#334155' }} />
                  <Tooltip formatter={(v, n) => [`S/ ${fmt(Number(v), 3)}`, n === 'comb' ? 'Combustible' : n === 'mant' ? 'Mantenimiento' : 'Mano de obra']} />
                  <Legend formatter={v => (v === 'comb' ? 'Combustible' : v === 'mant' ? 'Mantenimiento' : 'Mano de obra')} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="comb" stackId="a" fill={C_COMB} stroke="#fff" strokeWidth={1} />
                  <Bar dataKey="mant" stackId="a" fill={C_MANT} stroke="#fff" strokeWidth={1} />
                  <Bar dataKey="mo" stackId="a" fill={C_MO} stroke="#fff" strokeWidth={1} radius={[0, 4, 4, 0]}>
                    <LabelList dataKey="total" position="right" style={{ fontSize: 11, fill: '#0f172a' }} formatter={(v: unknown) => fmt(Number(v), 3)} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <Note>No hay meses con km, rutas y peso a la vez en el periodo.</Note>}
        </Panel>
        <Panel title="Productividad por viaje" hint="Meses con rutas y peso del periodo · horas y espera de la hoja de rutas">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
                <th className="px-2 py-2">Unidad</th><th className="px-2 py-2 text-right">Toneladas</th><th className="px-2 py-2 text-right">Kg/viaje</th>
                <th className="px-2 py-2 text-right">Viajes/mes</th><th className="px-2 py-2 text-right">Horas/viaje</th><th className="px-2 py-2 text-right">Espera/viaje</th>
                <th className="px-2 py-2 text-right">Programados</th><th className="px-2 py-2 text-right">S/ por t</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {us.filter(u => u.meses_t).map(u => (
                  <tr key={u.code}><td className="px-2 py-2 font-bold text-[#002855]">{u.code}<span className="block text-xs font-normal text-slate-500">{u.tipo}</span></td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.ton)}</td><td className="px-2 py-2 text-right font-mono">{fmt(u.kg_viaje)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.viajes_mes, 1)}</td><td className="px-2 py-2 text-right font-mono">{fmt(u.horas_viaje, 1)} h</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.espera_viaje, 1)} h</td><td className="px-2 py-2 text-right font-mono">{pct(u.programados_pct)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.costo_t, 1)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title="¿El costo alto es del vehículo o de la asignación?" hint={`Rendimiento y mantenimiento por km frente a la mediana de su grupo (mismo tipo de unidad); llenado = kg por viaje entre la capacidad (de la ficha, de Flota o práctica: el 95 % de sus viajes pesa menos; con la práctica el llenado típico ronda 50 % y solo cuenta el % de volumen). Umbrales: rendimiento bajo ${pct(d.params.rendimiento_min ?? 0.85)} del grupo, mantenimiento alto ${fmt(d.params.factor_mant ?? 1.5, 1)} veces, llenado bajo ${pct(d.params.volumen_min ?? 0.55)}.`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
              <th className="px-2 py-2">Unidad</th><th className="px-2 py-2">Grupo</th><th className="px-2 py-2 text-right">Km/gal</th><th className="px-2 py-2 text-right">vs grupo</th>
              <th className="px-2 py-2 text-right">Mant. S/km</th><th className="px-2 py-2 text-right">vs grupo</th><th className="px-2 py-2 text-right">Capacidad</th>
              <th className="px-2 py-2 text-right">Kg/viaje</th><th className="px-2 py-2 text-right">Llenado</th><th className="px-2 py-2">Diagnóstico</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {us.map(u => {
                const dg = diagnostico(u, d.params.volumen_min ?? 0.55, d.params.rendimiento_min ?? 0.85, d.params.factor_mant ?? 1.5)
                const bad = (v: number | null, lo: boolean) => v != null && (lo ? v < (d.params.rendimiento_min ?? 0.85) : v > (d.params.factor_mant ?? 1.5))
                return (
                  <tr key={u.code}><td className="px-2 py-2 font-bold text-[#002855]">{u.code}<span className="block text-xs font-normal text-slate-500">{u.glp ? 'GLP' : u.tipo}</span></td>
                    <td className="px-2 py-2 text-xs text-slate-600">{GRUPO_LABEL[u.grupo]}{u.n_grupo ? ` (${u.n_grupo})` : ''}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.kmgal, 1)}</td>
                    <td className={`px-2 py-2 text-right font-mono ${bad(u.rend_rel, true) ? 'font-bold text-red-700' : ''}`}>{u.rend_rel == null ? '—' : pct(u.rend_rel)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.mant_km, 2)}</td>
                    <td className={`px-2 py-2 text-right font-mono ${bad(u.mant_rel, false) ? 'font-bold text-red-700' : ''}`}>{u.mant_rel == null ? '—' : `${fmt(u.mant_rel, 1)}×`}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.capacidad)}{u.capacidad_fuente && <span className="block text-[10px] font-sans text-slate-400">{CAP_FUENTE[u.capacidad_fuente]}</span>}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(u.kg_viaje)}</td>
                    <td className={`px-2 py-2 text-right font-mono ${u.ociosa ? 'font-bold text-amber-700' : ''}`}>{pct(u.llenado)}{u.m3 != null && <span className="block text-[10px] font-sans text-slate-400">vol. {pct(u.m3)}</span>}</td>
                    <td className="px-2 py-2 text-xs font-semibold text-slate-700">{dg}</td></tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">Las unidades a GLP y la grúa no se comparan en km por galón: su consumo no es comparable con el diésel o depende de la operación de la grúa.</p>
      </Panel>

      <Panel title="Decisión económica de reemplazo" hint={`Costo de seguir un año más = mantenimiento (sin llantas) + combustible + pérdida de valor del año + costo de capital sobre su valor de reventa. Unidad nueva = costo anual equivalente de comprarla y venderla al final de su vida útil, con ${pct(d.params.mejora_nuevo ?? 0.1)} menos combustible y el mantenimiento que tuvieron las unidades del grupo hasta los 4 años. Reventa según avisos de Lima. Tasas de ${pct(d.tasas?.[0])} a ${pct(d.tasas?.[2])} porque la tasa de la empresa es confidencial.`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
              <th className="px-2 py-2">Unidad</th><th className="px-2 py-2 text-right">Edad</th><th className="px-2 py-2 text-right">Valor nuevo</th><th className="px-2 py-2 text-right">Reventa hoy</th>
              <th className="px-2 py-2 text-right">Seguir 1 año</th><th className="px-2 py-2 text-right">Unidad nueva/año</th>
              <th className="px-2 py-2 text-right">Ahorro {pct(d.tasas?.[0])}</th><th className="px-2 py-2 text-right">Ahorro {pct(d.tasas?.[1])}</th><th className="px-2 py-2 text-right">Ahorro {pct(d.tasas?.[2])}</th>
              <th className="px-2 py-2 text-right">Reemplazo en</th><th className="px-2 py-2">Datos</th><th className="px-2 py-2">Decisión</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {us.map(u => (
                <tr key={u.code}><td className="px-2 py-2 font-bold text-[#002855]">{u.code}<span className="block text-xs font-normal text-slate-500">{GRUPO_LABEL[u.grupo]}</span></td>
                  <td className="px-2 py-2 text-right font-mono">{u.edad ?? '—'}</td>
                  <td className="px-2 py-2 text-right font-mono">{soles(u.valor)}{u.valor_ref && <span className="block text-[10px] font-sans text-amber-700">referencial</span>}</td>
                  <td className="px-2 py-2 text-right font-mono">{u.valor != null && u.residual != null ? soles(u.valor * u.residual) : '—'}</td>
                  <td className="px-2 py-2 text-right font-mono">{soles(u.econ?.seguir)}</td><td className="px-2 py-2 text-right font-mono">{soles(u.econ?.nuevo)}</td>
                  {[u.econ_bajo, u.econ, u.econ_alto].map((e, i) => <td key={i} className={`px-2 py-2 text-right font-mono ${e && e.ahorro > 0 ? 'font-bold text-red-700' : 'text-slate-600'}`}>{ahorroTxt(e)}</td>)}
                  <td className="px-2 py-2 text-right text-xs">{u.econ == null ? '—' : u.econ.anios == null ? 'más de 15 años' : u.econ.anios === 0 ? 'ya' : `${u.econ.anios} años`}</td>
                  <td className="px-2 py-2"><ConfianzaPill c={u.confianza} /></td>
                  <td className="px-2 py-2"><RecPill rec={u.rec} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">Ahorro positivo (rojo): reemplazar cuesta menos al año que seguir con la unidad. Se recomienda reemplazar solo si el ahorro es positivo con las tres tasas. Sin año de fabricación no se calcula; el valor referencial se reemplaza con la cotización real en Datos y parámetros.</p>
      </Panel>

      <Panel title="Mantenimiento por km recorrido, por año" hint="Toda la historia disponible, en la misma escala, con llantas e intervenciones mayores repartidas. Barras claras: años con menos de 12 meses de km.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {us.map(u => (
            <div key={u.code} id={`u-${u.code}`} className="scroll-mt-24 rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div><p className="text-sm font-black text-slate-800">{u.code}</p><p className="text-xs text-slate-500">{[u.tipo, u.anio_fab].filter(Boolean).join(' · ')}</p></div>
                <RecPill rec={u.rec} />
              </div>
              <MiniBars u={u} max={maxMk} />
              <p className="text-xs text-slate-500">{u.tend_mant_km == null ? 'Tendencia: faltan años completos' : Math.abs(u.tend_mant_km) < 0.05 ? 'Tendencia estable' : `Tendencia: ${u.tend_mant_km > 0 ? 'sube' : 'baja'} S/ ${fmt(Math.abs(u.tend_mant_km), 2)} por km al año`}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Indicadores por unidad y año" actions={
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 p-0.5" role="group" aria-label="Indicador">
          {METS.map(m => <button key={m.k} type="button" onClick={() => setMet(m.k)} aria-pressed={met === m.k}
            className={`rounded-md px-2.5 py-1 text-xs font-bold ${met === m.k ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{m.label}</button>)}
        </div>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
              <th className="px-2 py-2 text-left">Unidad</th>{years.map(y => <th key={y} className="px-2 py-2 text-right">{y}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {us.map(u => (
                <tr key={u.code}><td className="px-2 py-2 font-bold text-[#002855]">{u.code}<span className="block text-xs font-normal text-slate-500">{u.tipo}</span></td>
                  {years.map(y => {
                    const a = u.anios.find(z => z.anio === y)
                    const v = a ? (a[met as keyof FeYear] as number | null) : null
                    return <td key={y} className="px-2 py-2 text-right font-mono tabular-nums" title={a ? `${a.meses_km} meses con km` : ''}>
                      {v == null ? <span className="text-slate-300">—</span> : fmt(v, METS.find(m => m.k === met)!.d)}{a && a.meses_km > 0 && a.meses_km < 12 && <sup className="text-slate-400">{a.meses_km}m</sup>}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">El superíndice indica cuántos meses con km tiene el año. Precio promedio del galón (sin GLP): {Object.entries(d.precio_anio).map(([y, p]) => `${y} S/ ${fmt(p, 2)}`).join(' · ')}.</p>
      </Panel>

      <Panel title="Indicadores del periodo" hint="Meses completos de cada unidad dentro del periodo elegido. Total S/km: combustible a precio constante + mantenimiento repartido; pagado: lo efectivamente pagado en esos meses.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] text-sm">
            <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
              <th className="px-2 py-2">Unidad</th><th className="px-2 py-2 text-right">Edad</th><th className="px-2 py-2 text-right">Meses</th><th className="px-2 py-2 text-right">Km/año</th>
              <th className="px-2 py-2 text-right">Km/gal</th><th className="px-2 py-2 text-right">Comb. S/km</th><th className="px-2 py-2 text-right">Mant. S/km</th>
              <th className="px-2 py-2 text-right">Total S/km</th><th className="px-2 py-2 text-right">S/km pagado</th><th className="px-2 py-2 text-right">S/km con mano de obra</th>
              <th className="px-2 py-2 text-right">S/ por t·km</th><th className="px-2 py-2 text-right">Preventivo a tiempo</th><th className="px-2 py-2">Datos</th><th className="px-2 py-2">Decisión</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {us.map(u => (
                <tr key={u.code}><td className="px-2 py-2 font-bold text-[#002855]">{u.code}<span className="block text-xs font-normal text-slate-500">{u.glp ? 'GLP' : u.tipo}</span></td>
                  <td className="px-2 py-2 text-right font-mono">{u.edad ?? '—'}</td><td className="px-2 py-2 text-right font-mono">{u.meses_km ?? 0}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmt(u.km_anio)}</td><td className="px-2 py-2 text-right font-mono">{fmt(u.kmgal, 1)}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmt(u.comb_km, 2)}</td><td className="px-2 py-2 text-right font-mono">{fmt(u.mant_km, 2)}</td>
                  <td className="px-2 py-2 text-right font-mono font-bold">{fmt(u.costo_km, 2)}</td><td className="px-2 py-2 text-right font-mono text-slate-500">{fmt(u.costo_km_real, 2)}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmt(u.costo_km_total, 2)}</td><td className="px-2 py-2 text-right font-mono">{fmt(u.costo_tkm, 3)}</td>
                  <td className="px-2 py-2 text-right font-mono" title={u.prev_evaluados ? `${u.prev_evaluados} servicios evaluados` : ''}>{pct(u.prev_a_tiempo)}</td>
                  <td className="px-2 py-2"><ConfianzaPill c={u.confianza} /></td>
                  <td className="px-2 py-2"><RecPill rec={u.rec} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

export default function TransportePage() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><Transporte /></Suspense>
}
