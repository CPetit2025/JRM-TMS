"use client"
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, Database, Gauge, Loader2, ShieldAlert, Wrench } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmt, soles } from '@/lib/fleet/api'
import { PresupuestoAnual } from '@/components/mantenimiento/PresupuestoAnual'

// Planificación de mantenimiento (migración 20261005100000): una sola pantalla con el historial único (Excel + OT + Caja).
// Resumen de 12 meses, preventivo de los próximos 90 días, plan correctivo por frecuencia real de fallas, presupuesto
// anual y calidad de datos. Todo sale de mant_planificacion / mant_plan_anual (misma base de cálculo).

type Prox = { plate: string; familia: string; lectura: 'KM' | 'HORAS' | 'CALENDARIO'; servicio: string; fecha: string; dias: number; vencido: boolean
  lectura_obj: number | null; lectura_actual: number | null; costo: number; tareas: string[]; sistema: string | null; plan_id: string | null; plan_activo: boolean | null }
type Sist = { sistema: string; nombre: string; eventos: number; costo: number; ultima: string; mtbf_dias: number | null; proxima: string | null
  estado: 'ESPERADA' | 'PROXIMA' | 'VIGILAR' | 'AISLADA'; inspeccion_dias: number | null; tiene_inspeccion: boolean; recomendacion: string }
type Corr = { plate: string; familia: string; correctivo_24m: number; eventos_24m: number; pct_correctivo_12m: number | null; mtbf_dias: number | null
  fallas_abiertas: number | null; riesgo: number; nivel: 'ALTO' | 'MEDIO' | 'BAJO'; reserva: number; sistemas: Sist[] }
type Cal = { codigo: string; nivel: 'crit' | 'warn'; titulo: string; detalle: string; cantidad: number; items?: Array<string | Record<string, unknown>> }
type Resumen = { desde: string; hasta: string; historial_hasta: string | null; total: number; preventivo: number; correctivo: number; pct_correctivo: number | null
  eventos_correctivos: number; fuentes: { excel: number; ot: number; caja: number }; meta_correctivo: number; umbral: number; unidades: number
  por_sistema: Array<{ sistema: string; nombre: string | null; correctivo: number; total: number }>
  por_unidad: Array<{ plate: string; familia: string; correctivo: number; total: number; pct: number | null }>
  por_mes: Array<{ mes: string; preventivo: number; correctivo: number }>
  planes: { activos: number; por_validar: number } | null; vencidos: number; proximos_30: number; presupuesto_90: number }
type Data = { success: boolean; error?: string; hoy: string; resumen: Resumen; proximos: Prox[]; correctivo: Corr[]; calidad: Cal[] }

const TABS = [['resumen', 'Resumen', Gauge], ['preventivo', 'Preventivo', CalendarClock], ['correctivo', 'Correctivo', Wrench],
  ['presupuesto', 'Presupuesto anual', ClipboardCheck], ['calidad', 'Calidad de datos', Database]] as const
type Tab = (typeof TABS)[number][0]
const PREV = '#1d4ed8'
const CORR = '#cf152d'
const fecha = (v: string | null) => (v ? new Date(`${v}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const mesCorto = (ym: string) => new Date(`${ym}-15T12:00:00`).toLocaleDateString('es-PE', { month: 'short' })

export default function PlanificacionPage() {
  const supabase = useMemo(() => createClient(), [])
  const [tab, setTab] = useState<Tab>('resumen')
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const { data: r, error } = await supabase.rpc('mant_planificacion')
    setLoading(false)
    if (error || !r?.success) { toast.error(error?.message || r?.error || 'No se pudo cargar la planificación'); setData(null); return }
    setData(r)
  }, [supabase])
  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = new URLSearchParams(window.location.search).get('tab') as Tab | null
      if (q && TABS.some(([k]) => k === q)) setTab(q)
      void load()
    }, 0)
    return () => window.clearTimeout(t)
  }, [load])
  const go = (k: Tab) => { setTab(k); window.history.replaceState(null, '', `?tab=${k}`) }

  const r = data?.resumen
  const crit = data?.calidad.filter(c => c.nivel === 'crit').length || 0

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-slate-900">Planificación de mantenimiento</h1>
        <p className="text-sm text-slate-500">Qué toca hacer, qué puede fallar y cuánto cuesta, con el historial completo de cada unidad (Excel, OT y Caja).</p>
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map(([k, label, Icon]) => <button key={k} type="button" onClick={() => go(k)}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-[#002855] font-semibold text-[#002855]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
          <Icon className="h-4 w-4" />{label}
          {k === 'calidad' && crit > 0 && <span className="rounded-full bg-[#cf152d] px-1.5 text-[10px] font-bold text-white">{crit}</span>}
          {k === 'preventivo' && (r?.vencidos || 0) > 0 && <span className="rounded-full bg-[#cf152d] px-1.5 text-[10px] font-bold text-white">{r?.vencidos}</span>}
        </button>)}
      </div>

      {tab === 'presupuesto' ? <PresupuestoAnual /> : loading && !data ? <div className="flex justify-center p-16"><Loader2 className="h-7 w-7 animate-spin text-[#002855]" /></div>
        : !data || !r ? null
        : tab === 'resumen' ? <ResumenTab d={data} go={go} />
        : tab === 'preventivo' ? <PreventivoTab d={data} onDone={load} />
        : tab === 'correctivo' ? <CorrectivoTab d={data} onDone={load} />
        : <CalidadTab d={data} />}
    </div>
  )
}

// ---------------------------------------------------------------- Resumen
function ResumenTab({ d, go }: { d: Data; go: (t: Tab) => void }) {
  const r = d.resumen
  const alto = d.correctivo.filter(c => c.nivel === 'ALTO')
  const maxMes = Math.max(1, ...r.por_mes.map(m => m.preventivo + m.correctivo))
  const maxSis = Math.max(1, ...r.por_sistema.map(s => s.correctivo))
  return <div className="space-y-4">
    {r.historial_hasta && <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>Los indicadores usan el historial del Excel (hasta el {fecha(r.historial_hasta)}) más las OT y gastos de Caja registrados en el sistema
        ({r.fuentes.ot} OT y {r.fuentes.caja} gastos en 12 meses). Lo que no se registre en el sistema no aparece aquí.</span>
    </div>}

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi label="Gasto de los últimos 12 meses" value={soles(r.total)} sub={`Preventivo ${soles(r.preventivo)} · correctivo ${soles(r.correctivo)}`} />
      <Kpi label="Correctivo (12 meses)" value={r.pct_correctivo != null ? `${r.pct_correctivo} %` : '—'} sub={`Meta: menos de ${r.meta_correctivo} % · ${r.eventos_correctivos} reparaciones`}
        tone={(r.pct_correctivo ?? 0) > r.meta_correctivo ? 'bad' : 'ok'} />
      <Kpi label="Preventivos vencidos" value={fmt(r.vencidos)} sub={`${r.proximos_30} en los próximos 30 días`} tone={r.vencidos > 0 ? 'bad' : 'ok'} onClick={() => go('preventivo')} />
      <Kpi label="Unidades en riesgo alto" value={fmt(alto.length)} sub={alto.slice(0, 4).map(a => a.plate).join(', ') || 'Ninguna'} tone={alto.length ? 'bad' : 'ok'} onClick={() => go('correctivo')} />
    </div>

    {r.planes && r.planes.por_validar > 0 && <ActivarBanner porValidar={r.planes.por_validar} />}

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border bg-white p-4">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-slate-800">Gasto por mes</h2>
          <span className="flex gap-3 text-xs text-slate-500"><Leg c={PREV} t="Preventivo" /><Leg c={CORR} t="Correctivo" /></span></div>
        <div className="grid h-40 grid-cols-12 items-end gap-1.5">
          {r.por_mes.map(m => <div key={m.mes} className="flex h-full flex-col justify-end" title={`${m.mes}: preventivo ${soles(m.preventivo)} · correctivo ${soles(m.correctivo)}`}>
            <div className="flex h-full flex-col justify-end gap-[2px]">
              <span className="rounded-t" style={{ height: `${(m.correctivo / maxMes) * 100}%`, background: CORR }} />
              <span className="rounded-b" style={{ height: `${(m.preventivo / maxMes) * 100}%`, background: PREV }} />
            </div>
            <span className="mt-1 text-center text-[10px] text-slate-500">{mesCorto(m.mes)}</span>
          </div>)}
        </div>
      </section>
      <section className="rounded-xl border bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">Dónde está el correctivo (12 meses)</h2>
        <ul className="space-y-2">{r.por_sistema.filter(s => s.correctivo > 0).slice(0, 7).map(s => <li key={s.sistema} className="grid grid-cols-[10rem_1fr_6rem] items-center gap-2 text-sm">
          <span className="truncate text-slate-600">{s.nombre || s.sistema}</span>
          <span className="h-3 rounded" style={{ width: `${(s.correctivo / maxSis) * 100}%`, background: CORR }} />
          <span className="text-right font-semibold">{soles(s.correctivo)}</span>
        </li>)}</ul>
      </section>
    </div>

    <section className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-2">Unidad</th><th className="p-2 text-right">Gasto 12 meses</th><th className="p-2 text-right">Correctivo</th><th className="p-2 text-right">% correctivo</th><th className="p-2">Riesgo</th></tr></thead>
        <tbody>{r.por_unidad.map(u => {
          const c = d.correctivo.find(x => x.plate === u.plate)
          return <tr key={u.plate} className="border-t">
            <td className="p-2"><Link href={`/mantenimiento/flota/${encodeURIComponent(u.plate)}`} className="font-semibold text-[#002855] hover:underline">{u.plate}</Link><div className="text-[11px] text-slate-500">{u.familia}</div></td>
            <td className="p-2 text-right">{soles(u.total)}</td><td className="p-2 text-right">{soles(u.correctivo)}</td>
            <td className={`p-2 text-right font-semibold ${(u.pct ?? 0) > r.meta_correctivo ? 'text-[#cf152d]' : 'text-slate-700'}`}>{u.pct != null ? `${u.pct} %` : '—'}</td>
            <td className="p-2">{c && <Nivel n={c.nivel} />}</td>
          </tr>
        })}</tbody>
      </table>
    </section>
  </div>
}

// ---------------------------------------------------------------- Preventivo
function PreventivoTab({ d, onDone }: { d: Data; onDone: () => void }) {
  const [filtro, setFiltro] = useState<'todos' | 'vencidos' | '30'>('todos')
  const items = d.proximos.filter(p => filtro === 'todos' || (filtro === 'vencidos' ? p.vencido : p.dias <= 30))
  const r = d.resumen
  return <div className="space-y-4">
    {r.planes && r.planes.por_validar > 0 && <ActivarBanner porValidar={r.planes.por_validar} onDone={onDone} />}
    <div className="grid gap-3 sm:grid-cols-3">
      <Kpi label="Vencidos" value={fmt(r.vencidos)} sub="Hacer cuanto antes" tone={r.vencidos > 0 ? 'bad' : 'ok'} />
      <Kpi label="Próximos 30 días" value={fmt(r.proximos_30)} sub="Incluye vencidos" />
      <Kpi label="Costo estimado 90 días" value={soles(r.presupuesto_90)} sub="Costo de referencia del historial" />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex rounded-lg border bg-white p-1 text-sm">
        {([['todos', 'Próximos 90 días'], ['vencidos', 'Vencidos'], ['30', 'Próximos 30 días']] as const).map(([k, l]) =>
          <button key={k} type="button" onClick={() => setFiltro(k)} className={`rounded-md px-3 py-1 ${filtro === k ? 'bg-[#002855] font-semibold text-white' : 'text-slate-600'}`}>{l}</button>)}
      </div>
      <Link href="/mantenimiento/preventivos" className="text-sm font-semibold text-[#002855] hover:underline">Planes, lecturas y OT preventivas →</Link>
    </div>
    <section className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-2">Cuándo</th><th className="p-2">Unidad</th><th className="p-2">Servicio</th><th className="p-2">Al llegar a</th><th className="p-2">Qué incluye</th><th className="p-2 text-right">Costo ref.</th><th className="p-2">Plan</th></tr></thead>
        <tbody>{items.map((p, i) => <tr key={i} className={`border-t align-top ${p.vencido ? 'bg-red-50/50' : ''}`}>
          <td className="whitespace-nowrap p-2">{p.vencido ? <span className="font-bold text-[#cf152d]">Vencido</span> : <><b>{fecha(p.fecha)}</b><div className="text-[11px] text-slate-500">en {p.dias} días</div></>}</td>
          <td className="p-2"><Link href={`/mantenimiento/flota/${encodeURIComponent(p.plate)}`} className="font-semibold text-[#002855] hover:underline">{p.plate}</Link><div className="text-[11px] text-slate-500">{p.familia}</div></td>
          <td className="p-2 font-semibold text-slate-800">{p.servicio}</td>
          <td className="whitespace-nowrap p-2 text-slate-700">{p.lectura_obj ? `${fmt(p.lectura_obj)} ${p.lectura === 'HORAS' ? 'h' : 'km'}` : 'Por fecha'}
            {p.lectura_actual != null && p.lectura_obj != null && <div className="text-[11px] text-slate-500">hoy {fmt(p.lectura_actual)}</div>}</td>
          <td className="max-w-md p-2 text-xs text-slate-600">{p.tareas.join(' · ')}</td>
          <td className="p-2 text-right">{soles(p.costo)}</td>
          <td className="p-2 text-xs">{p.plan_activo ? <span className="font-semibold text-emerald-700">Activo</span> : <span className="font-semibold text-amber-700">Por activar</span>}</td>
        </tr>)}</tbody>
      </table>
      {items.length === 0 && <p className="p-6 text-center text-sm text-slate-400">Nada pendiente en este filtro.</p>}
    </section>
    <p className="text-[11px] text-slate-500">La fecha sale de la última ejecución y del uso real de la unidad (km u horas por día): vence lo que ocurra primero. Con el plan activo, el programador diario genera la OT preventiva al vencer.</p>
  </div>
}

// ---------------------------------------------------------------- Correctivo
function CorrectivoTab({ d, onDone }: { d: Data; onDone: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const agregar = async (plate: string, s: Sist) => {
    if (!s.inspeccion_dias) return
    setBusy(plate + s.sistema)
    const { data, error } = await supabase.rpc('mant_agregar_inspeccion', { p_plate: plate, p_sistema: s.sistema, p_dias: s.inspeccion_dias,
      p_motivo: `Plan correctivo: ${s.eventos} fallas de ${s.nombre.toLowerCase()} en 24 meses` })
    setBusy(null)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(`Inspección agregada al plan preventivo de ${plate}`); onDone()
  }
  const reserva = d.correctivo.reduce((a, c) => a + (c.reserva || 0), 0)
  return <div className="space-y-4">
    <div className="rounded-xl border bg-white p-4 text-sm text-slate-600">
      <b className="text-slate-800">Cómo leer el plan correctivo.</b> Para cada unidad se miran las reparaciones de los últimos 24 meses por sistema.
      Si un sistema falla repetidamente, el tiempo promedio entre fallas indica cuándo es probable la siguiente: <b>Esperada</b> (ya pasó ese tiempo),
      <b> Próxima</b> (en 60 días) o <b>Vigilar</b>. Con 3 o más fallas se propone una inspección periódica para corregir antes de que falle.
      Reserva anual sugerida para correctivo: <b>{soles(reserva)}</b>.
    </div>
    <div className="grid gap-3 lg:grid-cols-2">
      {d.correctivo.map(c => <section key={c.plate} className={`rounded-xl border bg-white p-4 ${c.nivel === 'ALTO' ? 'border-red-200' : ''}`}>
        <div className="flex items-start justify-between gap-2">
          <div><Link href={`/mantenimiento/flota/${encodeURIComponent(c.plate)}`} className="text-base font-bold text-[#002855] hover:underline">{c.plate}</Link>
            <div className="text-xs text-slate-500">{c.familia}</div></div>
          <Nivel n={c.nivel} />
        </div>
        <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
          <div><dt className="text-slate-500">Correctivo 24m</dt><dd className="font-semibold">{soles(c.correctivo_24m)}</dd></div>
          <div><dt className="text-slate-500">% corr. 12m</dt><dd className="font-semibold">{c.pct_correctivo_12m != null ? `${c.pct_correctivo_12m} %` : '—'}</dd></div>
          <div><dt className="text-slate-500">Entre fallas</dt><dd className="font-semibold">{c.mtbf_dias != null ? `${c.mtbf_dias} días` : '—'}</dd></div>
          <div><dt className="text-slate-500">Fallas abiertas</dt><dd className="font-semibold">{c.fallas_abiertas ?? '—'}</dd></div>
        </dl>
        {c.sistemas.length === 0 ? <p className="mt-3 text-sm text-slate-400">Sin reparaciones en 24 meses.</p> :
          <ul className="mt-3 divide-y text-sm">{c.sistemas.filter(s => s.eventos >= 2).concat(c.sistemas.filter(s => s.eventos < 2).slice(0, 1)).map(s => <li key={s.sistema} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="min-w-0"><b className="text-slate-800">{s.nombre}</b> <span className="text-xs text-slate-500">· {s.eventos} falla{s.eventos > 1 ? 's' : ''} · {soles(s.costo)}{s.mtbf_dias ? ` · cada ${s.mtbf_dias} días` : ''}</span>
              <span className="block text-xs text-slate-600">{s.recomendacion}{s.proxima ? ` · próxima probable ${fecha(s.proxima)}` : ''}</span></span>
            <span className="flex items-center gap-2"><Estado e={s.estado} />
              {s.inspeccion_dias && (s.tiene_inspeccion ? <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />En el plan</span>
                : <button type="button" disabled={busy === c.plate + s.sistema} onClick={() => void agregar(c.plate, s)}
                    className="rounded-md bg-[#002855] px-2 py-1 text-xs font-semibold text-white disabled:opacity-60">Agregar inspección</button>)}
            </span>
          </li>)}</ul>}
      </section>)}
    </div>
  </div>
}

// ---------------------------------------------------------------- Calidad de datos
function CalidadTab({ d }: { d: Data }) {
  if (d.calidad.length === 0) return <div className="flex items-center gap-2 rounded-xl border bg-white p-6 text-emerald-700"><CheckCircle2 className="h-5 w-5" />Los datos están completos para planificar.</div>
  return <div className="space-y-3">
    <p className="text-sm text-slate-600">El plan es tan bueno como los datos. Esto es lo que falta para que sea exacto:</p>
    {d.calidad.map(c => <section key={c.codigo} className={`rounded-xl border bg-white p-4 ${c.nivel === 'crit' ? 'border-red-200' : 'border-amber-200'}`}>
      <h3 className="flex items-center gap-2 font-semibold text-slate-800">{c.nivel === 'crit' ? <ShieldAlert className="h-4 w-4 text-[#cf152d]" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}{c.titulo}
        <span className="rounded-full bg-slate-100 px-2 text-xs text-slate-600">{c.codigo === 'historial' ? `${c.cantidad} días` : c.cantidad}</span></h3>
      <p className="mt-1 text-sm text-slate-600">{c.detalle}</p>
      {c.items && c.items.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{c.items.slice(0, 30).map((it, i) => {
        const o = typeof it === 'string' ? { plate: it } : it as Record<string, unknown>
        const label = String(o.plate ?? o.descripcion ?? '') + (o.ultima ? ` · ${fecha(String(o.ultima))}` : o.ultima === null ? ' · nunca' : '') + (o.dias != null ? ` · ${o.dias} días` : '')
        return <span key={i} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{label}</span>
      })}</div>}
    </section>)}
  </div>
}

// ---------------------------------------------------------------- Comunes
function ActivarBanner({ porValidar, onDone }: { porValidar: number; onDone?: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [busy, setBusy] = useState(false)
  const activar = async () => {
    if (!confirm(`¿Activar los ${porValidar} planes con la última ejecución del historial?\n\nLos servicios vencidos generarán OT preventivas en borrador en la próxima corrida del programador (6:00). Si algún servicio ya se hizo después de junio, corríjalo antes en Presupuesto anual › Validar.`)) return
    setBusy(true)
    const { data, error } = await supabase.rpc('mant_activar_planes', { p_plate: null })
    setBusy(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(`${data.activados} planes activados`); onDone?.()
  }
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <span className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4 shrink-0" /><span><b>{porValidar} planes preventivos sin activar.</b> Sin activar, no se generan OT. Puede corregir la última ejecución por unidad en Presupuesto anual › Validar, o activarlos con el historial.</span></span>
    {onDone && <button type="button" disabled={busy} onClick={() => void activar()} className="flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-1.5 font-semibold text-white disabled:opacity-60">
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}Activar todos con el historial</button>}
  </div>
}

function Kpi({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad'; onClick?: () => void }) {
  const C = onClick ? 'button' : 'div'
  return <C type={onClick ? 'button' : undefined} onClick={onClick} className={`rounded-xl border bg-white px-4 py-3 text-left ${onClick ? 'hover:border-[#002855]' : ''}`}>
    <div className="text-xs text-slate-500">{label}</div>
    <div className={`text-xl font-bold ${tone === 'bad' ? 'text-[#cf152d]' : 'text-slate-900'}`}>{value}</div>
    {sub && <div className="truncate text-[11px] text-slate-400">{sub}</div>}
  </C>
}
function Leg({ c, t }: { c: string; t: string }) {
  return <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{t}</span>
}
function Nivel({ n }: { n: Corr['nivel'] }) {
  const cls = n === 'ALTO' ? 'bg-red-100 text-[#cf152d]' : n === 'MEDIO' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${cls}`}>Riesgo {n.toLowerCase()}</span>
}
function Estado({ e }: { e: Sist['estado'] }) {
  const m = { ESPERADA: ['Esperada', 'bg-red-100 text-[#cf152d]'], PROXIMA: ['Próxima', 'bg-amber-100 text-amber-800'], VIGILAR: ['Vigilar', 'bg-blue-50 text-blue-800'], AISLADA: ['Aislada', 'bg-slate-100 text-slate-600'] }[e]
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${m[1]}`}>{m[0]}</span>
}
