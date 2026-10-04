'use client'

import { Suspense, useState, type FormEvent } from 'react'
import { CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis, LabelList } from 'recharts'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'
import { fecha, fleetApi, fmt, mes, pct, soles } from '@/lib/fleet/api'
import { CLASE_LABEL, type FeEquipo } from '@/lib/fleet/types'
import { LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { Note, Panel, RecPill, useFeFilters, useFeQuery } from '@/components/fleet/ui'

// Montacargas y equipos de elevación: horas de uso (horómetro) frente al costo propio por hora (mantenimiento + pérdida de
// valor + costo de capital) comparado con el alquiler, y registro de la lectura mensual del horómetro.

const C_MC = '#2a78d6'
const C_EL = '#eb6834'
const short = (s: string) => s.replace('SCISSOR LIFT ', 'Plataforma ').replace(' MANTALL XE 140', '').replace('UN FORKLIFT ', 'UN ').replace('APILADOR BT REFLEX', 'Apilador BT')

function Lectura({ equipos, onSaved }: { equipos: FeEquipo[]; onSaved: () => void }) {
  const [code, setCode] = useState(equipos[0]?.code ?? '')
  const [f, setF] = useState(new Date().toISOString().slice(0, 10))
  const [h, setH] = useState('')
  const [saving, setSaving] = useState(false)
  const sel = equipos.find(e => e.code === code)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = Number(h)
    if (!code || !h || !isFinite(n) || n < 0) { toast.error('Indique el equipo y una lectura válida'); return }
    if (sel?.horometro != null && n < sel.horometro) { toast.error(`La lectura es menor que la última registrada (${fmt(sel.horometro)} h)`); return }
    setSaving(true)
    try { await fleetApi.saveHours(code, f, n); toast.success(`Lectura registrada: ${short(code)} · ${fmt(n)} h`); setH(''); onSaved() }
    catch (err) { toast.error(err instanceof Error ? err.message : 'No se pudo registrar') }
    finally { setSaving(false) }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">Equipo
        <select value={code} onChange={e => setCode(e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2 text-sm">
          {equipos.map(e => <option key={e.code} value={e.code}>{e.code}</option>)}
        </select></label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">Fecha
        <input type="date" value={f} max={new Date().toISOString().slice(0, 10)} onChange={e => setF(e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2 text-sm" /></label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">Horómetro (h)
        <input type="number" min={0} step="0.1" value={h} onChange={e => setH(e.target.value)} placeholder={sel?.horometro != null ? `Última: ${fmt(sel.horometro)}` : ''} className="h-9 w-40 rounded-lg border border-slate-200 px-2 text-sm" /></label>
      <button type="submit" disabled={saving} className="h-9 rounded-lg bg-[#002855] px-4 text-sm font-bold text-white hover:bg-[#0b3d7a] disabled:opacity-50">{saving ? 'Guardando…' : 'Registrar lectura'}</button>
      {sel?.horometro_fecha && <span className="text-xs text-slate-500">Última lectura: {fmt(sel.horometro)} h el {fecha(sel.horometro_fecha)}</span>}
    </form>
  )
}

function Equipos() {
  const f = useFeFilters()
  const { hasAccess } = usePermissions()
  const { data: d, error, loading, reload } = useFeQuery(fleetApi.resumen, f)
  if (!d && loading) return <LoadingBlock label="Calculando equipos…" className="h-80" />
  if (error && !d) return <ErrorBlock message={error} onRetry={reload} />
  if (!d || !d.equipos.length) return <EmptyState title="Sin montacargas ni equipos de elevación">Cargue la historia de mantenimiento en Datos y parámetros.</EmptyState>
  const alq = d.alquiler_hora ?? 60
  const pts = (c: string) => d.equipos.filter(e => e.clase === c && e.horas_anio != null && e.costo_propio_hora != null)
    .map(e => ({ x: e.horas_anio, y: Math.round(Math.min(e.costo_propio_hora ?? 0, alq * 4) * 10) / 10, z: e.costo_propio_anual ?? 0, e,
      // etiqueta solo en los puntos que piden atención; el resto se ve al pasar el mouse y en la tabla
      name: (e.costo_propio_hora ?? 0) > alq || (e.horas_anio ?? 0) < (e.horas_equilibrio ?? 0) ? short(e.code) : '' }))
  const sinHoras = d.equipos.filter(e => e.horas_anio == null)
  return (
    <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
      <Panel title="Uso frente a costo propio por hora" hint={`Horas de uso por año según el horómetro. Costo propio = mantenimiento del periodo ${mes(d.desde)} → ${mes(d.hasta)} (repartido) + pérdida de valor + costo de capital, entre horas. Sobre la línea: alquilar a S/ ${fmt(alq)} por hora (+ IGV) sale más barato. Puntos sobre S/ ${fmt(alq * 4)} se dibujan en el borde.`}>
        <div className="h-[380px]">
          <ResponsiveContainer>
            <ScatterChart margin={{ left: 8, right: 90, top: 10, bottom: 20 }}>
              <CartesianGrid stroke="#eef2f7" />
              <XAxis type="number" dataKey="x" name="Horas por año" domain={[0, (max: number) => Math.ceil(max * 1.1 / 100) * 100]} tick={{ fontSize: 11, fill: '#64748b' }} label={{ value: 'Horas de uso por año', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#64748b' }} />
              <YAxis type="number" dataKey="y" name="S/ por hora" domain={[0, (max: number) => Math.max(alq * 1.3, Math.ceil(max / 20) * 20)]} tick={{ fontSize: 11, fill: '#64748b' }} label={{ value: 'S/ por hora (propio)', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#64748b' }} />
              <ReferenceLine y={alq} stroke="#e34948" strokeDasharray="5 4" label={{ value: `Alquiler S/ ${fmt(alq)}/h`, position: 'insideTopRight', fontSize: 11, fill: '#b91c1c' }} />
              <ZAxis range={[80, 80]} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ payload }) => {
                const e = payload?.[0]?.payload?.e as FeEquipo | undefined
                if (!e) return null
                return <div className="rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow"><b>{e.code}</b><br />{e.anio_fab} · {e.edad} años<br />{fmt(e.horas_anio)} h/año · propio S/ {fmt(e.costo_propio_hora, 1)} por hora<br />Mantenimiento {soles(e.costo_anual)}/año · propiedad {soles(e.propiedad_anual)}/año<br />Alquilar esas horas: {soles(e.alquiler_anual)}/año</div>
              }} />
              <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12 }} />
              <Scatter name="Montacarga" data={pts('MONTACARGA')} fill={C_MC}><LabelList dataKey="name" position="right" style={{ fontSize: 11, fill: '#334155' }} /></Scatter>
              <Scatter name="Elevación" data={pts('ELEVACION')} fill={C_EL}><LabelList dataKey="name" position="right" style={{ fontSize: 11, fill: '#334155' }} /></Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        {sinHoras.length > 0 && <Note>Sin horas suficientes para calcular el costo por hora: {sinHoras.map(e => short(e.code)).join(', ')}. Registre una lectura de horómetro cada mes.</Note>}
      </Panel>

      {hasAccess('flota-eficiencia-carga') && (
        <Panel title="Registrar lectura de horómetro" hint="Una lectura al mes por equipo basta para medir el uso real y el costo por hora.">
          <Lectura equipos={d.equipos} onSaved={() => { reload(); window.dispatchEvent(new Event('fe:updated')) }} />
        </Panel>
      )}

      <Panel title="Detalle por equipo" hint={`Propiedad anual = pérdida de valor del año + costo de capital (tasa ${pct(d.tasas?.[1])}) sobre el valor de reventa. "Propio conviene desde": horas por año a partir de las cuales tener el equipo cuesta menos que alquilarlo a S/ ${fmt(d.alquiler_hora ?? 60)} por hora. El operador no se incluye: se paga igual en ambos casos.`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1400px] text-sm [&_td.font-mono]:whitespace-nowrap">
            <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
              <th className="px-2 py-2">Equipo</th><th className="px-2 py-2 text-right">Edad</th><th className="px-2 py-2 text-right">Horas/año</th><th className="px-2 py-2 text-right">Lecturas</th>
              <th className="px-2 py-2 text-right">Mant. anual</th><th className="px-2 py-2 text-right">Propiedad anual</th><th className="px-2 py-2 text-right">S/ por hora propio</th>
              <th className="px-2 py-2 text-right">Alquilar esas horas</th><th className="px-2 py-2 text-right">Propio conviene desde</th><th className="px-2 py-2 text-right">% correctivo</th>
              <th className="px-2 py-2 text-right">Fallas</th><th className="px-2 py-2">Último gasto</th><th className="px-2 py-2">Decisión</th><th className="px-2 py-2">Motivos</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {d.equipos.map(e => (
                <tr key={e.code} className="align-top">
                  <td className="px-2 py-2 font-bold text-[#002855]">{e.code}<span className="block text-xs font-normal text-slate-500">{CLASE_LABEL[e.clase]}{e.anio_fab ? ` · ${e.anio_fab}` : ''}</span></td>
                  <td className="px-2 py-2 text-right font-mono">{e.edad ?? '—'}</td><td className="px-2 py-2 text-right font-mono">{fmt(e.horas_anio)}</td>
                  <td className="px-2 py-2 text-right font-mono">{e.lecturas ?? 0}</td><td className="px-2 py-2 text-right font-mono">{soles(e.costo_anual)}</td>
                  <td className="px-2 py-2 text-right font-mono">{soles(e.propiedad_anual)}{e.valor_ref && <span className="block text-[10px] font-sans text-amber-700">valor referencial</span>}</td>
                  <td className={`px-2 py-2 text-right font-mono font-bold ${(e.costo_propio_hora ?? 0) > (d.alquiler_hora ?? 60) ? 'text-red-700' : ''}`}>{fmt(e.costo_propio_hora, 1)}</td>
                  <td className="px-2 py-2 text-right font-mono">{soles(e.alquiler_anual)}</td>
                  <td className="px-2 py-2 text-right font-mono">{e.horas_equilibrio == null ? (e.costo_propio_hora != null ? 'nunca' : '—') : `${fmt(e.horas_equilibrio)} h/año`}</td>
                  <td className="px-2 py-2 text-right font-mono">{pct(e.corr_pct)}</td><td className="px-2 py-2 text-right font-mono">{e.fallas ?? 0}</td>
                  <td className="px-2 py-2 font-mono text-xs">{mes(e.ult_registro)}</td><td className="px-2 py-2"><RecPill rec={e.rec} /></td>
                  <td className="px-2 py-2 text-xs text-slate-600">{e.motivos.length ? e.motivos.join(' · ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

export default function EquiposPage() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><Equipos /></Suspense>
}
