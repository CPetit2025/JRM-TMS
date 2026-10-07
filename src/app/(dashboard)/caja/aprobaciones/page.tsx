'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, Clock, Eye, FileText, Loader2, RefreshCw, RotateCcw, Search, ShieldAlert, XCircle,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'
import {
  EXPENSE_STATUS, alertsOf, errorMessage, fmtDate, isPdf, loadCategories, money, receiptUrl, rpcOk,
  type ExpenseCategory, type Row,
} from '@/lib/caja'

// Aprobación de gastos (Caja C1): exclusiva del Administrador y del Jefe de Distribución (permiso caja-aprobacion).
// Las acciones pasan por review_dispatch_expense / approve_dispatch_expenses (migración 20260929090000).

const supabase = createClient()
const SELECT = `*, dispatch:dispatches(id, dispatch_number, vehicle_plate, status), advance:trip_advances!dispatch_expenses_advance_id_fkey(code, reason_code)`

type Filters = { status: string; source: string; category: string; q: string; from: string; to: string; onlyAlerts: boolean; onlyBillable: boolean }
const EMPTY: Filters = { status: 'PENDIENTE', source: '', category: '', q: '', from: '', to: '', onlyAlerts: false, onlyBillable: false }

export default function AprobacionesPage() {
  const { hasAccess, role, isLoaded } = usePermissions()
  const allowed = hasAccess('caja-aprobacion')
  const isAdmin = role === 'admin'

  const [rows, setRows] = useState<Row[]>([])
  const [people, setPeople] = useState<Record<string, string>>({})
  const [cats, setCats] = useState<ExpenseCategory[]>([])
  const [stats, setStats] = useState<Row>({})
  const [settings, setSettings] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [me, setMe] = useState<string | null>(null)

  const load = useCallback(async (f: Filters) => {
    setLoading(true)
    let q = supabase.from('dispatch_expenses').select(SELECT).order('expense_date', { ascending: false }).order('created_at', { ascending: false }).limit(500)
    if (f.status) q = q.eq('status', f.status)
    if (f.source) q = q.eq('source', f.source)
    if (f.category) q = q.eq('expense_type', f.category)
    if (f.from) q = q.gte('expense_date', f.from)
    if (f.to) q = q.lte('expense_date', f.to)
    if (f.onlyBillable) q = q.eq('is_billable', true)
    const since = new Date(Date.now() - 30 * 864e5).toISOString()
    const [list, pend, obs, rev] = await Promise.all([
      q,
      supabase.from('dispatch_expenses').select('amount, alerts').eq('status', 'PENDIENTE'),
      supabase.from('dispatch_expenses').select('id', { count: 'exact', head: true }).eq('status', 'OBSERVADO'),
      supabase.from('dispatch_expenses').select('created_at, reviewed_at').in('status', ['APROBADO', 'RECHAZADO']).gte('reviewed_at', since),
    ])
    if (list.error) toast.error('Error al cargar gastos: ' + list.error.message)
    const data = list.data || []
    setRows(data)
    const pending = pend.data || []
    const reviewed = rev.data || []
    const today = new Date().toDateString()
    const hours = reviewed.map(r => (new Date(r.reviewed_at).getTime() - new Date(r.created_at).getTime()) / 36e5).filter(h => h >= 0)
    setStats({
      pendingCount: pending.length,
      pendingAmount: pending.reduce((s, r) => s + Number(r.amount || 0), 0),
      withAlerts: pending.filter(r => alertsOf(r).length > 0).length,
      observed: obs.count || 0,
      reviewedToday: reviewed.filter(r => new Date(r.reviewed_at).toDateString() === today).length,
      avgHours: hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null,
    })
    const ids = [...new Set(data.flatMap(r => [r.driver_id, r.created_by, r.reviewed_by, r.first_approved_by]).filter(Boolean))]
    if (ids.length) {
      const { data: ppl } = await supabase.from('vw_caja_people').select('id, full_name').in('id', ids)
      setPeople(Object.fromEntries((ppl || []).map(p => [p.id, p.full_name])))
    }
    setSelected(new Set())
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!isLoaded || !allowed) return
    supabase.auth.getUser().then(r => setMe(r.data.user?.id || null))
    loadCategories(supabase).then(setCats)
    supabase.from('caja_settings').select('*').maybeSingle().then(r => setSettings(r.data))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(EMPTY)
  }, [isLoaded, allowed, load])

  const catLabel = useMemo(() => Object.fromEntries(cats.map(c => [c.code, c.label])), [cats])
  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase()
    return rows.filter(r => {
      if (filters.onlyAlerts && alertsOf(r).length === 0) return false
      if (!q) return true
      return [r.dispatch?.dispatch_number, r.vehicle_plate, people[r.driver_id], people[r.created_by], r.provider_name, r.provider_ruc,
        `${r.document_series || ''}-${r.document_number || ''}`, r.description].some(v => String(v || '').toLowerCase().includes(q))
    })
  }, [rows, filters.q, filters.onlyAlerts, people])

  const canBulk = (r: Row) => r.status === 'PENDIENTE' && alertsOf(r).length === 0 && r.created_by !== me
  const bulkable = visible.filter(canBulk)
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const setF = (patch: Partial<Filters>) => { const f = { ...filters, ...patch }; setFilters(f); if (!('q' in patch) && !('onlyAlerts' in patch)) void load(f) }

  const approveBulk = async () => {
    if (!selected.size) return
    setBusy(true)
    try {
      const r = await rpcOk<Row>(supabase, 'approve_dispatch_expenses', { p_expense_ids: [...selected] })
      toast.success(`Aprobados: ${r.approved}${r.pre_approved ? ` · Pre-aprobados (esperan al Administrador): ${r.pre_approved}` : ''}`)
      if (r.skipped?.length) toast.warning(`${r.skipped.length} omitidos: ${r.skipped[0].error}`)
      await load(filters)
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  if (!isLoaded) return <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
  if (!allowed) return (
    <div className="p-10 max-w-lg mx-auto text-center">
      <ShieldAlert className="w-12 h-12 text-slate-300 mx-auto mb-3" />
      <h1 className="text-xl font-bold text-slate-800">Acceso restringido</h1>
      <p className="text-sm text-slate-500 mt-1">La aprobación de gastos es exclusiva del Administrador del sistema y del Jefe de Distribución.</p>
    </div>
  )

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><ClipboardCheck className="w-6 h-6" />Aprobación de gastos</h1>
          <p className="text-sm text-slate-500">
            Gastos de la app del conductor y de Caja web. Solo lo aprobado pasa al costo del viaje y al TCO de la unidad.
            {settings?.double_approval_threshold && <> Montos desde <b>{money(settings.double_approval_threshold)}</b> requieren confirmación del Administrador.</>}
          </p>
        </div>
        <button onClick={() => load(filters)} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2 hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi icon={<Clock className="w-4 h-4" />} label="Pendientes" value={`${stats.pendingCount ?? 0}`} sub={money(stats.pendingAmount)} onClick={() => setF({ status: 'PENDIENTE', onlyAlerts: false })} />
        <Kpi icon={<AlertTriangle className="w-4 h-4" />} label="Con alertas" value={`${stats.withAlerts ?? 0}`} sub="pendientes" tone="red" onClick={() => setF({ status: 'PENDIENTE', onlyAlerts: true })} />
        <Kpi icon={<FileText className="w-4 h-4" />} label="Observados" value={`${stats.observed ?? 0}`} sub="esperan corrección" tone="amber" onClick={() => setF({ status: 'OBSERVADO', onlyAlerts: false })} />
        <Kpi icon={<CheckCircle2 className="w-4 h-4" />} label="Revisados hoy" value={`${stats.reviewedToday ?? 0}`} sub="aprobados o rechazados" tone="green" />
        <Kpi icon={<Clock className="w-4 h-4" />} label="Tiempo de aprobación" value={stats.avgHours != null ? `${stats.avgHours.toFixed(1)} h` : '—'} sub="promedio 30 días" />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-end gap-2 text-sm">
        <Field label="Estado">
          <select value={filters.status} onChange={e => setF({ status: e.target.value })} className="border rounded-lg px-2 py-1.5">
            <option value="">Todos</option>
            {Object.entries(EXPENSE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Origen">
          <select value={filters.source} onChange={e => setF({ source: e.target.value })} className="border rounded-lg px-2 py-1.5">
            <option value="">Todos</option><option value="APP">App conductor</option><option value="WEB">Caja web</option>
          </select>
        </Field>
        <Field label="Categoría">
          <select value={filters.category} onChange={e => setF({ category: e.target.value })} className="border rounded-lg px-2 py-1.5">
            <option value="">Todas</option>
            {cats.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Desde"><input type="date" value={filters.from} onChange={e => setF({ from: e.target.value })} className="border rounded-lg px-2 py-1.5" /></Field>
        <Field label="Hasta"><input type="date" value={filters.to} onChange={e => setF({ to: e.target.value })} className="border rounded-lg px-2 py-1.5" /></Field>
        <Field label="Buscar">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-2 text-slate-400" />
            <input value={filters.q} onChange={e => setF({ q: e.target.value })} placeholder="Despacho, placa, conductor, RUC…" className="border rounded-lg pl-7 pr-2 py-1.5 w-56" />
          </div>
        </Field>
        <label className="flex items-center gap-1.5 py-1.5"><input type="checkbox" checked={filters.onlyAlerts} onChange={e => setF({ onlyAlerts: e.target.checked })} />Solo con alertas</label>
        <label className="flex items-center gap-1.5 py-1.5"><input type="checkbox" checked={filters.onlyBillable} onChange={e => setF({ onlyBillable: e.target.checked })} />Solo refacturables</label>
        <button onClick={() => { setFilters(EMPTY); void load(EMPTY) }} className="text-xs text-blue-600 hover:underline py-2">Limpiar</button>
      </div>

      {selected.size > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center justify-between text-sm">
          <span><b>{selected.size}</b> gastos seleccionados · {money(visible.filter(r => selected.has(r.id)).reduce((s, r) => s + Number(r.amount), 0))}</span>
          <button disabled={busy} onClick={approveBulk} className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}Aprobar seleccionados
          </button>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-auto max-h-[calc(100vh-380px)]">
        {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
          <DataTable className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 sticky top-0 z-10">
              <tr>
                <th className="p-3 w-8">
                  <input type="checkbox" title="Seleccionar los gastos sin alertas" disabled={!bulkable.length}
                    checked={bulkable.length > 0 && bulkable.every(r => selected.has(r.id))}
                    onChange={e => setSelected(e.target.checked ? new Set(bulkable.map(r => r.id)) : new Set())} />
                </th>
                <th className="p-3 text-left">Fecha</th><th className="p-3 text-left">Despacho / Placa</th><th className="p-3 text-left">Conductor</th>
                <th className="p-3 text-left">Categoría</th><th className="p-3 text-left">Comprobante</th><th className="p-3 text-right">Monto</th>
                <th className="p-3 text-left">Alertas</th><th className="p-3 text-left">Origen</th><th className="p-3 text-left">Estado</th><th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.length === 0 && <tr><td colSpan={11} className="p-10 text-center text-slate-400">No hay gastos con estos filtros</td></tr>}
              {visible.map(r => {
                const al = alertsOf(r)
                const st = EXPENSE_STATUS[r.status] || { label: r.status, cls: 'bg-slate-100' }
                return (
                  <tr key={r.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setDetail(r)}>
                    <td className="p-3" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" disabled={!canBulk(r)} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="p-3 whitespace-nowrap">{fmtDate(r.expense_date)}</td>
                    <td className="p-3"><div className="font-semibold text-[#002855]">{r.dispatch?.dispatch_number || 'Sin viaje'}</div><div className="text-xs text-slate-500">{r.vehicle_plate}</div>
                      {r.advance?.code && <div className="text-xs text-violet-700">Rinde {r.advance.code}</div>}</td>
                    <td className="p-3">{people[r.driver_id] || '—'}</td>
                    <td className="p-3">
                      {catLabel[r.expense_type] || r.expense_type}
                      {r.expense_type === 'COMBUSTIBLE' && r.fuel_gallons && (
                        <div className="text-xs text-slate-500">{Number(r.fuel_gallons)} gal · {money(Number(r.amount) / Number(r.fuel_gallons))}/gal · {Number(r.fuel_odometer || 0).toLocaleString('es-PE')} km</div>
                      )}
                    </td>
                    <td className="p-3 text-xs">
                      {r.document_type ? <>{r.document_type} {r.document_series}-{r.document_number}<div className="text-slate-500 truncate max-w-40">{r.provider_name || r.provider_ruc}</div></> : r.receipt_url ? 'Foto adjunta' : <span className="text-red-600">Sin comprobante</span>}
                    </td>
                    <td className="p-3 text-right font-bold whitespace-nowrap">
                      {money(r.amount)}
                      {r.approved_amount != null && Number(r.approved_amount) !== Number(r.amount) && r.status === 'APROBADO' && <div className="text-xs text-emerald-700">aprob. {money(r.approved_amount)}</div>}
                    </td>
                    <td className="p-3">
                      {al.length ? <span title={al.map(a => a.message).join('\n')} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${al.some(a => a.level === 'ALTA') ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}><AlertTriangle className="w-3 h-3" />{al.length}</span> : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="p-3 text-xs">{r.source === 'WEB' ? 'Caja web' : 'App'}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${st.cls}`}>{st.label}</span>
                      {r.status === 'PENDIENTE' && r.first_approved_by && <div className="text-[10px] text-violet-700 mt-0.5">Pre-aprobado</div>}
                    </td>
                    <td className="p-3"><Eye className="w-4 h-4 text-slate-400" /></td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
      </div>

      {detail && (
        <ExpenseReview expense={detail} people={people} catLabel={catLabel} isAdmin={isAdmin} me={me}
          onClose={() => setDetail(null)} onDone={() => { setDetail(null); void load(filters) }} />
      )}
    </div>
  )
}

function Kpi({ icon, label, value, sub, tone, onClick }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: 'red' | 'amber' | 'green'; onClick?: () => void }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : tone === 'green' ? 'text-emerald-600' : 'text-slate-900'
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className="bg-white border border-slate-200 rounded-xl p-4 text-left enabled:hover:border-blue-300 transition-colors">
      <div className="flex items-center gap-2 text-xs text-slate-500">{icon}{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[10px] font-bold uppercase text-slate-500">{label}</span>{children}</label>
}

type Action = 'APROBAR' | 'OBSERVAR' | 'RECHAZAR' | 'REVERTIR'

function ExpenseReview({ expense, people, catLabel, isAdmin, me, onClose, onDone }: {
  expense: Row; people: Record<string, string>; catLabel: Record<string, string>; isAdmin: boolean; me: string | null
  onClose: () => void; onDone: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [events, setEvents] = useState<Row[]>([])
  const [trip, setTrip] = useState<Row | null>(null)
  const [names, setNames] = useState<Record<string, string>>(people)
  const [action, setAction] = useState<Action | null>(null)
  const [comment, setComment] = useState('')
  const [amount, setAmount] = useState(String(expense.approved_amount ?? expense.amount))
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const al = alertsOf(expense)
  const own = expense.created_by === me

  useEffect(() => {
    receiptUrl(supabase, expense.receipt_url).then(setUrl)
    supabase.from('dispatch_expense_events').select('*').eq('expense_id', expense.id).order('created_at').then(async ({ data }) => {
      setEvents(data || [])
      const ids = [...new Set((data || []).map(e => e.actor_id).filter(id => id && !people[id]))]
      if (ids.length) {
        const { data: ppl } = await supabase.from('vw_caja_people').select('id, full_name').in('id', ids)
        setNames(n => ({ ...n, ...Object.fromEntries((ppl || []).map(p => [p.id, p.full_name])) }))
      }
    })
    if (expense.dispatch_id) {
      supabase.from('dispatch_expenses').select('amount, approved_amount, status').eq('dispatch_id', expense.dispatch_id).then(({ data }) => {
        const all = data || []
        setTrip({
          count: all.length,
          declared: all.filter(e => e.status !== 'RECHAZADO').reduce((s, e) => s + Number(e.amount), 0),
          approved: all.filter(e => e.status === 'APROBADO').reduce((s, e) => s + Number(e.approved_amount ?? e.amount), 0),
        })
      })
    }
  }, [expense, people])

  const submit = async () => {
    if (!action) return
    setBusy(true)
    try {
      const adjusted = action === 'APROBAR' && Number(amount) !== Number(expense.amount) ? Number(amount) : null
      const r = await rpcOk<Row>(supabase, 'review_dispatch_expense', {
        p_expense_id: expense.id, p_action: action, p_comment: comment || null, p_approved_amount: adjusted, p_ack_alerts: ack,
      })
      toast.success(r.message || `Gasto ${EXPENSE_STATUS[r.status]?.label.toLowerCase() || r.status}`)
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const st = EXPENSE_STATUS[expense.status] || { label: expense.status, cls: '' }
  const needsComment = action === 'OBSERVAR' || action === 'RECHAZAR' || action === 'REVERTIR' || (action === 'APROBAR' && Number(amount) !== Number(expense.amount))

  return (
    <Modal isOpen onClose={onClose} title={`Gasto ${catLabel[expense.expense_type] || expense.expense_type} · ${money(expense.amount)}`} maxWidth="max-w-5xl">
      <div className="grid md:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="bg-slate-100 rounded-xl min-h-72 flex items-center justify-center overflow-hidden">
            {!expense.receipt_url ? <div className="text-center text-slate-400 p-8"><FileText className="w-10 h-10 mx-auto mb-2" />Sin foto del comprobante</div>
              : !url ? <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              : isPdf(expense.receipt_url) ? <iframe src={url} className="w-full h-[28rem]" title="Comprobante" />
              // eslint-disable-next-line @next/next/no-img-element
              : <a href={url} target="_blank" rel="noreferrer" title="Abrir en tamaño completo"><img src={url} alt="Comprobante" className="max-h-[28rem] object-contain hover:scale-[1.02] transition-transform" /></a>}
          </div>
          {url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">Abrir comprobante en otra pestaña</a>}
        </div>

        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${st.cls}`}>{st.label}</span>
            <span className="text-xs text-slate-500">{expense.source === 'WEB' ? 'Registrado en Caja web' : 'Registrado en la app'} por {names[expense.created_by] || '—'}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Dt k="Fecha del gasto" v={fmtDate(expense.expense_date)} />
            <Dt k="Registrado" v={fmtDate(expense.created_at, true)} />
            <Dt k="Despacho" v={expense.dispatch?.dispatch_number || 'Sin viaje (gasto de la unidad)'} />
            <Dt k="Placa" v={expense.vehicle_plate} />
            <Dt k="Conductor" v={names[expense.driver_id] || '—'} />
            <Dt k="Categoría" v={catLabel[expense.expense_type] || expense.expense_type} />
            <Dt k="Comprobante" v={expense.document_type ? `${expense.document_type} ${expense.document_series || ''}-${expense.document_number || ''}` : '—'} />
            <Dt k="Proveedor" v={[expense.provider_ruc, expense.provider_name].filter(Boolean).join(' · ') || '—'} />
            {expense.expense_type === 'COMBUSTIBLE' && <>
              <Dt k="Galones / Odómetro" v={expense.fuel_gallons ? `${expense.fuel_gallons} gal · ${Number(expense.fuel_odometer || 0).toLocaleString('es-PE')} km` : 'Sin datos'} />
              <Dt k="Precio por galón" v={expense.fuel_gallons ? money(Number(expense.amount) / Number(expense.fuel_gallons)) : '—'} />
            </>}
            <Dt k="Refacturable" v={expense.is_billable ? 'Sí, al cliente' : 'No'} />
            <Dt k="Descripción" v={expense.description || '—'} />
          </dl>

          {trip && (
            <div className="bg-slate-50 border rounded-lg p-3 grid grid-cols-3 gap-2 text-xs">
              <div><div className="text-slate-500">Gastos del viaje</div><b>{trip.count}</b></div>
              <div><div className="text-slate-500">Declarado</div><b>{money(trip.declared)}</b></div>
              <div><div className="text-slate-500">Aprobado</div><b>{money(trip.approved)}</b></div>
            </div>
          )}

          {al.length > 0 && (
            <div className="space-y-1">
              {al.map(a => (
                <div key={a.code} className={`flex items-start gap-2 p-2 rounded-lg text-xs ${a.level === 'ALTA' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'}`}>
                  <AlertTriangle className="w-4 h-4 shrink-0" /><span><b>{a.level === 'ALTA' ? 'Alta' : 'Media'}:</b> {a.message}</span>
                </div>
              ))}
            </div>
          )}

          {expense.review_comment && <div className="bg-blue-50 text-blue-900 text-xs p-2 rounded-lg"><b>Último comentario de revisión:</b> {expense.review_comment}</div>}

          <div>
            <div className="text-[10px] font-bold uppercase text-slate-500 mb-1">Historial</div>
            <ol className="border-l-2 border-slate-200 pl-3 space-y-1.5 max-h-40 overflow-auto">
              {events.map(ev => (
                <li key={ev.id} className="text-xs">
                  <b>{ev.action.replace('_', ' ')}</b> · {fmtDate(ev.created_at, true)} · {names[ev.actor_id] || 'Sistema'}
                  {ev.amount != null && <> · {money(ev.amount)}</>}
                  {ev.comment && <div className="text-slate-500">“{ev.comment}”</div>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <div className="border-t mt-5 pt-4 space-y-3">
        {own && <p className="text-xs text-amber-700 bg-amber-50 p-2 rounded-lg">Este gasto lo registró usted: debe revisarlo otro aprobador o el Administrador.</p>}
        <div className="flex flex-wrap gap-2">
          {expense.status === 'PENDIENTE' && !own && <>
            <ActionBtn active={action === 'APROBAR'} onClick={() => setAction('APROBAR')} cls="bg-emerald-600" icon={<CheckCircle2 className="w-4 h-4" />}>Aprobar</ActionBtn>
            <ActionBtn active={action === 'OBSERVAR'} onClick={() => setAction('OBSERVAR')} cls="bg-amber-500" icon={<AlertTriangle className="w-4 h-4" />}>Observar</ActionBtn>
          </>}
          {['PENDIENTE', 'OBSERVADO'].includes(expense.status) && !own && (
            <ActionBtn active={action === 'RECHAZAR'} onClick={() => setAction('RECHAZAR')} cls="bg-red-600" icon={<XCircle className="w-4 h-4" />}>Rechazar</ActionBtn>
          )}
          {['APROBADO', 'RECHAZADO'].includes(expense.status) && isAdmin && !own && (
            <ActionBtn active={action === 'REVERTIR'} onClick={() => setAction('REVERTIR')} cls="bg-slate-700" icon={<RotateCcw className="w-4 h-4" />}>Revertir</ActionBtn>
          )}
          {expense.dispatch_id && <Link href="/caja/liquidaciones" className="ml-auto text-xs text-blue-600 hover:underline self-center">Ver liquidación del viaje</Link>}
        </div>

        {action && (
          <div className="bg-slate-50 border rounded-xl p-3 space-y-2 text-sm">
            {action === 'APROBAR' && (
              <label className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-600">Monto a aprobar (S/)</span>
                <input type="number" step="0.01" min="0.01" max={expense.amount} value={amount} onChange={e => setAmount(e.target.value)} className="border rounded-lg px-2 py-1 w-32 font-bold" />
                <span className="text-xs text-slate-500">Comprobante: {money(expense.amount)}. Si aprueba menos, indique el motivo.</span>
              </label>
            )}
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} className="w-full border rounded-lg p-2"
              placeholder={needsComment ? 'Motivo (obligatorio)' : 'Comentario (opcional)'} />
            {action === 'APROBAR' && al.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-red-700"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />Revisé las alertas y apruebo igual</label>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setAction(null)} className="px-3 py-2 rounded-lg hover:bg-slate-200">Cancelar</button>
              <button disabled={busy || (needsComment && !comment.trim()) || (action === 'APROBAR' && al.length > 0 && !ack)} onClick={submit}
                className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}Confirmar
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function Dt({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><dt className="text-[10px] font-bold uppercase text-slate-400">{k}</dt><dd className="text-slate-800 break-words">{v || '—'}</dd></div>
}

function ActionBtn({ active, onClick, cls, icon, children }: { active: boolean; onClick: () => void; cls: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`px-3 py-2 rounded-lg text-white text-sm font-semibold flex items-center gap-1.5 ${cls} ${active ? 'ring-2 ring-offset-2 ring-slate-400' : 'opacity-90 hover:opacity-100'}`}>
      {icon}{children}
    </button>
  )
}
