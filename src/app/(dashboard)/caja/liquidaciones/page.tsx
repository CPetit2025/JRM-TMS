'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, FileCheck2, Loader2, Printer, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'
import { EvidenceGallery } from '@/components/evidence/EvidenceGallery'
import { EXPENSE_STATUS, PAYMENT_METHODS, errorMessage, fmtDate, money, printCaja, rpcOk, type Row } from '@/lib/caja'

// Liquidación financiera del viaje (Caja C2): anticipos − gastos aprobados pagados por el conductor = saldo.
// No cambia el estado operativo del despacho (LIQUIDADO lo pone el cierre de ruta GPS).

const supabase = createClient()
const RESOLUTION: Record<string, string> = {
  DEVOLUCION: 'Devolución del conductor', REEMBOLSO: 'Reembolso al conductor', DESCUENTO_PLANILLA: 'Descuento por planilla', SIN_SALDO: 'Sin saldo',
}
const VIEWS = [['POR_LIQUIDAR', 'Por liquidar'], ['VENCIDAS', 'Vencidas'], ['EN_CURSO', 'En curso'], ['LIQUIDADAS', 'Liquidadas'], ['TODAS', 'Todas']] as const

export default function LiquidacionesPage() {
  const { canWrite, role } = usePermissions()
  const [rows, setRows] = useState<Row[]>([])
  const [people, setPeople] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<string>('POR_LIQUIDAR')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Row | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const since = new Date(Date.now() - 120 * 864e5).toISOString()
    const { data, error } = await supabase.from('vw_caja_trip_status').select('*').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(1000)
    if (error) toast.error('Error al cargar viajes: ' + error.message)
    const list = (data || []).filter(r => r.advances_delivered > 0 || r.expenses_count > 0 || r.settlement_id)
    setRows(list)
    const ids = [...new Set(list.map(r => r.driver_id).filter(Boolean))]
    if (ids.length) {
      const { data: ppl } = await supabase.from('vw_caja_people').select('id, full_name').in('id', ids)
      setPeople(Object.fromEntries((ppl || []).map(p => [p.id, p.full_name])))
    }
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const counts = useMemo(() => ({
    POR_LIQUIDAR: rows.filter(r => r.trip_finished && r.settlement_status !== 'CERRADA').length,
    VENCIDAS: rows.filter(r => r.overdue).length,
    EN_CURSO: rows.filter(r => !r.trip_finished).length,
    LIQUIDADAS: rows.filter(r => r.settlement_status === 'CERRADA').length,
    TODAS: rows.length,
  }), [rows])
  const visible = useMemo(() => rows.filter(r => {
    if (view === 'POR_LIQUIDAR' && !(r.trip_finished && r.settlement_status !== 'CERRADA')) return false
    if (view === 'VENCIDAS' && !r.overdue) return false
    if (view === 'EN_CURSO' && r.trip_finished) return false
    if (view === 'LIQUIDADAS' && r.settlement_status !== 'CERRADA') return false
    const s = q.trim().toLowerCase()
    return !s || [r.dispatch_number, r.vehicle_plate, people[r.driver_id]].some(v => String(v || '').toLowerCase().includes(s))
  }), [rows, view, q, people])

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><FileCheck2 className="w-6 h-6" />Liquidación de viajes</h1>
          <p className="text-sm text-slate-500">Cuadre de anticipos contra gastos aprobados y cierre con devolución, reembolso o descuento por planilla. La aprobación de cada gasto se hace en <Link href="/caja/aprobaciones" className="text-blue-600 hover:underline">Aprobación de gastos</Link>.</p>
        </div>
        <button onClick={load} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2 hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className={`px-3 py-1.5 rounded-full text-sm border ${view === k ? 'bg-[#002855] text-white border-[#002855]' : 'bg-white hover:bg-slate-50'} ${k === 'VENCIDAS' && counts.VENCIDAS > 0 && view !== k ? 'border-red-300 text-red-700' : ''}`}>
            {l} <span className="opacity-70">({counts[k as keyof typeof counts]})</span>
          </button>
        ))}
        <div className="relative ml-auto">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Despacho, placa o conductor" className="border rounded-lg pl-7 pr-2 py-2 text-sm w-64" />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-auto max-h-[calc(100vh-280px)]">
        {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 sticky top-0"><tr>
              <th className="p-3 text-left">Despacho / Placa</th><th className="p-3 text-left">Conductor</th><th className="p-3 text-left">Viaje</th>
              <th className="p-3 text-right">Anticipos</th><th className="p-3 text-right">Gastos conductor</th><th className="p-3 text-right">Pagado por caja/empresa</th>
              <th className="p-3 text-right">Saldo</th><th className="p-3 text-left">Pendientes</th><th className="p-3 text-left">Liquidación</th><th className="p-3" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {visible.length === 0 && <tr><td colSpan={10} className="p-10 text-center text-slate-400">No hay viajes en esta vista</td></tr>}
              {visible.map(r => (
                <tr key={r.dispatch_id} className="hover:bg-slate-50">
                  <td className="p-3"><div className="font-semibold text-[#002855]">{r.dispatch_number}</div><div className="text-xs text-slate-500">{r.vehicle_plate}</div></td>
                  <td className="p-3">{people[r.driver_id] || '—'}</td>
                  <td className="p-3 text-xs">{r.dispatch_status}<div className="text-slate-500">{r.returned_at ? `Retorno ${fmtDate(r.returned_at)}` : fmtDate(r.departure_at)}</div></td>
                  <td className="p-3 text-right">{money(r.advances_delivered)}{r.advances_requested_count > 0 && <div className="text-[10px] text-amber-700">+{money(r.advances_requested)} por entregar</div>}</td>
                  <td className="p-3 text-right">{money(r.driver_approved)}{r.driver_pending > 0 && <div className="text-[10px] text-slate-500">+{money(r.driver_pending)} por aprobar</div>}</td>
                  <td className="p-3 text-right">{money(r.company_approved)}</td>
                  <td className={`p-3 text-right font-bold ${r.balance > 0 ? 'text-amber-700' : r.balance < 0 ? 'text-blue-700' : 'text-slate-500'}`}>
                    {money(Math.abs(r.balance))}<div className="text-[10px] font-normal">{r.balance > 0 ? 'devuelve el conductor' : r.balance < 0 ? 'se reembolsa' : ''}</div>
                  </td>
                  <td className="p-3 text-xs">
                    {r.pending_count > 0 && <div>{r.pending_count} por aprobar</div>}
                    {r.observed_count > 0 && <div className="text-amber-700">{r.observed_count} observados</div>}
                    {r.pending_count + r.observed_count === 0 && <span className="text-slate-400">—</span>}
                  </td>
                  <td className="p-3 text-xs">
                    {r.settlement_status === 'CERRADA'
                      ? <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">{r.settlement_code}</span>
                      : r.overdue ? <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-semibold">Vencida</span>
                      : r.settlement_status === 'REABIERTA' ? <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">Reabierta</span>
                      : <span className="text-slate-400">Abierta</span>}
                    {r.driver_ack_at && <div className="text-emerald-700 mt-0.5">Conforme el conductor</div>}
                  </td>
                  <td className="p-3"><button onClick={() => setOpen(r)} className="text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100">{r.settlement_status === 'CERRADA' ? 'Ver' : 'Liquidar'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && <SettlementModal trip={open} driverName={people[open.driver_id]} canClose={canWrite('caja-liquidaciones')} isAdmin={role === 'admin'}
        onClose={() => setOpen(null)} onDone={() => { setOpen(null); void load() }} />}
    </div>
  )
}

function SettlementModal({ trip, driverName, canClose, isAdmin, onClose, onDone }: {
  trip: Row; driverName?: string; canClose: boolean; isAdmin: boolean; onClose: () => void; onDone: () => void
}) {
  const [preview, setPreview] = useState<Row | null>(null)
  const [expenses, setExpenses] = useState<Row[]>([])
  const [advances, setAdvances] = useState<Row[]>([])
  const [settlement, setSettlement] = useState<Row | null>(null)
  const [boxes, setBoxes] = useState<Row[]>([])
  const [cats, setCats] = useState<Record<string, string>>({})
  const [form, setForm] = useState({ resolution: '', box_id: '', method: 'EFECTIVO', reference: '', notes: '' })
  const [reopenReason, setReopenReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [p, e, a, s, b, c] = await Promise.all([
      supabase.rpc('preview_trip_settlement', { p_dispatch_id: trip.dispatch_id }),
      supabase.from('dispatch_expenses').select('*').eq('dispatch_id', trip.dispatch_id).order('expense_date'),
      supabase.from('trip_advances').select('*').eq('dispatch_id', trip.dispatch_id).order('requested_at'),
      supabase.from('trip_settlements').select('*').eq('dispatch_id', trip.dispatch_id).maybeSingle(),
      supabase.from('vw_cash_box_balances').select('box_id, name, balance').eq('is_active', true).order('name'),
      supabase.from('expense_categories').select('code, label'),
    ])
    setPreview(p.data); setExpenses(e.data || []); setAdvances(a.data || []); setSettlement(s.data); setBoxes(b.data || [])
    setCats(Object.fromEntries((c.data || []).map(x => [x.code, x.label])))
    setForm(f => ({ ...f, resolution: p.data?.suggested_resolution || '' }))
  }, [trip.dispatch_id])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const closed = settlement?.status === 'CERRADA'
  const balance = Number(closed ? settlement?.balance : preview?.balance || 0)
  const blocking: string[] = preview?.blocking || []
  const needsBox = form.resolution === 'DEVOLUCION' || form.resolution === 'REEMBOLSO'

  const close = async () => {
    setBusy(true)
    try {
      await rpcOk(supabase, 'close_trip_settlement', {
        p_dispatch_id: trip.dispatch_id, p_resolution: form.resolution, p_box_id: needsBox ? form.box_id : null,
        p_payment_method: needsBox ? form.method : null, p_reference: form.reference || null, p_notes: form.notes || null,
      })
      toast.success('Viaje liquidado')
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const reopen = async () => {
    setBusy(true)
    try {
      await rpcOk(supabase, 'reopen_trip_settlement', { p_dispatch_id: trip.dispatch_id, p_reason: reopenReason })
      toast.success('Liquidación reabierta: el movimiento de caja se revirtió')
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Liquidación ${settlement?.code || ''} · ${trip.dispatch_number}`} maxWidth="max-w-5xl">
      {!preview ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
        <div className="space-y-5 text-sm caja-printable">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Box label="Anticipos entregados" value={money(closed ? settlement?.advances_total : preview.advances_total)} />
            <Box label="Gastos aprobados del conductor" value={money(closed ? settlement?.driver_expenses : preview.driver_expenses)} />
            <Box label="Pagado por caja / empresa" value={money(closed ? settlement?.company_expenses : preview.company_expenses)} />
            <Box label={balance > 0 ? 'Saldo: devuelve el conductor' : balance < 0 ? 'Saldo: se reembolsa al conductor' : 'Saldo'} value={money(Math.abs(balance))}
              tone={balance > 0 ? 'amber' : balance < 0 ? 'blue' : undefined} />
          </div>
          <div className="text-xs text-slate-500 flex flex-wrap gap-x-6">
            <span>Conductor: <b className="text-slate-700">{driverName || '—'}</b></span>
            <span>Unidad: <b className="text-slate-700">{trip.vehicle_plate}</b></span>
            <span>Declarado: <b className="text-slate-700">{money(preview.declared_total)}</b></span>
            <span>Rechazado: <b className="text-slate-700">{money(preview.rejected_total)}</b></span>
            {preview.driver_declared != null && <span>Declarado en el retorno (app): <b className="text-slate-700">{money(preview.driver_declared)}</b></span>}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-bold uppercase text-slate-500 mb-1">Anticipos</h4>
              <table className="w-full text-xs border rounded-lg overflow-hidden">
                <tbody className="divide-y">
                  {advances.length === 0 && <tr><td className="p-2 text-slate-400">Sin anticipos</td></tr>}
                  {advances.map(a => <tr key={a.id}><td className="p-2">{a.code}</td><td className="p-2">{a.status}</td><td className="p-2">{a.payment_method || '—'}</td><td className="p-2 text-right font-semibold">{money(a.amount)}</td></tr>)}
                </tbody>
              </table>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase text-slate-500 mb-1">Gastos ({expenses.length})</h4>
              <div className="max-h-48 overflow-auto border rounded-lg">
                <table className="w-full text-xs">
                  <tbody className="divide-y">
                    {expenses.map(e => (
                      <tr key={e.id}>
                        <td className="p-2">{fmtDate(e.expense_date)}</td><td className="p-2">{cats[e.expense_type] || e.expense_type}</td>
                        <td className="p-2">{e.paid_by === 'CONDUCTOR' ? 'Conductor' : e.paid_by === 'CAJA' ? 'Caja' : 'Empresa'}</td>
                        <td className="p-2"><span className={`px-1.5 rounded ${EXPENSE_STATUS[e.status]?.cls}`}>{EXPENSE_STATUS[e.status]?.label}</span></td>
                        <td className="p-2 text-right font-semibold">{money(e.status === 'APROBADO' ? e.approved_amount ?? e.amount : e.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {closed ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-1">
              <div className="font-semibold text-emerald-800 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />Liquidado el {fmtDate(settlement?.closed_at, true)} · {RESOLUTION[settlement?.resolution]}</div>
              {settlement?.notes && <div className="text-emerald-900">Notas: {settlement.notes}</div>}
              <div className="text-emerald-900">{settlement?.driver_ack_at ? `Conformidad del conductor: ${fmtDate(settlement.driver_ack_at, true)}` : 'Pendiente de conformidad del conductor en la app.'}</div>
              <div className="print:hidden flex flex-wrap gap-2 pt-2">
                <button onClick={printCaja} className="px-3 py-2 border rounded-lg bg-white flex items-center gap-2"><Printer className="w-4 h-4" />Imprimir hoja</button>
                {isAdmin && (
                  <div className="flex gap-2 items-center">
                    <input value={reopenReason} onChange={e => setReopenReason(e.target.value)} placeholder="Motivo de reapertura" className="border rounded-lg px-2 py-2 w-64" />
                    <button disabled={busy || !reopenReason.trim()} onClick={reopen} className="px-3 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-2 disabled:opacity-50"><RotateCcw className="w-4 h-4" />Reabrir</button>
                  </div>
                )}
              </div>
              <div className="hidden print:grid grid-cols-2 gap-16 pt-16 text-center text-xs">
                <div className="border-t pt-1">Conductor: {driverName}</div><div className="border-t pt-1">Caja / Jefe de Distribución</div>
              </div>
            </div>
          ) : blocking.length > 0 ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="font-semibold text-amber-800 flex items-center gap-2 mb-1"><AlertTriangle className="w-4 h-4" />Aún no se puede liquidar</div>
              <ul className="list-disc pl-5 text-amber-900">{blocking.map(b => <li key={b}>{b}</li>)}</ul>
              <div className="flex gap-3 mt-2 text-xs">
                <Link href="/caja/aprobaciones" className="text-blue-700 hover:underline">Ir a aprobación de gastos</Link>
                <Link href="/caja/anticipos" className="text-blue-700 hover:underline">Ir a anticipos</Link>
              </div>
            </div>
          ) : canClose ? (
            <div className="bg-slate-50 border rounded-xl p-4 space-y-3 print:hidden">
              <div className="font-semibold text-slate-800">Cerrar liquidación</div>
              <div className="grid md:grid-cols-4 gap-3">
                <label className="block"><span className="text-xs font-bold text-slate-600">Resolución</span>
                  <select value={form.resolution} onChange={e => setForm({ ...form, resolution: e.target.value })} className="caja-input">
                    {balance > 0 && <><option value="DEVOLUCION">{RESOLUTION.DEVOLUCION}</option><option value="DESCUENTO_PLANILLA">{RESOLUTION.DESCUENTO_PLANILLA}</option></>}
                    {balance < 0 && <option value="REEMBOLSO">{RESOLUTION.REEMBOLSO}</option>}
                    {balance === 0 && <option value="SIN_SALDO">{RESOLUTION.SIN_SALDO}</option>}
                  </select>
                </label>
                {needsBox && <>
                  <label className="block"><span className="text-xs font-bold text-slate-600">Caja</span>
                    <select value={form.box_id} onChange={e => setForm({ ...form, box_id: e.target.value })} className="caja-input">
                      <option value="">Seleccione…</option>{boxes.map(b => <option key={b.box_id} value={b.box_id}>{b.name} · {money(b.balance)}</option>)}
                    </select>
                  </label>
                  <label className="block"><span className="text-xs font-bold text-slate-600">Forma de pago</span>
                    <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="caja-input">
                      {PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </label>
                  <label className="block"><span className="text-xs font-bold text-slate-600">Referencia</span>
                    <input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} className="caja-input" placeholder="N° operación / recibo" />
                  </label>
                </>}
              </div>
              <label className="block"><span className="text-xs font-bold text-slate-600">{form.resolution === 'DESCUENTO_PLANILLA' ? 'Autorización del descuento (obligatorio)' : 'Notas'}</span>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className="caja-input" />
              </label>
              <div className="flex justify-end">
                <button disabled={busy || (needsBox && !form.box_id) || (form.resolution === 'DESCUENTO_PLANILLA' && !form.notes.trim())} onClick={close}
                  className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}Liquidar viaje
                </button>
              </div>
            </div>
          ) : <p className="text-slate-500">Sin permiso para cerrar liquidaciones.</p>}
          <div className="border-t pt-4 print:hidden">
            <EvidenceGallery dispatchId={trip.dispatch_id} title="Evidencias del viaje (entregas, guías, comprobantes)" />
          </div>
        </div>
      )}
    </Modal>
  )
}

function Box({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'blue' }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === 'amber' ? 'bg-amber-50 border-amber-200' : tone === 'blue' ? 'bg-blue-50 border-blue-200' : 'bg-slate-50'}`}>
      <div className="text-[11px] text-slate-500">{label}</div><div className="text-lg font-bold text-slate-900">{value}</div>
    </div>
  )
}
