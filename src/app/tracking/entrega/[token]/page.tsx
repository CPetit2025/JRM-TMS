'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2, MapPin, Truck } from 'lucide-react'
import { EvidenceDraft, EvidenceForm } from '@/components/delivery/EvidenceForm'
import { deliveryTime } from '@/lib/delivery'

type Stop = { request_id: string; orden: number; solicitud: string; destino: string | null; documento: string | null; conformidad: string; arrived_at: string | null; ot: string | null; cliente: string | null; motivo: string | null }
type Info = { success: boolean; error?: string; despacho?: { numero: string; estado: string; placa: string; conductor: string | null; salida_programada: string | null; salida_at: string | null }; paradas?: Stop[] }

export default function EntregaTerceroPage() {
  const { token } = useParams<{ token: string }>()
  const [info, setInfo] = useState<Info | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/tercero/${token}`, { cache: 'no-store', referrerPolicy: 'no-referrer' }).then(r => r.json()).then((result: Info) => { if (!cancelled) setInfo(result) })
      .catch(() => { if (!cancelled) setInfo({ success: false, error: 'Sin conexión. Intente nuevamente.' }) })
    return () => { cancelled = true }
  }, [token, version])
  const send = async (body: FormData) => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/tercero/${token}`, { method: 'POST', body, referrerPolicy: 'no-referrer' })
      const result = await response.json()
      if (!result.success) throw new Error(result.error || 'No se pudo registrar.')
      setVersion(v => v + 1)
    } catch (err) { const message = err instanceof Error ? err.message : 'Sin conexión. Reintente el envío.'; setError(message); throw new Error(message) }
    finally { setBusy(false) }
  }
  const action = (name: string, id?: string) => {
    const body = new FormData(); body.set('accion', name); if (id) body.set('request_id', id)
    void send(body).catch(() => {})
  }
  const submit = async (id: string, draft: EvidenceDraft) => {
    const body = new FormData(); body.set('accion', 'entrega'); body.set('request_id', id); body.set('operation_id', draft.operation)
    body.set('recibido_por', draft.receiver); body.set('guia', draft.guide); body.set('nota', draft.note)
    draft.files.forEach(file => body.append('foto', file))
    await send(body); setSelected(null)
    setReceipt('Guía recibida. Pendiente de validación del Supervisor de Transporte. El acceso a esta entrega queda bloqueado; solo una observación o rechazo habilita corregirla.')
  }
  const d = info?.despacho
  return <div className="min-h-screen bg-slate-50 pb-10">
    <header className="bg-[#002855] p-4 text-white"><div className="mx-auto flex max-w-lg items-center gap-3"><Truck className="h-7 w-7" /><div><p className="text-xs opacity-80">JRM · Guía de entrega</p><h1 className="font-bold">{d?.numero || 'Registro de conformidad'}</h1></div></div></header>
    <main className="mx-auto max-w-lg space-y-4 px-4 pt-5">
      {receipt && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{receipt}</p>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!info ? <Loader2 className="mx-auto h-7 w-7 animate-spin" /> : !info.success || !d ? <div className="rounded-xl border bg-white p-5 text-sm text-slate-600"><p>{info.error || 'Acceso no disponible.'}</p><button className="mt-3 min-h-10 text-blue-700" onClick={() => setVersion(v => v + 1)}>Actualizar</button><Link href="/tracking/entregas" className="ml-4 text-blue-700">Consultar por placa</Link></div> : <>
        <section className="rounded-xl border bg-white p-4 text-sm"><p>Placa: <b>{d.placa}</b></p><p>Conductor: {d.conductor || '—'}</p><p>Salida: {deliveryTime(d.salida_at || d.salida_programada)}</p></section>
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Sin guía firmada y aprobada por el Supervisor de Transporte, no se procede con el avance del servicio.</p>
        {d.estado === 'PROGRAMADO' && <button disabled={busy} onClick={() => action('salida')} className="min-h-12 w-full rounded-xl bg-[#002855] font-bold text-white disabled:opacity-60">Ya salí</button>}
        {(info.paradas || []).map(stop => <section key={stop.request_id} className="space-y-3 rounded-xl border bg-white p-4">
          <div className="flex gap-2"><MapPin className="h-5 w-5 shrink-0 text-blue-700" /><div><h2 className="font-bold text-[#002855]">{stop.ot || 'Sin OT vinculada'} · {stop.solicitud}</h2><p className="text-sm">{stop.cliente}</p><p className="text-sm text-slate-600">{stop.destino}</p><p className="text-xs text-slate-500">Guía: {stop.documento || 'Por registrar'}</p></div></div>
          {stop.motivo && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{stop.conformidad === 'RECHAZADA' ? 'Rechazada' : 'Observada'}: {stop.motivo}</p>}
          {d.estado === 'PROGRAMADO' ? <p className="text-xs text-slate-500">Registre primero la salida.</p> : <>
            {stop.arrived_at ? <p className="text-xs text-amber-800">En destino · {deliveryTime(stop.arrived_at)}</p> : <button disabled={busy} onClick={() => action('llegada', stop.request_id)} className="min-h-11 rounded-lg border border-amber-300 px-4 text-sm text-amber-900">Confirmar llegada al destino</button>}
            {selected === stop.request_id ? <EvidenceForm busy={busy} guide={stop.documento || ''} onCancel={() => setSelected(null)} onSubmit={draft => submit(stop.request_id, draft)} /> : <button disabled={busy} onClick={() => setSelected(stop.request_id)} className="min-h-12 w-full rounded-lg bg-[#002855] font-bold text-white">{stop.motivo ? 'Corregir sustento' : 'Subir guía firmada'}</button>}
          </>}
        </section>)}
      </>}
    </main>
  </div>
}
