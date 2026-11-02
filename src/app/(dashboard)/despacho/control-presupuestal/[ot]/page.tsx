"use client"
import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { errorMessage, money } from '@/lib/caja'
import { ControlPresupuestalTabs } from '@/components/despacho/ControlPresupuestalTabs'
import { SavingsTable, exportSavingsCsv, type SavingsResult } from '@/components/despacho/ConsolidationSavings'

// Detalle financiero de una OT (budget_ot_detail): resumen, viajes, conceptos, alertas, ampliaciones e historial.
// Todo sale de los mismos movimientos que la partida; los viajes se liquidan y cierran en Torre de Control.

type Level = 'NORMAL' | 'ALERTA' | 'BLOQUEO' | 'EXCEDIDO' | 'SIN_PARTIDA'
type Trip = { dispatch_id: string; number: string; date: string | null; status: string; modalidad: string | null; plate: string | null; carrier: string | null
  origin: string | null; destination: string | null; guides: string | null; planned_pen: number; reserved_pen: number; consumed_pen: number; has_estimate: boolean
  closure: { ready: boolean; final: boolean; documentario: string; economico: string } | null }
type Extension = { id: string; amount_pen: number; reason: string; evidence: string | null; status: string; requested_by: string | null; requested_at: string
  decided_by: string | null; decided_at: string | null; decision_note: string | null }
type Detail = {
  contract: { id: string; code: string; client: string | null; status: string | null }
  settings: { budget_alert_pct: number; budget_cap_pct: number }
  position: { allocated_pen: number; own_allocated_pen: number; extensions_pen: number; reserved_pen: number; consumed_pen: number; used_pen: number
    used_pct: number | null; cap_pen: number; protected_pen: number; authorized_over_cap_pen: number; available_to_cap_pen: number; level: Level }
  trips: Trip[]; trips_total: number
  concepts: { concept: string; reserved_pen: number; consumed_pen: number; estimated_pen: number | null; count: number }[]
  series: { month: string; consumed_pen: number; cumulative_pen: number }[]
  extensions: Extension[]; can_request_extension: boolean; can_decide_extension: boolean
  timeline: { at: string; kind: string; title: string; detail: string | null; by: string | null; old?: number; new?: number }[]
}
type Pending = { kind: string; contract_id: string; dispatch_id: string | null; dispatch_number: string | null; cause: string; amount_pen: number; age_days: number | null; action: string }

const supabase = createClient()
const TABS = [['resumen', 'Resumen'], ['viajes', 'Viajes y costos'], ['conceptos', 'Por concepto'], ['alertas', 'Desviaciones y alertas'],
  ['autorizaciones', 'Autorizaciones'], ['ahorro', 'Ahorro por consolidación'], ['historial', 'Historial']] as const
type Tab = typeof TABS[number][0]
const LEVEL: Record<Level, string> = { NORMAL: 'Normal', ALERTA: 'Alerta', BLOQUEO: 'Sobre el tope', EXCEDIDO: 'Excedido', SIN_PARTIDA: 'Sin partida' }
const n = (v: number | null | undefined) => money(Number(v ?? 0))
const day = (v: string | null) => v ? v.slice(0, 10).split('-').reverse().join('/') : '—'

export default function OtDetailPage({ params }: { params: Promise<{ ot: string }> }) {
  const { ot } = use(params)
  const [data, setData] = useState<Detail | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [tab, setTab] = useState<Tab>('resumen')
  const [range, setRange] = useState({ from: '', to: '' })
  const [form, setForm] = useState({ amount: '', reason: '', evidence: '' })
  const [busy, setBusy] = useState(false)
  const [savings, setSavings] = useState<SavingsResult | null>(null)

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([
      supabase.rpc('budget_ot_detail', { p_contract_id: ot, p_from: range.from || null, p_to: range.to || null }),
      supabase.rpc('budget_pending'),
    ])
    if (d.error || !d.data?.success) { toast.error(d.error ? errorMessage(d.error) : d.data?.error); return }
    setData(d.data as Detail)
    setPending(p.data?.success ? (p.data.rows as Pending[]).filter(r => r.contract_id === (d.data as Detail).contract.id) : [])
  }, [ot, range])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  // Ahorro atribuido a la OT (sus servicios aprovechados): el período elegido o los últimos 12 meses
  useEffect(() => {
    if (tab !== 'ahorro') return
    const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    let alive = true
    void supabase.rpc('consolidation_savings', { p_from: range.from || day(new Date(Date.now() - 365 * 864e5)), p_to: range.to || day(new Date()), p_contract: ot })
      .then(({ data: s, error }) => { if (!alive) return; if (error || !s?.success) { toast.error(error ? errorMessage(error) : s?.error); return } setSavings(s as SavingsResult) })
    return () => { alive = false }
  }, [tab, ot, range])

  const call = async (rpc: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true)
    const { data: r, error } = await supabase.rpc(rpc, args)
    setBusy(false)
    if (error || !r?.success) { toast.error(error ? errorMessage(error) : r?.error); return false }
    toast.success(ok); void load(); return true
  }
  const decide = (e: Extension, action: 'APROBAR' | 'RECHAZAR') => {
    const note = window.prompt(action === 'APROBAR' ? 'Nota de aprobación (opcional)' : 'Motivo del rechazo') ?? null
    if (note === null) return
    void call('budget_extension_action', { p_id: e.id, p_action: action, p_note: note }, action === 'APROBAR' ? 'Ampliación aprobada' : 'Ampliación rechazada')
  }

  const p = data?.position
  const card = (label: string, value: string, hint?: string) => <div className="rounded-lg border border-slate-200 bg-white p-3">
    <p className="text-xs text-slate-500">{label}</p><p className="text-lg font-bold tabular-nums">{value}</p>{hint && <p className="text-[11px] text-slate-500">{hint}</p>}</div>
  const th = 'px-3 py-2 text-left text-xs uppercase text-slate-500'
  const maxSeries = Math.max(1, ...(data?.series || []).map(s => Number(s.cumulative_pen)))

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title={data ? `Control presupuestal · ${data.contract.code}` : 'Control presupuestal'}
        description={data ? `${data.contract.client || 'Sin cliente'} · análisis financiero de la partida de transporte de la OT` : 'Cargando…'}
        actions={<button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>} />
      <ControlPresupuestalTabs active="ot" ot={data?.contract.id} />
      {!data || !p ? <p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Cargando…</p> : <>
        <nav role="tablist" aria-label="Detalle de la OT" className="flex max-w-full gap-1 overflow-x-auto border-b border-slate-200">
          {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${tab === key ? 'border-[#002855] text-[#002855]' : 'border-transparent text-slate-500 hover:text-[#002855]'}`}>
            {label}{key === 'alertas' && pending.length ? ` (${pending.length})` : ''}</button>)}
        </nav>

        {(tab === 'viajes' || tab === 'conceptos' || tab === 'ahorro') && <div className="flex flex-wrap items-end gap-2 text-xs font-semibold text-slate-600">
          <label>Desde<input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
          <label>Fecha de corte<input type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
        </div>}

        {tab === 'resumen' && <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {card('Presupuesto vigente', `S/ ${n(p.allocated_pen)}`, Number(p.extensions_pen) ? `Incluye ampliaciones por S/ ${n(p.extensions_pen)}` : 'Partida original')}
            {card(`Tope operativo (${data.settings.budget_cap_pct} %)`, `S/ ${n(p.cap_pen)}`, `Margen protegido: S/ ${n(p.protected_pen)}`)}
            {card('Consumo', `S/ ${n(p.used_pen)}`, `${p.used_pct ?? '—'} % · ${LEVEL[p.level]}`)}
            {card('Disponible hasta el tope', `S/ ${n(p.available_to_cap_pen)}`, Number(p.authorized_over_cap_pen) ? `Incluye S/ ${n(p.authorized_over_cap_pen)} autorizados por Gerencia` : undefined)}
            {card('Ejecutado', `S/ ${n(p.consumed_pen)}`)}
            {card('Comprometido vigente', `S/ ${n(p.reserved_pen)}`)}
            {card('Viajes', String(data.trips_total))}
            {card('Pendientes', String(pending.length), pending.length ? 'Ver «Desviaciones y alertas»' : undefined)}
          </div>
          <section className="rounded-xl border border-slate-200 bg-white p-3">
            <h3 className="mb-2 text-sm font-bold">Evolución del ejecutado (acumulado por mes)</h3>
            {!data.series.length ? <p className="text-sm text-slate-500">Sin gastos ejecutados.</p> : <div className="space-y-1">
              {data.series.map(s => <div key={s.month} className="flex items-center gap-2 text-xs">
                <span className="w-16 tabular-nums">{s.month}</span>
                <div className="h-3 flex-1 rounded bg-slate-100"><div className="h-3 rounded bg-[#002855]" style={{ width: `${Math.max(1, Number(s.cumulative_pen) / maxSeries * 100)}%` }} /></div>
                <span className="w-40 text-right tabular-nums">S/ {n(s.cumulative_pen)} <span className="text-slate-500">(+{n(s.consumed_pen)})</span></span></div>)}
            </div>}
            <p className="mt-2 text-[11px] text-slate-500">El comprometido es un estado vigente: no tiene historia por fecha.</p>
          </section>
        </div>}

        {tab === 'viajes' && <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          {!data.trips.length ? <p className="p-8 text-center text-sm text-slate-500">Sin viajes en el período.</p> : <table className="w-full min-w-[72rem] text-sm">
            <thead className="bg-slate-50"><tr><th className={th}>Fecha</th><th className={th}>Viaje</th><th className={th}>Origen → destino</th><th className={th}>Guías</th>
              <th className={th}>Transportista · unidad</th><th className={`${th} text-right`}>Planificado</th><th className={`${th} text-right`}>Comprometido</th>
              <th className={`${th} text-right`}>Ejecutado</th><th className={`${th} text-right`}>Diferencia</th><th className={th}>Liquidación</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{data.trips.map(t => {
              const diff = Number(t.reserved_pen) + Number(t.consumed_pen) - Number(t.planned_pen)
              return <tr key={t.dispatch_id} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-xs tabular-nums">{day(t.date)}</td>
                <td className="px-3 py-2"><Link href={`/torre-control?despacho=${t.dispatch_id}`} className="font-bold text-[#002855] underline">{t.number}</Link>
                  <Link href={`/despacho/control-presupuestal/movimientos?ot=${data.contract.id}&q=${encodeURIComponent(t.number)}`} className="block text-[11px] text-slate-500 underline">Movimientos</Link></td>
                <td className="px-3 py-2 text-xs">{t.origin || '—'} → {t.destination || '—'}</td>
                <td className="px-3 py-2 text-xs">{t.guides || '—'}</td>
                <td className="px-3 py-2 text-xs">{t.carrier || (t.modalidad === 'TERCERO' ? 'Tercero' : 'Flota propia')} · {t.plate || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(t.planned_pen)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(t.reserved_pen)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(t.consumed_pen)}{t.has_estimate && <span className="block text-[10px] text-amber-700">incluye estimado</span>}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${diff > 0.009 ? 'font-semibold text-red-700' : ''}`}>{n(diff)}</td>
                <td className="px-3 py-2 text-xs">{t.closure?.final ? 'Servicio cerrado' : t.closure?.ready ? 'Listo para cerrar' : `Doc. ${t.closure?.documentario?.toLowerCase() || '—'} · Econ. ${t.closure?.economico?.toLowerCase() || '—'}`}</td>
              </tr> })}</tbody></table>}
          {data.trips_total > data.trips.length && <p className="p-2 text-xs text-slate-500">Se muestran los {data.trips.length} viajes más recientes de {data.trips_total}: acote el período.</p>}
        </div>}

        {tab === 'conceptos' && <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[40rem] text-sm"><thead className="bg-slate-50"><tr><th className={th}>Concepto</th><th className={`${th} text-right`}>Comprometido</th>
            <th className={`${th} text-right`}>Ejecutado</th><th className={`${th} text-right`}>De ello estimado</th><th className={`${th} text-right`}>Participación</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{data.concepts.map(c => {
              const total = data.concepts.reduce((a, x) => a + Number(x.reserved_pen) + Number(x.consumed_pen), 0)
              return <tr key={c.concept}><td className="px-3 py-2 font-semibold">{c.concept}</td><td className="px-3 py-2 text-right tabular-nums">{n(c.reserved_pen)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(c.consumed_pen)}</td><td className="px-3 py-2 text-right tabular-nums">{c.estimated_pen ? n(c.estimated_pen) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{total ? Math.round((Number(c.reserved_pen) + Number(c.consumed_pen)) / total * 1000) / 10 : 0} %</td></tr> })}</tbody></table>
          <p className="p-2 text-[11px] text-slate-500">Flete incluye el reverso de la tarifa en flota propia (sus costos reales están en los otros conceptos). Cada importe se cuenta una vez.</p>
        </div>}

        {tab === 'alertas' && <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
          {!pending.length ? <p className="text-sm text-slate-500">Sin pendientes en la partida de esta OT.</p> : <ul className="divide-y divide-slate-100">
            {pending.map((r, i) => <li key={i} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
              <span><span className="font-semibold">{r.cause}</span><span className="block text-xs text-slate-500">{r.action}{r.age_days != null ? ` · ${r.age_days} día(s)` : ''}</span></span>
              <span className="text-right"><span className="tabular-nums">S/ {n(r.amount_pen)}</span>
                {r.dispatch_id && <Link href={`/torre-control?despacho=${r.dispatch_id}`} className="block text-xs font-semibold text-[#002855] underline">Abrir {r.dispatch_number}</Link>}</span></li>)}
          </ul>}
          <p className="text-xs text-slate-600">Desvíos de costo, sustentos del Supervisor y decisiones: <Link href="/despacho/control-presupuestal/pendientes" className="font-semibold text-[#002855] underline">Pendientes y autorizaciones</Link>.</p>
        </section>}

        {tab === 'autorizaciones' && <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-xs text-slate-600">La <b>autorización sobre el tope</b> (hasta el 100 %) no cambia la partida: <Link href={`/despacho/control-presupuestal/pendientes?solicitar=${data.contract.id}&codigo=${encodeURIComponent(data.contract.code)}`} className="font-semibold text-[#002855] underline">solicitarla</Link>.
            La <b>ampliación</b> sí aumenta el presupuesto vigente y la decide Gerencia.</p>
          {data.can_request_extension && <form onSubmit={e => { e.preventDefault(); void call('budget_extension_request', { p_contract_id: data.contract.id, p_amount: Number(form.amount), p_reason: form.reason, p_evidence: form.evidence || null }, 'Ampliación solicitada a Gerencia').then(ok => ok && setForm({ amount: '', reason: '', evidence: '' })) }}
            className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end">
            <label className="text-xs font-semibold text-slate-600">Monto (S/)<input type="number" min="0.01" step="0.01" required value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="mt-1 block h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label>
            <label className="text-xs font-semibold text-slate-600">Motivo<input required minLength={10} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="mt-1 block h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label>
            <label className="text-xs font-semibold text-slate-600">Evidencia (opcional)<input value={form.evidence} onChange={e => setForm(f => ({ ...f, evidence: e.target.value }))} className="mt-1 block h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label>
            <button disabled={busy} className="h-9 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Solicitar ampliación</button>
          </form>}
          {!data.extensions.length ? <p className="text-sm text-slate-500">Sin ampliaciones.</p> : <ul className="divide-y divide-slate-100">
            {data.extensions.map(x => <li key={x.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
              <span><span className="font-semibold">S/ {n(x.amount_pen)} · {x.status.toLowerCase()}</span>
                <span className="block text-xs text-slate-600">{x.reason}{x.evidence ? ` · ${x.evidence}` : ''}</span>
                <span className="block text-[11px] text-slate-500">Solicitó {x.requested_by || '—'} el {day(x.requested_at)}{x.decided_at ? ` · decidió ${x.decided_by || '—'} el ${day(x.decided_at)}${x.decision_note ? `: ${x.decision_note}` : ''}` : ''}</span></span>
              {x.status === 'SOLICITADA' && data.can_decide_extension && <span className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => decide(x, 'APROBAR')} className="rounded border border-emerald-600 px-2 py-1 text-xs font-semibold text-emerald-700">Aprobar</button>
                <button type="button" disabled={busy} onClick={() => decide(x, 'RECHAZAR')} className="rounded border border-red-300 px-2 py-1 text-xs font-semibold text-red-700">Rechazar</button></span>}
            </li>)}
          </ul>}
        </section>}

        {tab === 'ahorro' && <section className="space-y-2 rounded-xl border border-slate-200 bg-white">
          {!savings ? <p className="p-6 text-center text-sm text-slate-500">Cargando…</p> : <>
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 pb-0 text-sm">
              <p>Ahorro atribuido: <b className="text-emerald-700">S/ {money(savings.rows.filter(r => !r.principal).reduce((s, r) => s + Number(r.saving_pen || 0), 0))}</b> · {savings.rows.filter(r => !r.principal).length} servicio(s) aprovechado(s){range.from || range.to ? '' : ' · últimos 12 meses'}</p>
              <button type="button" disabled={!savings.rows.length} onClick={() => exportSavingsCsv(savings.rows, `ahorro-${data.contract.code}`)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Exportar</button></div>
            <SavingsTable rows={savings.rows} />
            <p className="px-3 pb-3 text-[11px] text-slate-500">Indicador de eficiencia: no consume la partida. Detalle completo en la pestaña Ahorro por consolidación.</p></>}
        </section>}
        {tab === 'historial' && <section className="rounded-xl border border-slate-200 bg-white p-3">
          {!data.timeline.length ? <p className="text-sm text-slate-500">Sin eventos.</p> : <ol className="space-y-2">
            {data.timeline.map((h, i) => <li key={i} className="border-l-2 border-slate-200 pl-3 text-sm">
              <p className="font-semibold">{h.title}{h.old != null && h.new != null ? `: S/ ${n(h.old)} → S/ ${n(h.new)}` : ''}</p>
              <p className="text-xs text-slate-500">{new Date(h.at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}{h.by ? ` · ${h.by}` : ''}{h.detail ? ` · ${h.detail}` : ''}</p></li>)}
          </ol>}
          <p className="mt-2 text-[11px] text-slate-500">Compromisos y gastos por fecha: pestaña Movimientos.</p>
        </section>}
      </>}
    </div>
  )
}
