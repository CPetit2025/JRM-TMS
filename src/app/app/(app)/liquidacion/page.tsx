"use client"
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Camera, CheckCircle2, DollarSign, FileText, Loader2, Receipt, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

// Cierre de ruta del conductor: odómetro de llegada, guías selladas y total de gastos declarados
// (submit_post_route_checklist). Debajo, sus liquidaciones de caja para dar conformidad (Caja C2).

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const CLOSABLE = ['EN_CURSO', 'EN RUTA', 'RETORNO', 'ENTREGADO', 'RETORNO_COMPLETADO']
const money = (n: unknown) => `S/ ${Number(n || 0).toFixed(2)}`
const RESOLUTION: Record<string, string> = {
  DEVOLUCION: 'Devolviste el saldo en caja', REEMBOLSO: 'La empresa te reembolsa', DESCUENTO_PLANILLA: 'Descuento por planilla', SIN_SALDO: 'Sin saldo pendiente',
}

export default function LiquidacionPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { user, driver, trip, loading: contextLoading, refresh } = useActiveTrip()
  const [dispatch, setDispatch] = useState<Row | null>(null)
  const [expenses, setExpenses] = useState<Row[]>([])
  const [advances, setAdvances] = useState<Row[]>([])
  const [settlements, setSettlements] = useState<Row[]>([])
  const [odometer, setOdometer] = useState('')
  const [guias, setGuias] = useState<{ file: File; preview: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    if (!driver) return
    // Ruta pendiente de cierre: la del viaje activo si aún no envió el cierre, si no la más reciente
    const { data: open } = await supabase.from('dispatches').select('id, dispatch_number, vehicle_plate, status')
      .eq('driver_id', driver.id).in('status', CLOSABLE).is('liquidation_data', null).order('created_at', { ascending: false }).limit(5)
    const current: Row | null = (open || []).find(d => d.id === trip?.id) || open?.[0] || null
    setDispatch(current)
    const [e, a, s] = await Promise.all([
      current ? supabase.from('dispatch_expenses').select('id, expense_type, amount, approved_amount, status, paid_by').eq('dispatch_id', current.id) : Promise.resolve({ data: [] as Row[] }),
      current ? supabase.from('trip_advances').select('amount, status').eq('dispatch_id', current.id) : Promise.resolve({ data: [] as Row[] }),
      supabase.from('trip_settlements').select('*, dispatch:dispatches(dispatch_number, vehicle_plate)').eq('driver_id', driver.id).order('closed_at', { ascending: false }).limit(10),
    ])
    setExpenses(e.data || []); setAdvances(a.data || []); setSettlements(s.data || [])
    setLoading(false)
  }, [driver, trip, supabase])

  useEffect(() => {
    if (contextLoading) return
    if (!user) { router.push('/app'); return }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [contextLoading, user, router, load])

  const declared = expenses.filter(e => e.status !== 'RECHAZADO').reduce((s, e) => s + Number(e.amount), 0)
  const driverSpent = expenses.filter(e => e.status !== 'RECHAZADO' && e.paid_by === 'CONDUCTOR').reduce((s, e) => s + Number(e.status === 'APROBADO' ? e.approved_amount ?? e.amount : e.amount), 0)
  const advanced = advances.filter(a => ['ENTREGADO', 'RENDIDO'].includes(a.status)).reduce((s, a) => s + Number(a.amount), 0)

  const submit = async () => {
    if (!dispatch || !driver || !user) return
    if (!odometer || isNaN(Number(odometer))) return toast.error('Ingrese el odómetro de llegada')
    setSending(true)
    const uploaded: string[] = []
    try {
      for (const g of guias) {
        const path = `${user.id}/${dispatch.id}/guias/${crypto.randomUUID()}-${g.file.name.replace(/[^\w.-]/g, '')}`
        const { error } = await supabase.storage.from('driver_evidence').upload(path, g.file, { contentType: g.file.type })
        if (error) throw error
        uploaded.push(path)
      }
      const pos = await new Promise<GeolocationPosition | null>(resolve => navigator.geolocation
        ? navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { timeout: 5000 }) : resolve(null))
      const { data, error } = await supabase.rpc('submit_post_route_checklist', {
        p_dispatch_id: dispatch.id, p_vehicle_plate: dispatch.vehicle_plate, p_driver_id: driver.id, p_odometer: Number(odometer),
        p_liquidation_data: { guias: uploaded, total_expenses: declared, expenses_count: expenses.filter(e => e.status !== 'RECHAZADO').length, notas: 'Cerrado desde app conductor' },
        p_location: pos ? { lat: pos.coords.latitude, lon: pos.coords.longitude } : null,
      })
      if (error) throw error
      if (data && !data.success) throw new Error(data.message || 'No se pudo cerrar la ruta')
      toast.success('Cierre de ruta enviado. Caja revisará tus gastos y liquidará el viaje.')
      setGuias([]); setOdometer('')
      await refresh(); await load()
    } catch (e) {
      if (uploaded.length) await supabase.storage.from('driver_evidence').remove(uploaded)
      toast.error('Error al enviar: ' + (e instanceof Error ? e.message : String((e as Row)?.message || e)))
    } finally { setSending(false) }
  }

  const acknowledge = async (s: Row) => {
    const { data, error } = await supabase.rpc('acknowledge_trip_settlement', { p_dispatch_id: s.dispatch_id })
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo registrar')
    toast.success('Conformidad registrada')
    void load()
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[#002855]" /></div>

  return (
    <div className="min-h-full bg-slate-100 pb-6">
      <div className="bg-white border-b border-slate-200 px-4 py-4 mb-4">
        <h1 className="text-lg font-black text-[#002855]">Liquidación de ruta</h1>
        <p className="text-xs text-slate-500 mt-0.5">{dispatch ? `${dispatch.dispatch_number} • ${dispatch.vehicle_plate}` : 'Cierre de ruta y tus liquidaciones de caja'}</p>
      </div>
      <div className="px-4 max-w-md mx-auto space-y-4">
        {dispatch ? (
          <>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-3 gap-2 text-center">
              <div><p className="text-[10px] font-bold uppercase text-slate-500">Anticipo</p><p className="font-black text-[#002855]">{money(advanced)}</p></div>
              <div><p className="text-[10px] font-bold uppercase text-slate-500">Tus gastos</p><p className="font-black text-[#002855]">{money(driverSpent)}</p></div>
              <div><p className="text-[10px] font-bold uppercase text-slate-500">{advanced - driverSpent >= 0 ? 'Por devolver' : 'A tu favor'}</p><p className="font-black text-[#002855]">{money(Math.abs(advanced - driverSpent))}</p></div>
              <p className="col-span-3 text-[11px] text-slate-500">{expenses.length} gasto(s) registrados por {money(declared)}. El saldo final lo confirma Caja al liquidar.</p>
              <Link href="/app/gastos" className="col-span-3 text-xs font-bold text-blue-700 flex items-center justify-center gap-1"><Receipt className="w-3 h-3" />Registrar o corregir gastos</Link>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
              <h3 className="font-bold text-slate-800 text-sm">Cierre de ruta</h3>
              <label className="block">
                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Odómetro de llegada (km)</span>
                <input type="number" value={odometer} onChange={e => setOdometer(e.target.value)} className="w-full px-3 py-3 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none font-bold" />
              </label>
              <div>
                <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Guías selladas (GRT / GRR)</span>
                <div className="grid grid-cols-3 gap-2">
                  {guias.map((g, i) => (
                    <div key={g.preview} className="relative h-20 rounded-lg overflow-hidden border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={g.preview} alt="Guía" className="w-full h-full object-cover" />
                      <button onClick={() => setGuias(gs => gs.filter((_, j) => j !== i))} className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  ))}
                  <label className="h-20 border-2 border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center text-slate-500 text-[10px] font-bold cursor-pointer">
                    <Camera className="w-5 h-5 mb-1" />Agregar
                    <input type="file" accept="image/*" capture="environment" multiple className="hidden"
                      onChange={e => { const files = Array.from(e.target.files || []); setGuias(gs => [...gs, ...files.map(file => ({ file, preview: URL.createObjectURL(file) }))]) }} />
                  </label>
                </div>
              </div>
              <button disabled={sending} onClick={submit} className="w-full bg-gradient-to-r from-green-500 to-green-600 text-white py-4 rounded-2xl font-black shadow-lg active:scale-95 flex justify-center items-center gap-2 disabled:opacity-60">
                {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}Enviar cierre de ruta
              </button>
            </div>
          </>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
            <DollarSign className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No tienes una ruta pendiente de cierre.</p>
          </div>
        )}

        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2"><FileText className="w-4 h-4 text-slate-500" /><h3 className="font-bold text-slate-800 text-sm">Mis liquidaciones de caja</h3></div>
          {settlements.length === 0 ? <p className="p-4 text-xs text-slate-500">Aún no tienes viajes liquidados.</p> : (
            <div className="divide-y divide-slate-100">
              {settlements.map(s => (
                <div key={s.id} className="p-4 space-y-1">
                  <div className="flex justify-between text-sm"><b>{s.dispatch?.dispatch_number}</b><span className="text-xs text-slate-500">{s.code}</span></div>
                  <div className="text-xs text-slate-600">Anticipo {money(s.advances_total)} · Gastos aprobados {money(s.driver_expenses)}</div>
                  <div className="text-xs font-bold text-[#002855]">{RESOLUTION[s.resolution]}{Number(s.balance) !== 0 && `: ${money(Math.abs(Number(s.balance)))}`}</div>
                  {s.status === 'REABIERTA' ? <p className="text-[11px] text-amber-700">Reabierta por Caja: {s.reopen_reason}</p>
                    : s.driver_ack_at ? <p className="text-[11px] text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Conforme</p>
                    : <button onClick={() => acknowledge(s)} className="mt-1 w-full bg-[#002855] text-white py-2 rounded-xl text-xs font-bold">Estoy conforme con esta liquidación</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
