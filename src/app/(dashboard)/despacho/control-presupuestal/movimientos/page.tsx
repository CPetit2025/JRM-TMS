"use client"
import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { errorMessage, money } from '@/lib/caja'
import { ControlPresupuestalTabs } from '@/components/despacho/ControlPresupuestalTabs'

// Movimientos que explican la posición de una OT (budget_movements, docs/control-presupuestal/circuito-economico.md):
// cada fila es la fuente vigente (flete, descarga, cargo, imputación) con su efecto sobre comprometido y ejecutado.
// La diferencia de conciliación es lo guardado en la partida que ningún movimiento explica (históricos); no se fuerza.

type Movement = {
  id: string; source: string; concept: string; budget_code: string | null; ref_code: string | null
  dispatch_id: string | null; dispatch_number: string | null; request_number: string | null; service_id: string | null
  provider: string | null; origin: string; date: string | null; status: string; amount_pen: number; estimated: boolean
  reserved_pen: number; consumed_pen: number; reversal: boolean; support: string | null; has_budget: boolean; service_contract_id: string | null
}
type Result = {
  contract: { id: string; code: string; client: string | null }
  position: { allocated_pen: number; reserved_pen: number; consumed_pen: number; authorized_over_cap_pen: number }
  explained: { reserved_pen: number; consumed_pen: number }
  difference: { reserved_pen: number; consumed_pen: number }
  period: { from: string | null; to: string | null; opening_consumed_pen: number; period_consumed_pen: number; closing_consumed_pen: number }
  without_budget: number; total: number; rows: Movement[]; as_of: string
}
type Ot = { contract_id: string; code: string; client: string | null }

const supabase = createClient()
const PAGE = 100
const EFFECTS: Record<string, string> = { COMPROMETIDO: 'Con efecto en comprometido', EJECUTADO: 'Con efecto en ejecutado', SIN_EFECTO: 'Sin efecto (liberados, anulados, pendientes)' }
const SOURCE: Record<string, string> = { FLETE: 'Flete', DESCARGA: 'Servicio especial', CARGO: 'Cargo', CAJA: 'Caja', COMBUSTIBLE_ESTIMADO: 'Combustible', TARIFA_PROPIA: 'Tarifa propia', SOLICITUD: 'Solicitud' }
const signed = (n: number) => (Number(n) === 0 ? '—' : money(Number(n)))

function Movimientos() {
  const params = useSearchParams(); const router = useRouter(); const path = usePathname()
  const ot = params.get('ot') || ''; const effect = params.get('efecto') || ''; const from = params.get('desde') || ''; const to = params.get('corte') || ''
  const q = params.get('q') || ''; const page = Math.max(0, Number(params.get('pag') || 0))
  const [ots, setOts] = useState<Ot[]>([])
  const [data, setData] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState(q)

  // Los filtros viven en la dirección: se conservan al abrir el origen y volver
  const set = useCallback((changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k) }
    if (!('pag' in changes)) next.delete('pag')
    router.replace(`${path}?${next.toString()}`, { scroll: false })
  }, [params, path, router])

  useEffect(() => {
    void supabase.rpc('budget_positions').then(({ data: d }) => { if (d?.success) setOts((d.rows as Ot[]).map(r => ({ contract_id: r.contract_id, code: r.code, client: r.client }))) })
  }, [])
  const load = useCallback(async () => {
    if (!ot) { setData(null); return }
    setLoading(true)
    const { data: d, error } = await supabase.rpc('budget_movements', { p_contract_id: ot, p_from: from || null, p_to: to || null,
      p_effect: effect || null, p_search: q || null, p_limit: PAGE, p_offset: page * PAGE })
    setLoading(false)
    if (error || !d?.success) { toast.error(error ? errorMessage(error) : d?.error); setData(null); return }
    setData(d as Result)
  }, [ot, from, to, effect, q, page])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  useEffect(() => { const t = window.setTimeout(() => { if (search !== q) set({ q: search }) }, 400); return () => window.clearTimeout(t) }, [search, q, set])

  const diff = data ? Math.abs(Number(data.difference.reserved_pen)) + Math.abs(Number(data.difference.consumed_pen)) : 0
  const origin = (m: Movement) => m.dispatch_id ? `/despacho/documentos/economico?despacho=${m.dispatch_id}`
    : m.service_contract_id ? `/contratos/servicios?contrato=${m.service_contract_id}` : null

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title="Control presupuestal" description="Movimientos que explican el comprometido y el ejecutado de la OT, con su origen y sustento."
        actions={<button type="button" disabled={!ot} onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50 disabled:opacity-50"><RefreshCw className="h-4 w-4" />Actualizar</button>} />
      <ControlPresupuestalTabs active="movimientos" ot={ot} />

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs font-semibold text-slate-600">OT
          <select value={ot} onChange={e => set({ ot: e.target.value })} className="mt-1 block h-9 w-72 max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm">
            <option value="">Seleccione una OT…</option>
            {ots.map(o => <option key={o.contract_id} value={o.contract_id}>{o.code}{o.client ? ` · ${o.client}` : ''}</option>)}
            {ot && data && !ots.some(o => o.contract_id === data.contract.id) && <option value={ot}>{data.contract.code}</option>}
          </select></label>
        <label className="text-xs font-semibold text-slate-600">Desde
          <input type="date" value={from} onChange={e => set({ desde: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
        <label className="text-xs font-semibold text-slate-600">Fecha de corte
          <input type="date" value={to} onChange={e => set({ corte: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
        <label className="text-xs font-semibold text-slate-600">Efecto
          <select value={effect} onChange={e => set({ efecto: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm">
            <option value="">Todos</option>{Object.entries(EFFECTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label className="relative block w-64 max-w-full"><span className="sr-only">Buscar movimiento</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Ruta, solicitud, proveedor…" className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm" /></label>
      </div>

      {!ot ? <p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Seleccione una OT, o abra sus importes desde el Resumen por OT.</p>
        : !data ? <p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{loading ? 'Cargando…' : 'Sin datos.'}</p>
        : <>
          <section aria-label="Posición de la OT" className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div><p className="text-xs text-slate-500">OT</p><p className="font-bold text-[#002855]">{data.contract.code}</p><p className="text-xs text-slate-500">{data.contract.client || '—'} · asignado S/ {money(Number(data.position.allocated_pen))}</p></div>
            <div><p className="text-xs text-slate-500">Comprometido vigente</p><p className="font-bold tabular-nums">S/ {money(Number(data.position.reserved_pen))}</p>
              <p className="text-xs text-slate-500">Estado actual (no tiene historia por fecha)</p></div>
            <div><p className="text-xs text-slate-500">Ejecutado {to ? `al ${to}` : 'acumulado'}</p><p className="font-bold tabular-nums">S/ {money(Number(data.period.closing_consumed_pen))}</p>
              {from && <p className="text-xs text-slate-500">Inicial S/ {money(Number(data.period.opening_consumed_pen))} + período S/ {money(Number(data.period.period_consumed_pen))}</p>}
              {!from && !to && <p className="text-xs text-slate-500">Explicado por movimientos; en la partida: S/ {money(Number(data.position.consumed_pen))}</p>}</div>
            <div><p className="text-xs text-slate-500">Conciliación</p>
              {diff < 0.01 ? <p className="font-bold text-emerald-700">Cuadra con la partida</p>
                : <><p className="flex items-center gap-1 font-bold text-amber-700"><AlertTriangle className="h-4 w-4" />Diferencia sin movimiento</p>
                  <p className="text-xs text-slate-600">Comprometido S/ {money(Number(data.difference.reserved_pen))} · ejecutado S/ {money(Number(data.difference.consumed_pen))}. Registros anteriores sin rastro: se revisa, no se ajusta solo.</p></>}
              {data.without_budget > 0 && <p className="text-xs text-amber-700">{data.without_budget} movimiento(s) de un contrato sin partida propia</p>}</div>
          </section>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            {!data.rows.length ? <p className="p-8 text-center text-sm text-slate-500">No hay movimientos para los filtros seleccionados.</p>
              : <table className="w-full min-w-[72rem] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
                  <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Movimiento</th><th className="px-3 py-2">OT</th><th className="px-3 py-2">Ruta · solicitud</th>
                  <th className="px-3 py-2">Proveedor · sustento</th><th className="px-3 py-2">Origen · estado</th><th className="px-3 py-2 text-right">Importe</th>
                  <th className="px-3 py-2 text-right">Comprometido</th><th className="px-3 py-2 text-right">Ejecutado</th><th className="px-3 py-2"><span className="sr-only">Abrir</span></th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map(m => {
                    const href = origin(m)
                    return <tr key={m.id} className={m.reversal ? 'bg-slate-50/60' : 'hover:bg-slate-50'}>
                      <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums">{m.date ? m.date.split('-').reverse().join('/') : '—'}</td>
                      <td className="px-3 py-2"><span className="font-semibold">{m.concept}</span>
                        <span className="mt-0.5 flex flex-wrap gap-1 text-[10px] font-semibold">
                          <span className="rounded bg-slate-100 px-1.5 text-slate-600">{SOURCE[m.source] || m.source}</span>
                          {m.estimated && <span className="rounded bg-amber-100 px-1.5 text-amber-800">Estimado</span>}
                          {m.reversal && <span className="rounded bg-slate-200 px-1.5 text-slate-700">Reverso</span>}
                          {!m.has_budget && <span className="rounded bg-red-100 px-1.5 text-red-700">Sin partida</span>}</span></td>
                      <td className="px-3 py-2 text-xs">{m.ref_code || '—'}{m.budget_code && m.budget_code !== m.ref_code && <span className="block text-slate-500">Financia: {m.budget_code}</span>}</td>
                      <td className="px-3 py-2 text-xs">{m.dispatch_number || '—'}{m.request_number && <span className="block text-slate-500">{m.request_number}</span>}</td>
                      <td className="px-3 py-2 text-xs">{m.provider || '—'}{m.support && <span className="block text-slate-500">{m.support}</span>}</td>
                      <td className="px-3 py-2 text-xs">{m.origin}<span className="block text-slate-500">{m.status}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(Number(m.amount_pen))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{signed(m.reserved_pen)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${Number(m.consumed_pen) < 0 ? 'text-emerald-700' : ''}`}>{signed(m.consumed_pen)}</td>
                      <td className="px-3 py-2 text-right">{href && <Link href={href} className="whitespace-nowrap text-xs font-semibold text-[#002855] underline">
                        {m.dispatch_id ? 'Costos de la ruta' : 'Registro de Servicios'}</Link>}</td>
                    </tr>
                  })}
                </tbody>
              </table>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>{data.total} movimiento(s){data.total > PAGE && ` · página ${page + 1} de ${Math.ceil(data.total / PAGE)}`} · al {new Date(data.as_of).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</span>
            {data.total > PAGE && <span className="flex gap-2">
              <button type="button" disabled={page === 0} onClick={() => set({ pag: String(page - 1) })} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50">Anterior</button>
              <button type="button" disabled={(page + 1) * PAGE >= data.total} onClick={() => set({ pag: String(page + 1) })} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50">Siguiente</button></span>}
          </div>
          <p className="text-[11px] text-slate-500">Ruta propia: al cerrar, la tarifa se revierte (Tarifa propia) y quedan los costos reales de Caja y el combustible (estimado hasta que llega la carga real). Tercero: la tarifa contratada es el ejecutado. Los anulados y liberados se muestran como reverso sin efecto.</p>
        </>}
    </div>
  )
}

export default function MovimientosPage() {
  return <Suspense fallback={null}><Movimientos /></Suspense>
}
