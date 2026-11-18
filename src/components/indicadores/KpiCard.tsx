'use client'

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertCircle, CheckCircle2, CircleDashed, MinusCircle, XCircle } from 'lucide-react'
import type { KpiResultado, PuntoTendencia } from '@/lib/indicadores/api'
import { EQUIPOS, estadoInfo, estadoNota, metaTxt, num, valorTxt } from '@/lib/indicadores/format'

const ICONO = { CUMPLE: CheckCircle2, ALERTA: AlertCircle, NO_CUMPLE: XCircle } as const

export function EstadoBadge({ estado }: { estado: string }) {
  const e = estadoInfo(estado)
  const Icon = ICONO[estado as keyof typeof ICONO] || (estado === 'SIN_REGISTROS' ? MinusCircle : CircleDashed)
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${e.badge}`}><Icon className="h-3.5 w-3.5" aria-hidden />{e.label}</span>
}

function TipTendencia({ active, payload, unidad }: { active?: boolean; payload?: Array<{ payload: PuntoTendencia }>; unidad: string }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return <div className="rounded-lg border bg-white px-3 py-2 text-xs shadow"><p className="font-semibold text-slate-700">{p.etiqueta}</p><p className="text-slate-900">{valorTxt(p.valor, unidad)}</p><p className="text-slate-500">{estadoInfo(p.estado).label}</p></div>
}

/** Tendencia de un KPI: una serie (sin leyenda); el punto toma el color del estado y el tooltip lo nombra. */
export function Tendencia({ kpi, alto = 48, ejes = false }: { kpi: Pick<KpiResultado, 'tendencia' | 'unidad' | 'meta'>; alto?: number; ejes?: boolean }) {
  const datos = [...(kpi.tendencia || [])].sort((a, b) => a.desde.localeCompare(b.desde))
  if (datos.filter(d => d.valor != null).length < 2) return <p className="flex items-center text-xs text-slate-400" style={{ height: alto }}>Sin historia suficiente para tendencia</p>
  return (
    <div style={{ height: alto }} className="w-full" role="img" aria-label={`Tendencia: ${datos.map(d => `${d.etiqueta} ${valorTxt(d.valor, kpi.unidad)}`).join('; ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={datos} margin={ejes ? { top: 8, right: 12, bottom: 0, left: 0 } : { top: 6, right: 6, bottom: 6, left: 6 }}>
          {ejes && <CartesianGrid stroke="#e2e8f0" vertical={false} />}
          {ejes && <XAxis dataKey="etiqueta" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />}
          <YAxis hide={!ejes} domain={['auto', 'auto']} tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={44} tickFormatter={v => num(v)} />
          {kpi.meta != null && <ReferenceLine y={kpi.meta} stroke="#94a3b8" strokeDasharray="4 4" label={ejes ? { value: 'Meta', fontSize: 11, fill: '#64748b', position: 'insideTopRight' } : undefined} />}
          <Tooltip content={<TipTendencia unidad={kpi.unidad} />} cursor={{ stroke: '#cbd5e1' }} />
          <Line type="monotone" dataKey="valor" stroke="#002855" strokeWidth={2} connectNulls isAnimationActive={false}
            dot={(p: { cx?: number; cy?: number; payload?: PuntoTendencia; index?: number }) => p.cx == null || p.cy == null || p.payload?.valor == null ? <g key={p.index} /> :
              <circle key={p.index} cx={p.cx} cy={p.cy} r={ejes ? 4 : 3} fill={estadoInfo(p.payload.estado).dot} stroke="#fff" strokeWidth={2} />} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function KpiCard({ kpi, onClick }: { kpi: KpiResultado; onClick?: () => void }) {
  const e = estadoInfo(kpi.estado)
  const nota = estadoNota(kpi)
  const contenido = <>
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-sm font-semibold leading-snug text-[#002855]">{kpi.nombre}</h3>
      <EstadoBadge estado={kpi.estado} />
    </div>
    <div className="mt-2 flex items-baseline gap-2">
      {/* En estados no evaluados el valor (si existe) es solo referencial y va en gris. */}
      <span className={`text-3xl font-extrabold ${e.evaluado ? 'text-slate-900' : 'text-slate-400'}`}>{kpi.estado === 'PENDIENTE_DATOS' ? '—' : valorTxt(kpi.valor, kpi.unidad)}</span>
      {kpi.estado === 'DATOS_INSUFICIENTES' && kpi.valor != null && <span className="text-xs text-slate-400">referencial</span>}
    </div>
    <p className="mt-1 text-xs text-slate-500">Meta {metaTxt(kpi)}{kpi.cobertura != null && <> · Cobertura {num(kpi.cobertura)} %</>}{kpi.n > 0 && <> · {kpi.n_con_dato}/{kpi.n} registros</>}</p>
    {nota && <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-600">{nota}</p>}
    <div className="mt-2"><Tendencia kpi={kpi} /></div>
    {!!kpi.correcciones_pendientes && <p className="mt-2 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{kpi.correcciones_pendientes} corrección(es) pendiente(s)</p>}
  </>
  const clase = 'block w-full min-w-0 rounded-xl border bg-white p-4 text-left'
  return onClick
    ? <button type="button" onClick={onClick} className={`${clase} transition hover:border-[#002855] hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#002855]`} aria-label={`Ver ficha de ${kpi.nombre}`}>{contenido}</button>
    : <div className={clase}>{contenido}</div>
}

/** Tarjetas agrupadas por equipo; compartido por el tablero interno y la página pública. */
export function ResumenEquipos({ kpis, onSelect }: { kpis: KpiResultado[]; onSelect?: (k: KpiResultado) => void }) {
  if (!kpis.length) return <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">No hay indicadores para esta frecuencia.</p>
  return <div className="space-y-6">{EQUIPOS.map(([id, label]) => {
    const grupo = kpis.filter(k => k.equipo === id)
    if (!grupo.length) return null
    const evaluados = grupo.filter(k => estadoInfo(k.estado).evaluado)
    return <section key={id} aria-labelledby={`eq-${id}`} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id={`eq-${id}`} className="text-lg font-bold text-[#002855]">{label}</h2>
        <p className="text-xs text-slate-500">{evaluados.filter(k => k.estado === 'CUMPLE').length} de {evaluados.length} evaluados cumplen · {grupo.length - evaluados.length} sin evaluar</p></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{grupo.map(k => <KpiCard key={k.codigo} kpi={k} onClick={onSelect ? () => onSelect(k) : undefined} />)}</div>
    </section>
  })}</div>
}
