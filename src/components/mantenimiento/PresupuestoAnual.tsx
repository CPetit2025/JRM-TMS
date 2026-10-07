"use client"
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Loader2, Receipt, Wrench } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { fmt, soles } from '@/lib/fleet/api'

// Plan anual de mantenimiento (Fases 2 y 3, migración 20261004160000): servicios proyectados por mes según el uso real,
// presupuesto preventivo con costo del historial, reserva de correctivo, real del año e indicadores; validación de la
// línea base de los planes, gastos de Caja sin unidad y reparaciones mayores sin cotización.

type Serv = { servicio: string; fecha: string; costo: number; vencido: boolean }
type Unidad = {
  vehicle_id: string; plate: string; familia: string; familia_nombre: string; lectura: 'KM' | 'HORAS' | 'CALENDARIO'
  uso_anual: number | null; odometro: number | null; horometro: number | null
  meses: Array<{ mes: number; servicios: Serv[] }>; preventivo: number; vencidos: number; reserva_correctivo: number
  real: { preventivo: number; correctivo: number }; pct_correctivo_12m: number | null; mtbf_dias: number | null
  planes: { activos: number; por_validar: number; vencidos: number | null } | null
}
type Plan = {
  success: boolean; error?: string; anio: number; hoy: string; umbral: number; meta_correctivo: number; unidades: Unidad[]
  totales: { preventivo: number; reserva_correctivo: number; real_preventivo: number; real_correctivo: number; pct_correctivo_12m: number | null
    vencidos: number; cumplimiento_preventivo: number | null; servicios_evaluados: number; por_mes: Array<{ mes: number; preventivo: number; real: number }> }
  caja_sin_unidad: Array<{ id: string; fecha: string; tipo: string; descripcion: string | null; monto: number }>
  ot_mayores: Array<{ id: string; ot: string | null; plate: string | null; estado: string; descripcion: string | null; monto: number; cotizada: boolean }>
}
type PlanUnidad = { id: string; nombre: string; km: number | null; horas: number | null; dias: number | null; ultima_fecha: string | null
  ultima_km: number | null; ultima_horas: number | null; activo: boolean; origen: string | null; plantilla: boolean }

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic']
const PRESUP = '#1d4ed8'
const REAL = '#64748b'
const corto = (s: string) => s.replace('Servicio ', '').replace('Servicio', '').replace('Mensual', 'M').replace('Trimestral', 'T').replace('Anual', 'An')
  .replace('Caja y diferencial', 'Caja').replace('trimestral', 'Trim.').replace('anual', 'Anual').trim()

export function PresupuestoAnual() {
  const supabase = useMemo(() => createClient(), [])
  const hoy = new Date().getFullYear()
  const [anio, setAnio] = useState(hoy)
  const [data, setData] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(true)
  const [validar, setValidar] = useState<Unidad | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data: r, error } = await supabase.rpc('mant_plan_anual', { p_anio: anio })
    setLoading(false)
    if (error || !r?.success) { toast.error(error?.message || r?.error || 'No se pudo cargar el plan'); setData(null); return }
    setData(r)
  }, [supabase, anio])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const grupos = useMemo(() => {
    const g = new Map<string, Unidad[]>()
    data?.unidades.forEach(u => g.set(u.familia_nombre, [...(g.get(u.familia_nombre) || []), u]))
    return [...g.entries()]
  }, [data])
  const porValidar = data?.unidades.reduce((a, u) => a + (u.planes?.por_validar || 0), 0) || 0
  const t = data?.totales
  const maxMes = Math.max(1, ...(t?.por_mes || []).map(m => Math.max(m.preventivo, m.real)))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Presupuesto anual</h2>
          <p className="text-sm text-slate-500">Servicios preventivos proyectados con el uso real de cada unidad, presupuesto y control de lo gastado.</p>
        </div>
        <div className="flex rounded-lg border bg-white p-1 text-sm">
          {[hoy, hoy + 1].map(y => <button key={y} type="button" onClick={() => setAnio(y)}
            className={`rounded-md px-3 py-1.5 font-semibold ${anio === y ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{y}</button>)}
        </div>
      </div>

      {loading && !data ? <div className="flex justify-center p-16"><Loader2 className="h-7 w-7 animate-spin text-[#002855]" /></div> : !data || !t ? null : <>
        {porValidar > 0 && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <ClipboardCheck className="h-4 w-4" /><b>{porValidar} planes por validar.</b> Confirme la última ejecución de cada servicio (el historial termina en junio)
          para activarlos; desde ese momento el programador diario genera las OT preventivas al vencer.
        </div>}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label={`Presupuesto preventivo ${anio}`} value={soles(t.preventivo)} sub={anio === hoy ? 'Lo que resta del año y lo vencido' : 'Año completo'} />
          <Kpi label="Reserva para correctivo" value={soles(t.reserva_correctivo)} sub="Promedio anual de los últimos 24 meses" />
          <Kpi label="Correctivo (12 meses)" value={t.pct_correctivo_12m != null ? `${t.pct_correctivo_12m} %` : '—'} sub={`Meta: menos de ${data.meta_correctivo} %`}
            tone={(t.pct_correctivo_12m ?? 0) > data.meta_correctivo ? 'bad' : 'ok'} />
          <Kpi label="Preventivo a tiempo" value={t.cumplimiento_preventivo != null ? `${t.cumplimiento_preventivo} %` : '—'}
            sub={`${t.servicios_evaluados} cambios de aceite evaluados · meta 90 %`} tone={(t.cumplimiento_preventivo ?? 100) < 90 ? 'bad' : 'ok'} />
          <Kpi label={`Gastado en ${anio}`} value={soles(t.real_preventivo + t.real_correctivo)} sub={`Preventivo ${soles(t.real_preventivo)} · correctivo ${soles(t.real_correctivo)}`} />
          <Kpi label="Servicios vencidos" value={fmt(t.vencidos)} sub="Se programan en el mes actual" tone={t.vencidos > 0 ? 'bad' : 'ok'} />
          <Kpi label="Gastos de Caja sin unidad" value={fmt(data.caja_sin_unidad.length)} sub="Asignar para que sumen al historial" tone={data.caja_sin_unidad.length ? 'bad' : 'ok'} />
          <Kpi label={`Reparaciones > ${soles(data.umbral)}`} value={fmt(data.ot_mayores.length)} sub="OT correctivas abiertas" tone={data.ot_mayores.some(o => !o.cotizada) ? 'bad' : 'ok'} />
        </div>

        <section className="rounded-xl border bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-800">Presupuesto preventivo y gasto real por mes</h2>
            <span className="flex gap-3 text-xs text-slate-500"><Leg c={PRESUP} t="Presupuesto preventivo" /><Leg c={REAL} t="Gasto real (todo)" /></span>
          </div>
          <div className="grid h-40 grid-cols-12 items-end gap-2">
            {t.por_mes.map(m => <div key={m.mes} className="flex h-full flex-col justify-end" title={`${MESES[m.mes - 1]}: presupuesto ${soles(m.preventivo)} · real ${soles(m.real)}`}>
              <div className="flex h-full items-end justify-center gap-[2px]">
                <span className="w-1/2 max-w-5 rounded-t" style={{ height: `${(m.preventivo / maxMes) * 100}%`, background: PRESUP }} />
                <span className="w-1/2 max-w-5 rounded-t" style={{ height: `${(m.real / maxMes) * 100}%`, background: REAL }} />
              </div>
              <span className="mt-1 text-center text-[11px] text-slate-500">{MESES[m.mes - 1]}</span>
            </div>)}
          </div>
        </section>

        <section className="overflow-x-auto rounded-xl border bg-white">
          <DataTable className="w-full min-w-[1100px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr><th className="p-2 text-left">Unidad</th>{MESES.map(m => <th key={m} className="w-12 p-1 text-center">{m}</th>)}
                <th className="p-2 text-right">Preventivo</th><th className="p-2 text-right">Reserva corr.</th><th className="p-2 text-right">% corr. 12m</th><th className="p-2 text-right">MTBF</th><th className="p-2">Planes</th></tr>
            </thead>
            <tbody>
              {grupos.map(([fam, us]) => <FamRows key={fam} fam={fam} us={us} umbral={data.meta_correctivo} onValidar={setValidar} />)}
            </tbody>
          </DataTable>
          <p className="border-t p-2 text-[11px] text-slate-500">Cada celda muestra los servicios del mes (A, B, C; 250 h, 500 h…; M = mensual, T = trimestral, An = anual). En rojo, vencidos. Un servicio mayor reemplaza a los que incluye en el mismo mes. MTBF = días promedio entre correctivos.</p>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <CajaSinUnidad items={data.caja_sin_unidad} plates={data.unidades.map(u => u.plate)} onDone={load} />
          <section className="rounded-xl border bg-white p-4">
            <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800"><Wrench className="h-4 w-4 text-[#002855]" />Reparaciones mayores</h2>
            <p className="mb-3 text-xs text-slate-500">Una OT correctiva de más de {soles(data.umbral)} no se aprueba ni se inicia sin cotización aprobada. Antes de aprobarla, revise la decisión de Eficiencia de Flota de la unidad.</p>
            {data.ot_mayores.length === 0 ? <p className="text-sm text-slate-400">No hay OT correctivas abiertas sobre el umbral.</p> :
              <ul className="divide-y text-sm">{data.ot_mayores.map(o => <li key={o.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0"><b className="text-slate-800">{o.ot || 'OT'}</b> · {o.plate || '—'} · {o.estado}<span className="block truncate text-xs text-slate-500">{o.descripcion}</span></span>
                <span className="shrink-0 text-right"><b>{soles(o.monto)}</b><span className={`block text-[11px] font-semibold ${o.cotizada ? 'text-emerald-700' : 'text-[#cf152d]'}`}>{o.cotizada ? 'Cotización aprobada' : 'Sin cotización'}</span></span>
              </li>)}</ul>}
            <Link href="/mantenimiento/gestor-ot" className="mt-2 inline-block text-xs font-semibold text-[#002855] hover:underline">Ir a Órdenes de Trabajo</Link>
          </section>
        </div>
      </>}

      {validar && <ValidarPlanes unidad={validar} onClose={() => setValidar(null)} onSaved={() => { setValidar(null); void load() }} />}
    </div>
  )
}

function FamRows({ fam, us, umbral, onValidar }: { fam: string; us: Unidad[]; umbral: number; onValidar: (u: Unidad) => void }) {
  return <>
    <tr className="bg-slate-50/60"><td colSpan={18} className="px-2 py-1.5 text-xs font-bold uppercase tracking-wide text-[#002855]">{fam}</td></tr>
    {us.map(u => <tr key={u.vehicle_id} className="border-t align-top">
      <td className="p-2">
        <Link href={`/mantenimiento/flota/${encodeURIComponent(u.plate)}`} className="font-semibold text-[#002855] hover:underline">{u.plate}</Link>
        <div className="text-[11px] text-slate-500">{u.uso_anual ? `${fmt(u.uso_anual)} ${u.lectura === 'HORAS' ? 'h' : 'km'}/año` : u.lectura === 'CALENDARIO' ? 'Por calendario' : 'Uso sin dato'}</div>
      </td>
      {u.meses.map(m => <td key={m.mes} className="p-1 text-center">
        <div className="flex flex-col items-center gap-0.5">{m.servicios.map((s, i) => <span key={i} title={`${s.servicio} · ${s.fecha} · ${soles(s.costo)}${s.vencido ? ' · vencido' : ''}`}
          className={`rounded px-1 text-[10px] font-bold ${s.vencido ? 'bg-red-100 text-[#cf152d]' : 'bg-blue-50 text-blue-800'}`}>{corto(s.servicio)}</span>)}</div>
      </td>)}
      <td className="p-2 text-right font-semibold">{soles(u.preventivo)}</td>
      <td className="p-2 text-right text-slate-600">{soles(u.reserva_correctivo)}</td>
      <td className={`p-2 text-right font-semibold ${(u.pct_correctivo_12m ?? 0) > umbral ? 'text-[#cf152d]' : 'text-slate-700'}`}>{u.pct_correctivo_12m != null ? `${u.pct_correctivo_12m} %` : '—'}</td>
      <td className="p-2 text-right text-slate-600">{u.mtbf_dias != null ? `${u.mtbf_dias} d` : '—'}</td>
      <td className="p-2">
        {u.planes && u.planes.por_validar > 0 ? <button type="button" onClick={() => onValidar(u)} className="whitespace-nowrap rounded-md bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900 hover:bg-amber-200">Validar ({u.planes.por_validar})</button>
          : u.planes ? <button type="button" onClick={() => onValidar(u)} className="flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />{u.planes.activos} activos</button> : '—'}
      </td>
    </tr>)}
  </>
}

function ValidarPlanes({ unidad, onClose, onSaved }: { unidad: Unidad; onClose: () => void; onSaved: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [planes, setPlanes] = useState<PlanUnidad[] | null>(null)
  const [lect, setLect] = useState<{ odometro: number | null; horometro: number | null }>({ odometro: null, horometro: null })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    supabase.rpc('mant_planes_unidad', { p_plate: unidad.plate }).then(({ data, error }) => {
      if (error || !data?.success) { toast.error(error?.message || data?.error); setPlanes([]); return }
      setPlanes((data.planes as PlanUnidad[]).map(p => ({ ...p, activo: true })))
      setLect({ odometro: data.odometro, horometro: data.horometro })
    })
  }, [supabase, unidad.plate])
  const set = (id: string, k: keyof PlanUnidad, v: string | boolean) =>
    setPlanes(ps => ps?.map(p => p.id === id ? { ...p, [k]: typeof v === 'string' && k !== 'ultima_fecha' ? (v === '' ? null : Number(v)) : v } : p) || null)
  const guardar = async () => {
    if (!planes) return
    setSaving(true)
    const { data, error } = await supabase.rpc('mant_validar_planes', {
      p_plate: unidad.plate,
      p_items: planes.map(p => ({ id: p.id, fecha: p.ultima_fecha, km: p.km ? p.ultima_km : null, horas: p.horas ? p.ultima_horas : null, activo: p.activo })),
    })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo validar')
    toast.success(`${data.validados} planes validados`)
    onSaved()
  }
  const field = 'w-full rounded border px-2 py-1 text-sm text-slate-900'
  return (
    <Modal isOpen onClose={onClose} title={`Validar planes · ${unidad.plate}`} maxWidth="max-w-4xl">
      {!planes ? <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div> : <div className="space-y-3 text-sm">
        <p className="text-slate-600">Confirme la última vez que se hizo cada servicio. Los valores propuestos salen del historial; corríjalos si hubo servicios después de junio.
          Lectura actual: {lect.odometro ? `${fmt(lect.odometro)} km` : ''}{lect.horometro ? ` ${fmt(lect.horometro)} h` : ''}.</p>
        <div className="max-h-[60vh] overflow-y-auto">
          <DataTable className="w-full">
            <thead className="text-left text-xs text-slate-500"><tr><th className="p-1">Servicio</th><th className="p-1">Frecuencia</th><th className="p-1">Última fecha</th><th className="p-1">Última lectura</th><th className="p-1">Activar</th></tr></thead>
            <tbody>{planes.map(p => <tr key={p.id} className="border-t align-top">
              <td className="p-1"><b className="text-slate-800">{p.nombre}</b><div className="max-w-xs text-[11px] text-slate-500">{p.origen || 'Plan existente'}</div></td>
              <td className="p-1 text-xs text-slate-600">{[p.km && `${fmt(p.km)} km`, p.horas && `${fmt(p.horas)} h`, p.dias && `${p.dias} d`].filter(Boolean).join(' o ')}</td>
              <td className="p-1"><input type="date" className={field} value={p.ultima_fecha || ''} onChange={e => set(p.id, 'ultima_fecha', e.target.value)} /></td>
              <td className="p-1">{p.km ? <input type="number" className={field} value={p.ultima_km ?? ''} onChange={e => set(p.id, 'ultima_km', e.target.value)} placeholder="km" />
                : p.horas ? <input type="number" className={field} value={p.ultima_horas ?? ''} onChange={e => set(p.id, 'ultima_horas', e.target.value)} placeholder="h" /> : <span className="text-xs text-slate-400">Por calendario</span>}</td>
              <td className="p-1 text-center"><input type="checkbox" className="h-4 w-4 accent-[#002855]" checked={p.activo} onChange={e => set(p.id, 'activo', e.target.checked)} /></td>
            </tr>)}</tbody>
          </DataTable>
        </div>
        <div className="flex justify-end gap-2 border-t pt-3">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 font-semibold text-slate-600">Cancelar</button>
          <button type="button" disabled={saving} onClick={() => void guardar()} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-semibold text-white disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}Validar y activar</button>
        </div>
      </div>}
    </Modal>
  )
}

function CajaSinUnidad({ items, plates, onDone }: { items: Plan['caja_sin_unidad']; plates: string[]; onDone: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [sel, setSel] = useState<Record<string, string>>({})
  const asignar = async (id: string) => {
    if (!sel[id]) return toast.error('Elija la unidad')
    const { data, error } = await supabase.rpc('mant_asignar_gasto', { p_expense_id: id, p_plate: sel[id] })
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success('Gasto asignado a ' + sel[id]); onDone()
  }
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800"><Receipt className="h-4 w-4 text-[#002855]" />Gastos de mantenimiento de Caja sin unidad</h2>
      <p className="mb-3 text-xs text-slate-500">Repuestos y llantas pagados por Caja que no tienen placa: asígnelos para que sumen al historial y al costo de la unidad.</p>
      {items.length === 0 ? <p className="flex items-center gap-1 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />Todos los gastos de mantenimiento tienen unidad.</p> :
        <ul className="divide-y text-sm">{items.map(e => <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="min-w-0"><b>{soles(e.monto, 2)}</b> · {e.tipo} · {e.fecha}<span className="block truncate text-xs text-slate-500">{e.descripcion}</span></span>
          <span className="flex items-center gap-1">
            <select className="rounded border px-2 py-1 text-sm" value={sel[e.id] || ''} onChange={ev => setSel(s => ({ ...s, [e.id]: ev.target.value }))}>
              <option value="">Unidad…</option>{plates.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <button type="button" onClick={() => void asignar(e.id)} className="rounded bg-[#002855] px-2 py-1 text-xs font-semibold text-white">Asignar</button>
          </span>
        </li>)}</ul>}
      {items.length > 0 && <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-700"><AlertTriangle className="h-3 w-3" />Solo se asigna la placa; el gasto no cambia en Caja.</p>}
    </section>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' }) {
  return <div className="rounded-xl border bg-white px-4 py-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className={`text-xl font-bold ${tone === 'bad' ? 'text-[#cf152d]' : 'text-slate-900'}`}>{value}</div>
    {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
  </div>
}

function Leg({ c, t }: { c: string; t: string }) {
  return <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{t}</span>
}
