'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, Banknote, Camera, CheckCircle2, Clock, Loader2, Receipt, Send, Truck, Wrench, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useActiveTrip } from '@/contexts/ActiveTripContext'
import { AdvanceRequestCard } from '@/components/driver/AdvanceRequestCard'
import {
  CHARGE_TO, errorMessage, fmtDate, loadAdvanceReasons, loadCategories, uploadDriverFile,
  type AdvanceReason, type ExpenseCategory, type Row,
} from '@/lib/caja'

// Anticipos del conductor (Caja C4/C5). Con ruta: viáticos del viaje. Con o sin ruta: anticipos por la
// unidad o por otro motivo (neumático, mecánica de emergencia, trámites…), que se aprueban, rinden y
// liquidan por sí mismos. Las reglas de cada motivo vienen del catálogo advance_reasons.

const OPEN_STATUSES = ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO']
const soles = (n: unknown) => `S/ ${Number(n || 0).toFixed(2)}`

function statusOf(a: Row): { label: string; cls: string } {
  if (a.status === 'SOLICITADO') return a.awaiting_approval
    ? { label: 'Por aprobar', cls: 'bg-amber-100 text-amber-800' } : { label: 'Por entregar', cls: 'bg-blue-100 text-blue-800' }
  if (a.status === 'ENTREGADO') return a.overdue
    ? { label: 'Rendición vencida', cls: 'bg-red-100 text-red-700' } : { label: 'Por rendir', cls: 'bg-emerald-100 text-emerald-700' }
  if (a.status === 'RENDIDO') return { label: 'Liquidado', cls: 'bg-slate-100 text-slate-600' }
  return { label: 'Anulado', cls: 'bg-red-50 text-red-700' }
}

export default function DriverAdvancesPage() {
  const supabase = useMemo(() => createClient(), [])
  const { user, driver, trip, loading } = useActiveTrip()
  const [spent, setSpent] = useState(0)
  const [reasons, setReasons] = useState<AdvanceReason[]>([])
  const [advances, setAdvances] = useState<Row[]>([])
  const [requesting, setRequesting] = useState(false)
  const [rendering, setRendering] = useState<Row | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('vw_caja_advances').select('*').is('dispatch_id', null)
      .order('requested_at', { ascending: false }).limit(30)
    setAdvances(data || [])
  }, [supabase])

  useEffect(() => {
    void loadAdvanceReasons(supabase).then(r => setReasons(r.filter(x => !x.requires_trip)))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [supabase, load])

  useEffect(() => {
    if (!driver?.id) return
    const channel = supabase.channel(`unit-advances-${driver.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_advances', filter: `driver_id=eq.${driver.id}` }, () => void load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [supabase, driver?.id, load])

  useEffect(() => {
    if (!trip) return
    void supabase.from('dispatch_expenses').select('amount, status, paid_by').eq('dispatch_id', trip.id)
      .then(({ data }) => setSpent((data || [])
        .filter(e => e.status !== 'RECHAZADO' && e.paid_by !== 'EMPRESA' && e.paid_by !== 'CAJA')
        .reduce((s, e) => s + Number(e.amount), 0)))
  }, [supabase, trip])

  const withdraw = async (a: Row) => {
    const { data, error } = await supabase.rpc('withdraw_trip_advance_request', { p_advance_id: a.id })
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo retirar')
    toast.success('Solicitud retirada'); void load()
  }
  const acknowledge = async (a: Row) => {
    const { data, error } = await supabase.rpc('acknowledge_advance_settlement', { p_advance_id: a.id })
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo registrar')
    toast.success('Conformidad registrada'); void load()
  }

  if (loading && !user) return <div className="flex min-h-[55vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#002855]" /></div>

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-black text-[#002855]"><Banknote className="h-6 w-6" />Anticipos</h1>
        <p className="mt-0.5 text-xs text-slate-500">Dinero a rendir: viáticos de tu ruta o anticipos por la unidad (neumático, mecánica, trámites) aunque no tengas ruta.</p>
      </div>

      {trip ? (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1 text-sm font-black text-slate-800"><Truck className="h-4 w-4" />Viáticos de tu ruta · {trip.dispatch_number}</h2>
          <AdvanceRequestCard dispatchId={trip.id} spent={spent} canRequest={OPEN_STATUSES.includes(trip.status)} />
          <Link href="/app/gastos" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-[#002855]"><Receipt className="h-4 w-4" />Registrar gastos del viaje</Link>
        </section>
      ) : (
        <p className="rounded-xl bg-slate-100 p-3 text-xs text-slate-600">Sin ruta asignada: los viáticos de viaje se piden cuando despacho te asigne una ruta. Los anticipos por la unidad puedes pedirlos ahora.</p>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1 text-sm font-black text-slate-800"><Wrench className="h-4 w-4" />Por la unidad u otro motivo</h2>
          {!requesting && <button onClick={() => setRequesting(true)} className="rounded-xl bg-[#002855] px-3 py-2 text-xs font-bold text-white">Solicitar anticipo</button>}
        </div>
        {requesting && user && (
          <RequestForm reasons={reasons} userId={user.id} tripId={trip?.id || null} defaultPlate={trip?.vehicle_plate || ''}
            onClose={() => setRequesting(false)} onDone={() => { setRequesting(false); void load() }} />
        )}
        {advances.length === 0 && !requesting && <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">No tienes anticipos por la unidad.</p>}
        {advances.map(a => {
          const st = statusOf(a)
          const remaining = Number(a.amount) - Number(a.rendered)
          return (
            <div key={a.id} className="rounded-2xl border border-slate-200 bg-white p-3 text-xs shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-black text-[#002855]">{a.code} · {soles(a.amount)}</p>
                  <p className="font-semibold text-slate-700">{a.reason_label}{a.vehicle_plate ? ` · ${a.vehicle_plate}` : ''}</p>
                  {a.reason && <p className="text-slate-500">“{a.reason}”</p>}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>{st.label}</span>
              </div>
              {a.status === 'SOLICITADO' && a.awaiting_approval && <p className="mt-1 text-amber-800">Espera la aprobación del Jefe de Distribución.</p>}
              {a.overdue_flag && a.status === 'SOLICITADO' && <p className="mt-1 text-red-700">Emergencia con rendiciones pendientes ({a.overdue_flag}).</p>}
              {a.status === 'ANULADO' && a.cancel_reason && <p className="mt-1 text-red-700">{a.cancel_reason}</p>}
              {a.status === 'ENTREGADO' && (
                <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-slate-50 p-2 text-center">
                  <div><p className="text-[9px] font-bold uppercase text-slate-500">Recibido</p><p className="font-black">{soles(a.amount)}</p></div>
                  <div><p className="text-[9px] font-bold uppercase text-slate-500">Rendido</p><p className="font-black">{soles(a.rendered)}</p></div>
                  <div><p className="text-[9px] font-bold uppercase text-slate-500">{remaining >= 0 ? 'Te queda' : 'A tu favor'}</p><p className="font-black">{soles(Math.abs(remaining))}</p></div>
                </div>
              )}
              {a.status === 'ENTREGADO' && a.due_at && (
                <p className={`mt-1 flex items-center gap-1 ${a.overdue ? 'font-bold text-red-700' : 'text-slate-500'}`}><Clock className="h-3 w-3" />Rendir hasta {fmtDate(a.due_at, true)}</p>
              )}
              {a.status === 'RENDIDO' && a.settlement_code && (
                <p className="mt-1 text-slate-600">Liquidación {a.settlement_code}{Number(a.settlement_balance) > 0 ? ` · devolviste ${soles(a.settlement_balance)}` : Number(a.settlement_balance) < 0 ? ` · se te reembolsa ${soles(Math.abs(a.settlement_balance))}` : ''}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {a.status === 'ENTREGADO' && <button onClick={() => setRendering(a)} className="flex-1 rounded-xl bg-[#002855] py-2 font-bold text-white"><Receipt className="mr-1 inline h-3 w-3" />Rendir gasto</button>}
                {a.status === 'SOLICITADO' && a.source === 'APP' && <button onClick={() => withdraw(a)} className="flex-1 rounded-xl border py-2 font-bold text-slate-600"><X className="mr-1 inline h-3 w-3" />Retirar solicitud</button>}
                {a.settlement_status === 'CERRADA' && !a.driver_ack_at && <button onClick={() => acknowledge(a)} className="flex-1 rounded-xl bg-emerald-600 py-2 font-bold text-white"><CheckCircle2 className="mr-1 inline h-3 w-3" />Dar conformidad</button>}
              </div>
              {rendering?.id === a.id && user && (
                <RenderForm advance={a} userId={user.id} onClose={() => setRendering(null)} onDone={() => { setRendering(null); void load() }} />
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}

function RequestForm({ reasons, userId, tripId, defaultPlate, onClose, onDone }: {
  reasons: AdvanceReason[]; userId: string; tripId: string | null; defaultPlate: string; onClose: () => void; onDone: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [code, setCode] = useState('')
  const [plate, setPlate] = useState(defaultPlate)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [odometer, setOdometer] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  const r = reasons.find(x => x.code === code)

  const send = async () => {
    if (!r) return toast.error('Elige el motivo')
    if (!(Number(amount) > 0)) return toast.error('Ingresa el monto que necesitas')
    if (!reason.trim()) return toast.error('Cuenta para qué es el anticipo')
    if (r.evidence_required && !file) return toast.error('Adjunta una foto de evidencia')
    setSending(true)
    let path: string | null = null
    try {
      if (file) path = await uploadDriverFile(supabase, userId, 'anticipos', file)
      const { data, error } = await supabase.rpc('request_advance_from_app', {
        p_reason_code: r.code, p_amount: Number(amount), p_reason: reason.trim(), p_dispatch_id: tripId,
        p_vehicle_plate: r.charge_to === 'UNIDAD' ? plate.trim().toUpperCase() || null : null, p_evidence_url: path,
        p_odometer: odometer ? Number(odometer) : null,
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'No se pudo enviar')
      toast.success(`Solicitud ${data.code} enviada${data.needs_approval ? ': espera la aprobación del Jefe de Distribución' : ' a Caja'}`)
      onDone()
    } catch (e) {
      if (path) await supabase.storage.from('driver_evidence').remove([path])
      toast.error(errorMessage(e))
    } finally { setSending(false) }
  }

  return (
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <label className="block">
        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Motivo</span>
        <select value={code} onChange={e => setCode(e.target.value)} className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-3 text-sm font-semibold">
          <option value="">Elige…</option>
          {reasons.map(x => <option key={x.code} value={x.code}>{x.label}</option>)}
        </select>
      </label>
      {r && (
        <div className="rounded-xl bg-white p-2 text-[11px] text-slate-600">
          {r.description && <p>{r.description}</p>}
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-semibold">
            <span>Se carga a: {CHARGE_TO[r.charge_to]}</span>
            <span>{r.approval_by === 'JEFE' ? 'Aprueba el Jefe de Distribución' : 'Lo atiende Caja'}</span>
            {r.max_amount && <span>Hasta {soles(r.max_amount)} sin aprobación extra</span>}
            {r.settlement_due_hours && <span>Rendir en {r.settlement_due_hours} h</span>}
          </p>
          {r.is_emergency && <p className="mt-1 flex items-center gap-1 text-red-700"><AlertTriangle className="h-3 w-3" />Emergencia: se atiende aunque tengas rendiciones pendientes.</p>}
          {r.creates_failure && <p className="mt-1 text-slate-500">Se reporta la falla a Mantenimiento automáticamente.</p>}
        </div>
      )}
      {r?.charge_to === 'UNIDAD' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className="mb-1 block text-[10px] font-bold uppercase text-slate-500">Placa</span>
            <input value={plate} onChange={e => setPlate(e.target.value)} placeholder="Tu última unidad" className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2.5 text-sm font-bold uppercase" /></label>
          {r.creates_failure && <label className="block"><span className="mb-1 block text-[10px] font-bold uppercase text-slate-500">Odómetro (opcional)</span>
            <input type="number" inputMode="numeric" value={odometer} onChange={e => setOdometer(e.target.value)} className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2.5 text-sm" /></label>}
        </div>
      )}
      <label className="block"><span className="mb-1 block text-[10px] font-bold uppercase text-slate-500">Monto que necesitas (S/)</span>
        <input type="number" step="0.01" min="0" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-3 font-bold" /></label>
      <label className="block"><span className="mb-1 block text-[10px] font-bold uppercase text-slate-500">¿Qué pasó / para qué es?</span>
        <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Ej. Pinchazo llanta posterior derecha en km 120" className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm" /></label>
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white p-3 text-sm font-semibold text-slate-600">
        <Camera className="h-5 w-5" />{file ? file.name : `Foto de evidencia${r?.evidence_required ? ' (obligatoria)' : ' (opcional)'}`}
        <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
      </label>
      <div className="flex gap-2 pt-1">
        <button onClick={onClose} className="flex-1 rounded-xl border bg-white py-2.5 text-xs font-bold text-slate-600">Cancelar</button>
        <button disabled={sending} onClick={send} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-[#002855] py-2.5 text-xs font-bold text-white disabled:opacity-50">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Enviar solicitud
        </button>
      </div>
    </div>
  )
}

function RenderForm({ advance, userId, onClose, onDone }: { advance: Row; userId: string; onClose: () => void; onDone: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [cats, setCats] = useState<ExpenseCategory[]>([])
  const [type, setType] = useState<string>(advance.default_expense_type || '')
  const [amount, setAmount] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => { void loadCategories(supabase).then(setCats) }, [supabase])
  const cat = cats.find(c => c.code === type)

  const send = async () => {
    if (!type) return toast.error('Elige el tipo de gasto')
    if (!(Number(amount) > 0)) return toast.error('Ingresa el importe')
    if (cat?.requires_receipt && !file) return toast.error('Adjunta la foto del comprobante')
    setSending(true)
    let path: string | null = null
    try {
      if (file) path = await uploadDriverFile(supabase, userId, `anticipos/${advance.id}`, file)
      const { data, error } = await supabase.rpc('register_advance_expense', {
        p_advance_id: advance.id, p_expense_type: type, p_amount: Number(amount), p_receipt_url: path,
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'No se pudo registrar')
      toast.success('Gasto enviado a revisión')
      onDone()
    } catch (e) {
      if (path) await supabase.storage.from('driver_evidence').remove([path])
      toast.error(errorMessage(e))
    } finally { setSending(false) }
  }

  return (
    <div className="mt-2 space-y-2 rounded-xl bg-slate-50 p-2">
      <select value={type} onChange={e => setType(e.target.value)} className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold">
        <option value="">Tipo de gasto…</option>
        {cats.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
      </select>
      <input type="number" step="0.01" min="0" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Importe S/"
        className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2.5 text-sm font-bold" />
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white p-2.5 text-xs font-semibold text-slate-600">
        <Camera className="h-4 w-4" />{file ? file.name : 'Foto del comprobante'}
        <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
      </label>
      <div className="flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-xl border bg-white py-2 text-xs font-bold text-slate-600">Cancelar</button>
        <button disabled={sending} onClick={send} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-emerald-600 py-2 text-xs font-bold text-white disabled:opacity-50">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Enviar gasto
        </button>
      </div>
    </div>
  )
}
