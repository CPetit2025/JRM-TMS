'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, FileText, Loader2, RotateCcw, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'
import { EXPENSE_STATUS, alertsOf, errorMessage, fmtDate, isPdf, loadCategories, money, receiptUrl, rpcOk, type Row } from '@/lib/caja'

// Revisión de un gasto de Caja (aprobar, observar, rechazar, revertir) por review_dispatch_expense. La usan la bandeja de
// Aprobaciones y el detalle del despacho en Torre de Control (gastos del viaje, sin salir de la ventana).
const supabase = createClient()

type Action = 'APROBAR' | 'OBSERVAR' | 'RECHAZAR' | 'REVERTIR'

export function ExpenseReview({ expense, people, catLabel, isAdmin, me, tripLink = true, onClose, onDone }: {
  expense: Row; tripLink?: boolean; people: Record<string, string>; catLabel: Record<string, string>; isAdmin: boolean; me: string | null
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
          {tripLink && expense.dispatch_id && <Link href="/caja/liquidaciones" className="ml-auto text-xs text-blue-600 hover:underline self-center">Ver liquidación del viaje</Link>}
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

/** Gastos de Caja de un viaje con su revisión: solo quien tiene caja-aprobacion revisa (la base también lo exige). */
export function TripExpenses({ dispatchId, onClose, onChanged }: { dispatchId: string; onClose: () => void; onChanged?: () => void }) {
  const { hasAccess, role } = usePermissions()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [catLabel, setCatLabel] = useState<Record<string, string>>({})
  const [me, setMe] = useState<string | null>(null)
  const [open, setOpen] = useState<Row | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let alive = true
    void (async () => {
      const [{ data, error }, cats, user] = await Promise.all([
        supabase.from('dispatch_expenses').select('*, dispatch:dispatches(id, dispatch_number, vehicle_plate, status)').eq('dispatch_id', dispatchId).order('expense_date', { ascending: false }),
        loadCategories(supabase), supabase.auth.getUser()])
      if (!alive) return
      if (error) toast.error(errorMessage(error))
      setRows(data || []); setCatLabel(Object.fromEntries(cats.map(c => [c.code, c.label]))); setMe(user.data.user?.id || null)
    })()
    return () => { alive = false }
  }, [dispatchId, reload])
  const canReview = hasAccess('caja-aprobacion')
  return <Modal isOpen onClose={onClose} title="Gastos de Caja del viaje" maxWidth="max-w-3xl">
    {!rows ? <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando gastos…</p>
      : !rows.length ? <p className="text-sm text-slate-500">El viaje no tiene gastos de Caja.</p>
      : <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{rows.map(e => { const st = EXPENSE_STATUS[e.status] || { label: e.status, cls: '' }
        return <li key={e.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="min-w-0 flex-1"><b>{catLabel[e.expense_type] || e.expense_type}</b> · {money(e.approved_amount ?? e.amount)}<span className="block text-xs text-slate-500">{fmtDate(e.expense_date)}{e.description ? ` · ${e.description}` : ''}</span></span>
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${st.cls}`}>{st.label}</span>
          <button type="button" onClick={() => setOpen(e)} className="min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-[#002855] hover:bg-slate-50">{canReview ? 'Revisar' : 'Ver'}</button>
        </li> })}</ul>}
    {!canReview && rows?.some(e => e.status === 'PENDIENTE') && <p className="mt-2 text-xs text-slate-500">Los gastos pendientes los aprueba el Administrador o el Jefe de Distribución (permiso de aprobación de Caja).</p>}
    {open && <ExpenseReview expense={open} tripLink={false} people={{}} catLabel={catLabel} isAdmin={role === 'admin'} me={me} onClose={() => setOpen(null)}
      onDone={() => { setOpen(null); setReload(n => n + 1); onChanged?.() }} />}
  </Modal>
}
