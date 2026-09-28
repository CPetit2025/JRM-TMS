'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Banknote, ChevronDown, ChevronUp, Loader2, Send, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// Anticipos del viaje en la app del conductor (Caja C4): saldo, historial y solicitud a Caja.
// La entrega o anulación la hace Caja en /caja/anticipos; el conductor recibe el aviso en la app.

type Advance = { id: string; code: string; amount: number; status: string; source: string; reason: string | null; cancel_reason: string | null; payment_method: string | null }
const KEYS = [['COMBUSTIBLE', 'Combustible'], ['PEAJE', 'Peajes'], ['ALIMENTACION', 'Alimentación'], ['HOSPEDAJE', 'Hospedaje'], ['OTROS', 'Otros']] as const
const STATUS: Record<string, { label: string; cls: string }> = {
  SOLICITADO: { label: 'Solicitado', cls: 'bg-amber-100 text-amber-800' },
  ENTREGADO: { label: 'Entregado', cls: 'bg-emerald-100 text-emerald-700' },
  RENDIDO: { label: 'Rendido', cls: 'bg-slate-100 text-slate-600' },
  ANULADO: { label: 'Anulado', cls: 'bg-red-100 text-red-700' },
}
const soles = (n: number) => `S/ ${n.toFixed(2)}`

export function AdvanceRequestCard({ dispatchId, spent, canRequest }: { dispatchId: string; spent: number; canRequest: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const [advances, setAdvances] = useState<Advance[]>([])
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [split, setSplit] = useState<Record<string, string>>({})
  const [showSplit, setShowSplit] = useState(false)
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase.from('trip_advances').select('id, code, amount, status, source, reason, cancel_reason, payment_method')
      .eq('dispatch_id', dispatchId).order('requested_at', { ascending: false })
    setAdvances((data || []) as Advance[])
  }, [supabase, dispatchId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const channel = supabase.channel(`advances-${dispatchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_advances', filter: `dispatch_id=eq.${dispatchId}` }, () => void load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [supabase, dispatchId, load])

  const received = advances.filter(a => ['ENTREGADO', 'RENDIDO'].includes(a.status)).reduce((s, a) => s + Number(a.amount), 0)
  const pending = advances.find(a => a.status === 'SOLICITADO')
  const splitTotal = KEYS.reduce((s, [k]) => s + Number(split[k] || 0), 0)

  const send = async () => {
    const value = Number(amount)
    if (!(value > 0)) return toast.error('Ingresa el monto que necesitas')
    if (!reason.trim()) return toast.error('Cuéntale a Caja para qué es el anticipo')
    setSending(true)
    try {
      const breakdown = Object.fromEntries(KEYS.filter(([k]) => Number(split[k]) > 0).map(([k]) => [k, Number(split[k])]))
      const { data, error } = await supabase.rpc('request_trip_advance_from_app', { p_dispatch_id: dispatchId, p_amount: value, p_reason: reason.trim(), p_breakdown: breakdown })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'No se pudo enviar')
      toast.success(`Solicitud ${data.code} enviada a Caja`)
      setOpen(false); setAmount(''); setReason(''); setSplit({}); setShowSplit(false)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String((e as { message?: string })?.message || e))
    } finally { setSending(false) }
  }

  const withdraw = async (a: Advance) => {
    const { data, error } = await supabase.rpc('withdraw_trip_advance_request', { p_advance_id: a.id })
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo retirar')
    toast.success('Solicitud retirada')
    await load()
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-3 grid grid-cols-3 text-center">
        <div><p className="text-[9px] font-bold uppercase text-slate-500">Anticipo</p><p className="font-black text-[#002855] text-sm">{soles(received)}</p></div>
        <div><p className="text-[9px] font-bold uppercase text-slate-500">Gastado</p><p className="font-black text-[#002855] text-sm">{soles(spent)}</p></div>
        <div><p className="text-[9px] font-bold uppercase text-slate-500">{received - spent >= 0 ? 'Te queda' : 'A tu favor'}</p>
          <p className={`font-black text-sm ${received - spent >= 0 ? 'text-emerald-700' : 'text-blue-700'}`}>{soles(Math.abs(received - spent))}</p></div>
      </div>

      {advances.length > 0 && (
        <div className="border-t border-slate-100 divide-y divide-slate-100">
          {advances.map(a => (
            <div key={a.id} className="px-3 py-2 flex items-center gap-2 text-xs">
              <Banknote className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-slate-700">{a.code} · {soles(Number(a.amount))}</p>
                {a.reason && <p className="text-[11px] text-slate-500 truncate">{a.reason}</p>}
                {a.status === 'ANULADO' && a.cancel_reason && <p className="text-[11px] text-red-700">{a.cancel_reason}</p>}
                {a.status === 'ENTREGADO' && a.payment_method && <p className="text-[11px] text-emerald-700">Entregado por {a.payment_method.toLowerCase().replace('_', ' / ')}</p>}
              </div>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATUS[a.status]?.cls || ''}`}>{STATUS[a.status]?.label || a.status}</span>
              {a.status === 'SOLICITADO' && a.source === 'APP' && (
                <button onClick={() => withdraw(a)} title="Retirar solicitud" className="p-1 text-slate-400"><X className="w-4 h-4" /></button>
              )}
            </div>
          ))}
        </div>
      )}

      {canRequest && !pending && (open ? (
        <div className="border-t border-slate-100 p-3 space-y-2 bg-slate-50">
          <label className="block">
            <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">Monto que necesitas (S/)</span>
            <input type="number" step="0.01" min="0" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full px-3 py-3 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none font-bold bg-white" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">¿Para qué es?</span>
            <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Ej. Peajes y alimentación del retorno"
              className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none text-sm bg-white" />
          </label>
          <button type="button" onClick={() => setShowSplit(v => !v)} className="text-[11px] font-bold text-blue-700 flex items-center gap-1">
            {showSplit ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}Detallar por concepto (opcional)
          </button>
          {showSplit && (
            <div className="grid grid-cols-2 gap-2">
              {KEYS.map(([k, l]) => (
                <label key={k} className="block">
                  <span className="block text-[10px] font-bold text-slate-500 mb-0.5">{l}</span>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={split[k] || ''}
                    onChange={e => { const next = { ...split, [k]: e.target.value }; setSplit(next); setAmount(String(KEYS.reduce((s, [x]) => s + Number(next[x] || 0), 0) || '')) }}
                    className="w-full px-2 py-2 rounded-lg border border-slate-200 text-sm bg-white" />
                </label>
              ))}
              {splitTotal > 0 && <p className="col-span-2 text-[11px] text-slate-500">Total del detalle: {soles(splitTotal)}</p>}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-xl text-xs font-bold text-slate-600 bg-white border">Cancelar</button>
            <button disabled={sending} onClick={send} className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white bg-[#002855] flex items-center justify-center gap-1 disabled:opacity-50">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}Enviar a Caja
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="w-full border-t border-slate-100 py-3 text-sm font-bold text-[#002855] flex items-center justify-center gap-2 hover:bg-slate-50">
          <Banknote className="w-4 h-4" />Solicitar anticipo
        </button>
      ))}
      {pending && <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-amber-800 bg-amber-50">Tu solicitud {pending.code} está en revisión por Caja. Te avisaremos cuando se entregue.</p>}
    </div>
  )
}
