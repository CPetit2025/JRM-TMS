'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2 } from 'lucide-react'
import { fmt, soles } from '@/lib/fleet/api'

// Ficha Flota 360 › Gasto y plan: historial único de mantenimiento (Excel hasta su último registro + OT del sistema),
// gasto por año y por sistema, plan preventivo recomendado para la familia y turnos del operario (mant_historial).

type Item = { fecha: string; fuente: string; tipo: string; sistema: string; monto: number; detalle: string | null; proveedor: string | null; lectura: number | null; ref: string | null }
type Hist = {
  success: boolean; error?: string; corte_excel: string | null; familia: string | null; familia_nombre: string | null; total: number
  ultimos_12m: { monto: number; correctivo: number; pct_correctivo: number | null }
  por_anio: Array<{ anio: number; preventivo: number | null; correctivo: number | null; mejora: number | null }>
  por_sistema: Array<{ sistema: string; nombre: string | null; monto: number; correctivo: number; n: number }>
  items: Item[]
  plan: Array<{ servicio: string; km: number | null; horas: number | null; dias: number | null; tareas: string[]; fuente: string | null }>
  turnos: Array<{ fecha: string; tipo: string; horas: number | null; estado: string; fallas: number; observaciones: string | null; no_ok: string[] | null }>
}

const PREV = '#1d4ed8'
const CORR = '#cf152d'
const fecha = (v: string | null) => (v ? new Date(v.length <= 10 ? `${v}T12:00:00` : v).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const cada = (p: Hist['plan'][number]) => [p.km ? `${fmt(p.km)} km` : null, p.horas ? `${fmt(p.horas)} h` : null, p.dias ? `${p.dias} días` : null].filter(Boolean).join(' o ')

export function MantHistorialPanel({ plate }: { plate: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [h, setH] = useState<Hist | null>(null)
  const [todo, setTodo] = useState(false)
  useEffect(() => {
    let alive = true
    supabase.rpc('mant_historial', { p_plate: plate }).then(({ data, error }) => {
      if (alive) setH(error ? { success: false, error: error.message } as Hist : data)
    })
    return () => { alive = false }
  }, [plate, supabase])

  if (!h) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-[#002855]" /></div>
  if (!h.success) return <div className="rounded-xl border bg-white p-6 text-sm text-slate-500">{h.error === 'Sin acceso' ? 'Sin permiso para ver el gasto de mantenimiento.' : `No se pudo cargar: ${h.error}`}</div>

  const maxAnio = Math.max(1, ...h.por_anio.map(a => (a.preventivo || 0) + (a.correctivo || 0) + (a.mejora || 0)))
  const maxSis = Math.max(1, ...h.por_sistema.map(s => s.monto))
  const items = todo ? h.items : h.items.slice(0, 25)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label="Gasto registrado" value={soles(h.total)} sub={h.corte_excel ? `Excel hasta ${fecha(h.corte_excel)}, luego OT` : 'OT del sistema'} />
        <Kpi label="Últimos 12 meses" value={soles(h.ultimos_12m?.monto)} />
        <Kpi label="Correctivo (12 meses)" value={h.ultimos_12m?.pct_correctivo != null ? `${h.ultimos_12m.pct_correctivo} %` : '—'} sub="Meta: menos de 25 %"
          tone={(h.ultimos_12m?.pct_correctivo ?? 0) > 25 ? 'bad' : 'ok'} />
        <Kpi label="Familia del plan" value={h.familia_nombre || 'Sin asignar'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-white p-4">
          <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-800">Gasto por año</h3>
            <span className="flex gap-3 text-xs text-slate-500"><Leg color={PREV} t="Preventivo" /><Leg color={CORR} t="Correctivo" /></span></div>
          {h.por_anio.length === 0 ? <p className="text-sm text-slate-400">Sin gasto registrado</p> :
            <ul className="space-y-2">{h.por_anio.map(a => {
              const p = (a.preventivo || 0) + (a.mejora || 0), c = a.correctivo || 0
              return <li key={a.anio} className="grid grid-cols-[3rem_1fr_6rem] items-center gap-2 text-sm" title={`Preventivo ${soles(p)} · Correctivo ${soles(c)}`}>
                <span className="text-slate-500">{a.anio}</span>
                <span className="flex h-3 gap-[2px] overflow-hidden rounded">
                  <span style={{ width: `${(p / maxAnio) * 100}%`, background: PREV }} className="rounded-l" />
                  <span style={{ width: `${(c / maxAnio) * 100}%`, background: CORR }} className="rounded-r" />
                </span>
                <span className="text-right font-semibold text-slate-800">{soles(p + c)}</span>
              </li>
            })}</ul>}
        </section>

        <section className="rounded-xl border bg-white p-4">
          <h3 className="mb-3 font-semibold text-slate-800">Por sistema <span className="text-xs font-normal text-slate-500">(rojo: correctivo)</span></h3>
          <ul className="space-y-2">{h.por_sistema.slice(0, 9).map(s => (
            <li key={s.sistema} className="grid grid-cols-[9rem_1fr_6rem] items-center gap-2 text-sm" title={`${s.n} registros · correctivo ${soles(s.correctivo)}`}>
              <span className="truncate text-slate-600">{s.nombre || s.sistema}</span>
              <span className="flex h-3 gap-[2px] overflow-hidden rounded">
                <span style={{ width: `${((s.monto - s.correctivo) / maxSis) * 100}%`, background: PREV }} className="rounded-l" />
                <span style={{ width: `${(s.correctivo / maxSis) * 100}%`, background: CORR }} className="rounded-r" />
              </span>
              <span className="text-right font-semibold text-slate-800">{soles(s.monto)}</span>
            </li>))}</ul>
        </section>
      </div>

      <section className="rounded-xl border bg-white p-4">
        <h3 className="font-semibold text-slate-800">Plan preventivo recomendado</h3>
        {h.plan.length === 0 ? <p className="mt-2 text-sm text-slate-400">La unidad no tiene familia asignada.</p> :
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{h.plan.map(p => (
            <div key={p.servicio} className="rounded-lg border border-slate-200 p-3">
              <p className="font-semibold text-[#002855]">{p.servicio}</p>
              <p className="text-xs font-semibold text-slate-600">Cada {cada(p)} (lo que ocurra primero)</p>
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-slate-600">{p.tareas.map(t => <li key={t}>{t}</li>)}</ul>
              {p.fuente && <p className="mt-2 text-[11px] text-slate-400">{p.fuente}</p>}
            </div>))}</div>}
      </section>

      {h.turnos.length > 0 && <section className="rounded-xl border bg-white p-4">
        <h3 className="mb-2 font-semibold text-slate-800">Turnos del operario</h3>
        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="py-1">Fecha</th><th>Tipo</th><th>Horómetro</th><th>Checklist</th></tr></thead>
          <tbody>{h.turnos.map((t, i) => <tr key={i} className="border-t">
            <td className="py-1.5">{new Date(t.fecha).toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td>{t.tipo === 'SEMANAL' ? 'Semanal' : 'Turno'}</td>
            <td>{t.horas != null ? `${fmt(t.horas, 1)} h` : '—'}{t.estado === 'POR_VALIDAR' && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-bold text-amber-800">por validar</span>}</td>
            <td className={t.no_ok?.length ? 'text-[#cf152d]' : 'text-emerald-700'}>{t.no_ok?.length ? t.no_ok.join(', ') : 'Todo bien'}</td>
          </tr>)}</tbody></table>
      </section>}

      <section className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-2">Fecha</th><th className="p-2">Tipo</th><th className="p-2">Sistema</th><th className="p-2">Detalle</th><th className="p-2 text-right">Km/h</th><th className="p-2 text-right">Monto</th></tr></thead>
          <tbody>{items.map((x, i) => <tr key={i} className="border-t align-top">
            <td className="whitespace-nowrap p-2">{fecha(x.fecha)}<div className="text-[11px] text-slate-400">{x.fuente}</div></td>
            <td className="p-2"><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${x.tipo === 'CORRECTIVO' ? 'bg-red-50 text-[#cf152d]' : x.tipo === 'MEJORA' ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-blue-800'}`}>{x.tipo}</span></td>
            <td className="p-2 text-slate-600">{h.por_sistema.find(s => s.sistema === x.sistema)?.nombre || x.sistema}</td>
            <td className="max-w-md p-2 text-slate-700">{x.detalle || '—'}{x.proveedor && <div className="text-[11px] text-slate-400">{x.proveedor}</div>}</td>
            <td className="p-2 text-right text-slate-500">{x.lectura ? fmt(x.lectura) : '—'}</td>
            <td className="p-2 text-right font-semibold text-slate-800">{soles(x.monto, 2)}</td>
          </tr>)}</tbody>
        </table>
        {!todo && h.items.length > 25 && <button type="button" onClick={() => setTodo(true)} className="w-full border-t p-2 text-sm font-semibold text-[#002855] hover:bg-slate-50">Ver los {h.items.length} registros</button>}
      </section>
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' }) {
  return <div className="rounded-xl border bg-white px-4 py-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className={`text-lg font-bold ${tone === 'bad' ? 'text-[#cf152d]' : 'text-slate-900'}`}>{value}</div>
    {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
  </div>
}

function Leg({ color, t }: { color: string; t: string }) {
  return <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{t}</span>
}
