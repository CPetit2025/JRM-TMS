'use client'
import { DataTable } from '@/components/ui/data-table'

import { Suspense, useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Clock, Hourglass, Route, Users } from 'lucide-react'
import { fleetApi, fmt, mes, pct, soles } from '@/lib/fleet/api'
import { KpiCard, LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { Note, Panel, useFeFilters, useFeQuery } from '@/components/fleet/ui'

// Rutas y carga: toneladas y viajes por mes (incluye meses sin registro), por unidad y por tipo de actividad;
// productividad (horas, espera, viajes no programados) y costo por cliente y distrito (costo estimado de cada viaje).

const ACT: Record<string, string> = {
  'DESPACHO DE CONTRATOS': 'Despacho de contratos', 'TRASLADO INTERNO DE JRM': 'Traslado interno JRM', 'ENVIO O RECOJO DE SERVICIOS': 'Envío o recojo de servicios',
  'RECOJO DE ORDENES DE COMPRA': 'Recojo de órdenes de compra', 'SIN PROGRAMACION': 'Sin programación', 'ENVIO O RECOJO DE EQUIPOS DE MONTAJE': 'Equipos de montaje',
  'TRASLADO DE MAT. DEL CLIENTE': 'Material del cliente', 'MANTENIMIENTO': 'Mantenimiento', 'TRASLADO DE BOBINAS DE UNIMAR': 'Bobinas Unimar', 'DESPACHO TMS': 'Despachos del TMS',
}

function Bars({ items, unit }: { items: Array<{ l: string; v: number; sub?: string }>; unit: string }) {
  const max = Math.max(1, ...items.map(i => i.v))
  return (
    <div className="space-y-2">
      {items.map(i => (
        <div key={i.l} className="grid grid-cols-[minmax(120px,190px)_1fr_80px] items-center gap-2 text-sm">
          <span className="truncate" title={i.l}>{i.l}{i.sub && <span className="block text-xs text-slate-500">{i.sub}</span>}</span>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#2a78d6]" style={{ width: `${i.v / max * 100}%` }} /></div>
          <span className="text-right font-mono text-xs text-slate-600">{fmt(i.v)} {unit}</span>
        </div>
      ))}
    </div>
  )
}

function Rutas() {
  const f = useFeFilters()
  const { data: d, error, loading, reload } = useFeQuery(fleetApi.rutas, f)
  const serie = useMemo(() => {
    if (!d) return []
    const out: Array<{ mes: string; label: string; ton: number | null; viajes: number | null }> = []
    const [y0, m0] = d.desde.split('-').map(Number); const [y1, m1] = d.hasta.split('-').map(Number)
    for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, m = 1) : m++) {
      const key = `${y}-${String(m).padStart(2, '0')}-01`
      const r = d.mensual.find(x => x.mes === key)
      out.push({ mes: key, label: mes(key), ton: r?.ton ?? null, viajes: r?.viajes ?? null })
    }
    while (out.length && out[out.length - 1].viajes == null) out.pop()
    return out
  }, [d])
  if (!d && loading) return <LoadingBlock label="Calculando rutas…" className="h-80" />
  if (error && !d) return <ErrorBlock message={error} onRetry={reload} />
  if (!d || !d.mensual.length) return <EmptyState title="Sin viajes en el periodo">Cargue las rutas en Datos y parámetros o registre despachos en el TMS.</EmptyState>
  const vacios = serie.filter(s => s.viajes == null).map(s => s.label)
  const p = d.productividad
  return (
    <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
      {p && p.viajes > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Horas por viaje" value={`${fmt(p.horas_viaje, 1)} h`} hint={`${fmt(p.con_horas)} de ${fmt(p.viajes)} viajes con tiempo registrado`} icon={<Clock className="h-4 w-4" />} />
          <KpiCard label="Espera en el cliente" value={`${pct(p.espera_pct)} del tiempo`} hint={`${fmt(p.espera_viaje, 1)} h por viaje · cuesta ${soles(p.espera_costo)} en conductor y ayudantes`} icon={<Hourglass className="h-4 w-4" />} />
          <KpiCard label="Viajes no programados" value={fmt(p.no_programados)} hint={p.programado_dato ? `${pct(p.no_programados / p.programado_dato)} de los viajes con dato` : 'Sin dato'} icon={<Route className="h-4 w-4" />} />
          <KpiCard label="Costo estimado de los viajes" value={soles(p.costo_total)} hint={`${fmt(p.clientes)} clientes · ${fmt(p.distritos)} distritos`} icon={<Users className="h-4 w-4" />} />
        </div>
      )}
      <Panel title="Toneladas por mes" hint="Historia hasta el corte de rutas; después, despachos del TMS con el peso de sus guías">
        <div className="h-[260px]">
          <ResponsiveContainer>
            <BarChart data={serie} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#eef2f7" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748b' }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={v => fmt(v)} />
              <Tooltip formatter={(v) => [`${fmt(Number(v))} t`, 'Toneladas']} labelFormatter={l => `${l}`} />
              <Bar dataKey="ton" fill="#2a78d6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {vacios.length > 0 && <Note>Meses sin registros de rutas: {vacios.join(', ')}. No entran en los costos por tonelada.</Note>}
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Toneladas por unidad">
          <Bars unit="t" items={d.unidades.map(u => ({ l: u.code, sub: `${u.tipo ?? ''} · ${fmt(u.kg_viaje)} kg/viaje · ${pct(u.m3)} vol.`, v: u.ton ?? 0 }))} />
          {d.unidades.some(u => u.sin_peso > 0) && <p className="mt-3 text-xs text-slate-500">Viajes sin peso: {d.unidades.filter(u => u.sin_peso > 0).map(u => `${u.code} ${u.sin_peso}`).join(' · ')}.</p>}
        </Panel>
        <Panel title="Viajes por tipo de actividad">
          <Bars unit="" items={d.actividad.map(a => ({ l: ACT[a.t] ?? a.t.charAt(0) + a.t.slice(1).toLowerCase(), v: a.viajes, sub: a.ton != null ? `${fmt(a.ton)} t` : undefined }))} />
        </Panel>
      </div>
      {d.clientes?.length > 0 && (
        <Panel title="Costo por cliente" hint={`Costo estimado de cada viaje: km × costo por km de la unidad (combustible a precio constante + mantenimiento) + horas × (conductor S/ ${fmt(p?.conductor_hora, 2)}/h + ayudantes S/ ${fmt(p?.ayudante_hora, 2)}/h). Historia de rutas del periodo; compárelo con la tarifa del cliente.`}>
          <div className="overflow-x-auto">
            <DataTable className="w-full min-w-[960px] text-sm">
              <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
                <th className="px-2 py-2">Cliente</th><th className="px-2 py-2 text-right">Viajes</th><th className="px-2 py-2 text-right">Toneladas</th><th className="px-2 py-2 text-right">Km/viaje</th>
                <th className="px-2 py-2 text-right">Costo</th><th className="px-2 py-2 text-right">S/ por viaje</th><th className="px-2 py-2 text-right">S/ por t</th>
                <th className="px-2 py-2 text-right">Espera total</th><th className="px-2 py-2 text-right">Espera/viaje</th><th className="px-2 py-2 text-right">No programados</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {d.clientes.map(c => (
                  <tr key={c.nombre}><td className="max-w-[260px] truncate px-2 py-2 font-semibold text-slate-800" title={c.nombre}>{c.nombre}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(c.viajes)}</td><td className="px-2 py-2 text-right font-mono">{fmt(c.ton, 1)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(c.km_viaje)}</td><td className="px-2 py-2 text-right font-mono font-bold">{soles(c.costo)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(c.costo_viaje)}</td><td className="px-2 py-2 text-right font-mono">{fmt(c.costo_t, 1)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(c.espera_h)} h</td>
                    <td className={`px-2 py-2 text-right font-mono ${(c.espera_viaje ?? 0) >= 1.5 ? 'font-bold text-amber-700' : ''}`}>{fmt(c.espera_viaje, 1)} h</td>
                    <td className="px-2 py-2 text-right font-mono">{c.no_programados || '—'}</td></tr>
                ))}
              </tbody>
            </DataTable>
          </div>
          <p className="mt-2 text-xs text-slate-500">Los 25 clientes de mayor costo. Los envíos a JRM se agrupan como traslado interno. Espera de 1,5 h o más por viaje en ámbar.</p>
        </Panel>
      )}
      {d.distritos?.length > 0 && (
        <Panel title="Costo por distrito de destino" hint="Mismo costo estimado por viaje, agrupado por distrito">
          <Bars unit="" items={d.distritos.map(x => ({ l: x.nombre, v: x.costo ?? 0, sub: `${fmt(x.viajes)} viajes · ${fmt(x.km_viaje)} km · S/ ${fmt(x.costo_t)}/t` }))} />
          <p className="mt-2 text-xs text-slate-500">Barras en S/.</p>
        </Panel>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Tipo de descarga"><Bars unit="" items={Object.entries(d.descarga).sort((a, b) => b[1] - a[1]).map(([l, v]) => ({ l, v }))} /></Panel>
        <Panel title="Destinos (provincia)"><Bars unit="" items={d.provincias.map(p => ({ l: p.provincia, v: p.viajes }))} /></Panel>
        <Panel title="Espera en el cliente"><p className="font-mono text-3xl font-bold text-slate-800">{d.espera_mediana != null ? `${fmt(d.espera_mediana * 60)} min` : '—'}</p><p className="mt-1 text-xs text-slate-500">Mediana del tiempo de espera por viaje (historia)</p></Panel>
      </div>
    </div>
  )
}

export default function RutasPage() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><Rutas /></Suspense>
}
