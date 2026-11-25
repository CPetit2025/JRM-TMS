'use client'

import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChevronDown, ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
import type { KpiResultado } from '@/lib/indicadores/api'
import { EQUIPOS, estadoInfo, estadoNota, metaTxt, num, valorTxt } from '@/lib/indicadores/format'
import { EstadoBadge, Tendencia } from './KpiCard'

const EVALUADO = ['CUMPLE', 'ALERTA', 'NO_CUMPLE']

/** Variación contra el periodo anterior con dato; «mejora» depende del sentido del KPI. */
function variacion(k: KpiResultado) {
  const serie = [...(k.tendencia || [])].sort((a, b) => a.desde.localeCompare(b.desde)).filter(p => p.valor != null)
  if (!EVALUADO.includes(k.estado) || serie.length < 2) return null
  const d = Number(serie[serie.length - 1].valor) - Number(serie[serie.length - 2].valor)
  if (!Number.isFinite(d)) return null
  return { d, mejora: d === 0 ? null : (k.sentido === 'MAYOR') === d > 0 }
}

function Variacion({ k }: { k: KpiResultado }) {
  const v = variacion(k)
  if (!v) return <span className="text-slate-400">—</span>
  const Icon = v.d >= 0 ? TrendingUp : TrendingDown
  const pp = k.unidad === '%' ? ' pp' : ''
  return <span className="inline-flex items-center gap-1 text-slate-700 tabular-nums">
    {v.mejora != null && <Icon className={`h-4 w-4 ${v.mejora ? 'text-emerald-700' : 'text-red-700'}`} aria-label={v.mejora ? 'mejora' : 'empeora'} />}
    {v.d > 0 ? '+' : ''}{num(v.d)}{pp}
  </span>
}

/** Cifra de cabecera: icono + texto, nunca solo color. */
function Cifra({ label, valor, sub, tono = 'text-slate-900' }: { label: string; valor: number | string; sub?: string; tono?: string }) {
  return <div className="rounded-xl border bg-white p-4">
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p className={`mt-1 text-3xl font-extrabold tabular-nums ${tono}`}>{valor}</p>
    {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
  </div>
}

/** % de KPI evaluados que cumplen, por periodo (de las tendencias que ya trae el tablero). */
function serieCumplimiento(kpis: KpiResultado[]) {
  const por = new Map<string, { etiqueta: string; ev: number; ok: number }>()
  for (const k of kpis) for (const p of k.tendencia || []) {
    const x = por.get(p.desde) || { etiqueta: p.etiqueta, ev: 0, ok: 0 }
    if (EVALUADO.includes(p.estado)) { x.ev++; if (p.estado === 'CUMPLE') x.ok++ }
    por.set(p.desde, x)
  }
  return [...por.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([desde, x]) => ({ desde, ...x, pct: x.ev ? Math.round(1000 * x.ok / x.ev) / 10 : null }))
}

function TipCumplimiento({ active, payload }: { active?: boolean; payload?: Array<{ payload: ReturnType<typeof serieCumplimiento>[number] }> }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return <div className="rounded-lg border bg-white px-3 py-2 text-xs shadow"><p className="font-semibold text-slate-700">{p.etiqueta}</p>
    <p className="text-slate-900">{p.pct == null ? 'Sin KPI evaluados' : `${num(p.pct)} % cumplen`}</p><p className="text-slate-500">{p.ok} de {p.ev} evaluados</p></div>
}

function GraficoCumplimiento({ kpis }: { kpis: KpiResultado[] }) {
  const datos = serieCumplimiento(kpis)
  return <section className="rounded-xl border bg-white p-4" aria-labelledby="g-cumplimiento">
    <h3 id="g-cumplimiento" className="text-sm font-semibold text-[#002855]">Indicadores en meta por periodo</h3>
    <p className="text-xs text-slate-500">% de los KPI evaluados que cumplen su meta. Los pendientes de datos no cuentan.</p>
    {datos.filter(d => d.pct != null).length < 2
      ? <p className="py-10 text-center text-xs text-slate-400">Aún no hay periodos suficientes para la tendencia.</p>
      : <div className="mt-2 h-56" role="img" aria-label={`Indicadores en meta: ${datos.map(d => `${d.etiqueta} ${d.pct == null ? 'sin datos' : `${num(d.pct)} %`}`).join('; ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={datos} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="etiqueta" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={40} tickFormatter={v => `${v} %`} />
            <Tooltip content={<TipCumplimiento />} cursor={{ stroke: '#cbd5e1' }} />
            <Line type="monotone" dataKey="pct" stroke="#002855" strokeWidth={2} connectNulls isAnimationActive={false} dot={{ r: 4, fill: '#002855', stroke: '#fff', strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>}
  </section>
}

/** Barra por equipo: cumple / alerta / no cumple / sin evaluar, con conteo escrito (no solo color). */
function EquiposBarra({ kpis }: { kpis: KpiResultado[] }) {
  const tramos: Array<[string, string, (k: KpiResultado) => boolean]> = [
    ['Cumple', '#047857', k => k.estado === 'CUMPLE'], ['Alerta', '#b45309', k => k.estado === 'ALERTA'],
    ['No cumple', '#b91c1c', k => k.estado === 'NO_CUMPLE'], ['Sin evaluar', '#cbd5e1', k => !EVALUADO.includes(k.estado)]]
  return <section className="rounded-xl border bg-white p-4" aria-labelledby="g-equipos">
    <h3 id="g-equipos" className="text-sm font-semibold text-[#002855]">Situación por equipo</h3>
    <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-600">{tramos.map(([l, c]) => <span key={l} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l}</span>)}</div>
    <div className="mt-3 space-y-3">{EQUIPOS.map(([id, label]) => {
      const g = kpis.filter(k => k.equipo === id)
      if (!g.length) return null
      const partes = tramos.map(([l, c, f]) => ({ l, c, n: g.filter(f).length })).filter(p => p.n > 0)
      return <div key={id}>
        <div className="flex justify-between text-xs"><span className="font-semibold text-slate-700">{label}</span><span className="text-slate-500">{partes.map(p => `${p.n} ${p.l.toLowerCase()}`).join(' · ')}</span></div>
        <div className="mt-1 flex h-3 gap-[2px] overflow-hidden rounded" role="img" aria-label={`${label}: ${partes.map(p => `${p.n} ${p.l}`).join(', ')}`}>
          {partes.map(p => <div key={p.l} title={`${p.l}: ${p.n}`} style={{ flex: p.n, background: p.c }} />)}</div>
      </div>
    })}</div>
  </section>
}

/** Vista ejecutiva: cifras, situación por equipo, tendencia de cumplimiento y tabla compacta; los pendientes al final. */
export function TableroEjecutivo({ kpis, onSelect }: { kpis: KpiResultado[]; onSelect?: (k: KpiResultado) => void }) {
  const [verPendientes, setVerPendientes] = useState(false)
  const evaluados = useMemo(() => kpis.filter(k => EVALUADO.includes(k.estado)), [kpis])
  const sinEvaluar = kpis.filter(k => !EVALUADO.includes(k.estado))
  if (!kpis.length) return <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">No hay indicadores para esta frecuencia.</p>
  const cuenta = (e: string) => evaluados.filter(k => k.estado === e).length
  const fila = 'border-t transition hover:bg-slate-50'

  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Cifra label="En meta" valor={evaluados.length ? `${Math.round(100 * cuenta('CUMPLE') / evaluados.length)} %` : '—'} sub={`${cuenta('CUMPLE')} de ${evaluados.length} evaluados`} />
      <Cifra label="En alerta" valor={cuenta('ALERTA')} sub="cerca de la meta" tono="text-amber-700" />
      <Cifra label="Fuera de meta" valor={cuenta('NO_CUMPLE')} sub="requieren acción" tono="text-red-700" />
      <Cifra label="Sin evaluar" valor={sinEvaluar.length} sub="pendientes de datos o sin registros" tono="text-slate-500" />
    </div>
    <div className="grid gap-4 lg:grid-cols-2"><EquiposBarra kpis={kpis} /><GraficoCumplimiento kpis={kpis} /></div>

    <section className="overflow-hidden rounded-xl border bg-white" aria-labelledby="t-evaluados">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-4">
        <h3 id="t-evaluados" className="text-sm font-semibold text-[#002855]">Indicadores evaluados ({evaluados.length})</h3>
        {onSelect && <p className="text-xs text-slate-500">Seleccione una fila para ver el detalle por registro y proponer correcciones.</p>}
      </div>
      {!evaluados.length ? <p className="p-6 text-center text-sm text-slate-500">Ningún indicador tiene datos suficientes para evaluarse en este periodo.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-600"><tr>
            <th className="p-3">Equipo</th><th className="p-3">Indicador</th><th className="p-3 text-right">Resultado</th><th className="p-3">Meta</th>
            <th className="p-3">Estado</th><th className="p-3">Vs. anterior</th><th className="w-40 p-3">Tendencia</th><th className="p-3 text-right">Registros</th></tr></thead>
          <tbody>{EQUIPOS.flatMap(([id, label]) => evaluados.filter(k => k.equipo === id).map((k, i) =>
            <tr key={k.codigo} className={`${fila} ${onSelect ? 'cursor-pointer' : ''}`} onClick={onSelect ? () => onSelect(k) : undefined}
              onKeyDown={onSelect ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(k) } } : undefined}
              tabIndex={onSelect ? 0 : undefined} aria-label={onSelect ? `Ver ficha de ${k.nombre}` : undefined}>
              <td className="p-3 text-xs text-slate-500">{i === 0 ? label : ''}</td>
              <td className="p-3"><p className="font-semibold text-[#002855]">{k.nombre}</p><p className="text-xs text-slate-400">{k.codigo}{k.correcciones_pendientes ? ` · ${k.correcciones_pendientes} corrección(es) pendiente(s)` : ''}</p></td>
              <td className="p-3 text-right text-lg font-bold tabular-nums text-slate-900">{valorTxt(k.valor, k.unidad)}</td>
              <td className="p-3 text-xs text-slate-600">{metaTxt(k)}</td>
              <td className="p-3"><EstadoBadge estado={k.estado} /></td>
              <td className="p-3 text-xs"><Variacion k={k} /></td>
              <td className="p-2"><Tendencia kpi={k} alto={36} /></td>
              <td className="p-3 text-right text-xs text-slate-500 tabular-nums">{k.n != null ? `${k.n_con_dato}/${k.n}` : "—"}</td>
            </tr>))}</tbody></table></div>}
    </section>

    {sinEvaluar.length > 0 && <section className="rounded-xl border bg-white">
      <button type="button" onClick={() => setVerPendientes(v => !v)} aria-expanded={verPendientes} className="flex w-full items-center justify-between gap-2 p-4 text-left">
        <span className="text-sm font-semibold text-[#002855]">Sin evaluar ({sinEvaluar.length}): pendientes de datos, sin registros o con cobertura insuficiente</span>
        {verPendientes ? <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden /> : <ChevronRight className="h-4 w-4 text-slate-500" aria-hidden />}
      </button>
      {verPendientes && <ul className="divide-y border-t">{sinEvaluar.map(k => <li key={k.codigo}>
        <button type="button" disabled={!onSelect} onClick={onSelect ? () => onSelect(k) : undefined} className="flex w-full flex-wrap items-start justify-between gap-2 p-3 text-left enabled:hover:bg-slate-50">
          <span className="min-w-0"><span className="font-semibold text-slate-700">{k.nombre}</span> <span className="text-xs text-slate-400">· {EQUIPOS.find(e => e[0] === k.equipo)?.[1]} · {k.codigo}</span>
            <span className="block text-xs text-slate-500">{estadoNota(k)}</span></span>
          <span className="flex items-center gap-2">{k.estado === 'DATOS_INSUFICIENTES' && k.valor != null && <span className="text-xs text-slate-400">{valorTxt(k.valor, k.unidad)} referencial</span>}<EstadoBadge estado={k.estado} /></span>
        </button></li>)}</ul>}
    </section>}
    <p className="text-xs text-slate-400">Estados sin evaluar en gris: {estadoInfo('PENDIENTE_DATOS').label.toLowerCase()}, sin registros o datos insuficientes no se cuentan como cumplidos ni como fallidos.</p>
  </div>
}
