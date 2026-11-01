'use client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle, CheckCircle2, Clock, Eye, FileText, Loader2, RefreshCw, Search, ShieldAlert,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { ExpenseReview } from '@/components/caja/ExpenseReview'
import {
  EXPENSE_STATUS, alertsOf, errorMessage, fmtDate, loadCategories, money, rpcOk,
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
    <div className="space-y-3">
      <PageHeader showTitle title="Aprobación de gastos" description={<>
            Gastos de la app del conductor y de Caja web. Solo lo aprobado pasa al costo del viaje y al TCO de la unidad.
            {settings?.double_approval_threshold && <> Montos desde <b>{money(settings.double_approval_threshold)}</b> requieren confirmación del Administrador.</>}
          </>}
        actions={<button onClick={() => load(filters)} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2 hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>} />

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

