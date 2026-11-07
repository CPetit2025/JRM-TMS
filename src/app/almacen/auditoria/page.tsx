'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Event = { id: number; event_type: string; scanned_code: string; operator_id: string; occurred_at: string; payload: Record<string, unknown> }
const labels: Record<string,string> = { IMPORT_ACCEPTED:'Importación aceptada',IMPORT_DUPLICATE:'Archivo ya importado',IMPORT_REJECTED:'Importación rechazada', RECEIPT_VALIDATED:'Recepción validada',LABELS_GENERATED:'LPN generados',LABEL_PRINT:'Primera impresión',LABEL_REPRINT:'Reimpresión',LABEL_PRINT_CONFIRMED:'Impresión confirmada' }

export default function WarehouseAuditPage() {
  const [events,setEvents]=useState<Event[]>([])
  const [error,setError]=useState('')
  const [query,setQuery]=useState('')
  const [busy,setBusy]=useState(false)
  const load=useCallback(async()=>{
    setBusy(true)
    const {data,error}=await createClient().from('wh_scan_events').select('id,event_type,scanned_code,operator_id,occurred_at,payload').order('occurred_at',{ascending:false}).limit(200)
    if(error)setError('No se pudo consultar la auditoría. Verifique los permisos de supervisión.');else{setEvents((data||[]) as Event[]);setError('')}
    setBusy(false)
  },[])
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load])
  const visible=events.filter(event=>[event.scanned_code,event.event_type,event.operator_id].some(value=>value.toLowerCase().includes(query.trim().toLowerCase())))
  return <div className="w-full min-w-0 space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-black text-[#002855]">Auditoría de recepción</h1><p className="text-sm text-slate-600">Últimas 200 operaciones visibles según sus permisos de almacén.</p></div><button disabled={busy} onClick={()=>void load()} className="rounded-lg border bg-white px-4 py-2 text-sm font-bold">{busy?'Consultando…':'Actualizar'}</button></header>
    {error&&<p role="alert" className="rounded border border-rose-300 bg-rose-50 p-3 text-sm">{error}</p>}
    <input value={query} onChange={event=>setQuery(event.target.value)} aria-label="Buscar en auditoría" placeholder="Buscar por IPT, LPN, operación o identificador de usuario" className="w-full rounded-lg border bg-white p-3 text-sm" />
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr><th className="p-3">Fecha</th><th className="p-3">Operación</th><th className="p-3">IPT / LPN</th><th className="p-3">Responsable</th><th className="p-3">Detalle</th></tr></thead><tbody>
      {visible.map(event=><tr key={event.id} className="border-t"><td className="p-3 whitespace-nowrap">{new Date(event.occurred_at).toLocaleString('es-PE')}</td><td className="p-3">{labels[event.event_type]||event.event_type}</td><td className="p-3 break-all">{event.scanned_code}</td><td className="p-3 break-all">{event.operator_id}</td><td className="p-3"><details><summary className="cursor-pointer">Ver detalle</summary><pre className="mt-2 max-w-lg overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(event.payload,null,2)}</pre></details></td></tr>)}
      {!busy&&!error&&!visible.length&&<tr><td colSpan={5} className="p-4 text-center text-slate-500">Sin operaciones para esta consulta.</td></tr>}
    </tbody></table></div>
  </div>
}
