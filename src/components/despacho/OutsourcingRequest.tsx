'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import type { TransportRequest } from './programar-ruta/types'
import { OUTSOURCING_SERVICES, SPEC_FIELDS, SERVICE_HINTS, SERVICE_FIELDS, type Outsourcing, type OutsourcingService, type Specification } from '@/lib/outsourcing'

const control = 'w-full rounded-lg border border-slate-300 bg-white p-2 text-sm disabled:bg-slate-100'
export function OutsourcingRequest({ request, onClose }: { request: TransportRequest; onClose: () => void }) {
 const db = useMemo(() => createClient(), [])
 const dialogRef = useRef<HTMLDivElement>(null)
 const [record, setRecord] = useState<Outsourcing | null>(null)
 const [loading, setLoading] = useState(true)
 const [busy, setBusy] = useState(false)
 const [spec, setSpec] = useState<Specification>(() => ({ services: [], priority: 'NORMAL', pickup: request.pickup_address, delivery: request.delivery_address, responsible: request.requester_name,
  required_at: request.required_at ? new Date(Date.parse(request.required_at) - 5 * 3600000).toISOString().slice(0,16) : '',
  cargo_weight_kg: String(request.estimated_weight || ''), intermediate_points: 'No aplica' }))
 useEffect(() => {
  let active = true
  void db.from('transport_outsourcing').select('*').eq('request_id', request.id).maybeSingle().then(({ data, error }) => {
   if (!active) return
   if (error) { toast.error(errorMessage(error)); onClose(); return }
   if (data) { setRecord(data); setSpec({ ...data.specification, required_at: data.specification.required_at ? new Date(Date.parse(data.specification.required_at) - 5 * 3600000).toISOString().slice(0,16) : '' }) }
   setLoading(false)
  })
  return () => { active = false }
 }, [db, request.id, onClose])
 useEffect(() => {
  const previous = document.activeElement as HTMLElement | null
  const dialog = dialogRef.current
  dialog?.querySelector<HTMLButtonElement>('button')?.focus()
  function keyboard(e: KeyboardEvent) {
   if (e.key==='Escape' && !busy) onClose()
   if (e.key!=='Tab' || !dialog) return
   const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)'))
   const first=focusable[0], last=focusable[focusable.length-1]
   if(e.shiftKey && document.activeElement===first) { e.preventDefault(); last?.focus() }
   else if(!e.shiftKey && document.activeElement===last) { e.preventDefault(); first?.focus() }
  }
  document.addEventListener('keydown',keyboard)
  return () => { document.removeEventListener('keydown',keyboard); previous?.focus() }
 },[onClose,busy])
 async function save() {
  setBusy(true)
  try {
   const { data, error } = await db.rpc('outsourcing_save', { p_request: request.id, p_spec: { ...spec, required_at: spec.required_at ? `${spec.required_at}:00-05:00` : '' }, p_version: record?.version ?? null })
   if (error) throw error
   const result = await db.from('transport_outsourcing').select('*').eq('id', data).single()
   if (result.error) throw result.error
   setRecord(result.data)
   toast.success('Solicitud guardada. Revise la ficha y envíela a Compras desde la bandeja.')
  } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
 }
 return <div ref={dialogRef} className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-3" role="dialog" aria-modal="true" aria-labelledby="outsourcing-title">
  <div className="mx-auto my-6 max-w-4xl rounded-xl bg-white p-5 shadow-xl">
   <div className="flex items-center justify-between gap-3"><h2 id="outsourcing-title" className="text-xl font-bold text-jrm-navy">Solicitud de tercerización {record ? `ST-${record.number}` : ''}</h2><button type="button" onClick={onClose} disabled={busy} className="rounded-lg border p-2">Cerrar</button></div>
   <p className="my-3 text-sm text-slate-600">{request.request_number} · OT {request.contracts?.code || 'Sin OT'} · {request.request_client?.business_name || request.contracts?.clients?.business_name || 'Sin cliente'} · Dirigida a Compras</p>
   {loading ? <p role="status">Cargando…</p> : record && record.stage>0 ? <p>La solicitud ya fue enviada. <Link className="text-blue-700 underline" href={`/despacho/tercerizaciones?solicitud=${record.id}`}>Consultar avance y evidencias</Link></p> : <form onSubmit={e => { e.preventDefault(); void save() }} className="space-y-5">
    <p className="rounded-lg bg-blue-50 p-3 text-sm">Complete los requisitos para Lima o provincias. Use «No aplica» cuando corresponda. El envío valida todos los campos obligatorios.</p>
    <label className="block text-sm font-medium">Prioridad<select className={control} value={String(spec.priority)} onChange={e => setSpec({ ...spec, priority: e.target.value })}>{['NORMAL','ALTA','URGENTE'].map(v => <option key={v}>{v}</option>)}</select></label>
    {SPEC_FIELDS.map(([section, fields]) => <fieldset key={section} className="rounded-lg border p-3"><legend className="px-2 font-semibold text-jrm-navy">{section}</legend><div className="grid gap-3 sm:grid-cols-2">{fields.map(([key,label,...rest]) => {
     const type = rest[0] || 'text'
     return <label key={key} className="text-sm text-slate-700">{label}<input className={control} type={type==='optional' ? 'text' : type} step={type==='number' ? 'any' : undefined} min={type==='number' ? '0.001' : undefined} value={String(spec[key] || '')} onChange={e => setSpec({ ...spec, [key]: e.target.value })} /></label>
    })}</div></fieldset>)}
    <fieldset className="space-y-3 rounded-lg border p-3"><legend className="px-2 font-semibold text-jrm-navy">Servicios complementarios</legend>{(Object.keys(SERVICE_HINTS) as OutsourcingService[]).map(kind => {
     const service = spec.services.find(s => s.kind===kind)
     return <div key={kind}><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={!!service} onChange={e => setSpec({ ...spec, services: e.target.checked ? [...spec.services,{ kind, requirements: '' }] : spec.services.filter(s => s.kind!==kind) })} />{OUTSOURCING_SERVICES[kind]}</label>{service && <div className="mt-2 grid gap-2 sm:grid-cols-2">{(SERVICE_FIELDS[kind] || []).map(([key,label,type]) => <label key={key} className="text-sm">{label}<input className={control} type={type} min={type==='number' ? '0.001' : undefined} step="any" value={service.details?.[key] || ''} onChange={e => setSpec({ ...spec, services: spec.services.map(s => s.kind===kind ? { ...s, details: { ...s.details, [key]: e.target.value } } : s) })} /></label>)}</div>}{service && <label className="mt-2 block text-sm">{SERVICE_HINTS[kind]}<textarea className={control} value={service.requirements} onChange={e => setSpec({ ...spec, services: spec.services.map(s => s.kind===kind ? { ...s, requirements:e.target.value } : s) })} /></label>}</div>
    })}</fieldset>
    <div className="flex flex-wrap items-center gap-3"><button disabled={busy} className="rounded-lg bg-jrm-navy px-4 py-2 text-white">{busy ? 'Guardando…' : 'Guardar solicitud'}</button>{record && <Link className="font-semibold text-blue-700 underline" href={`/despacho/tercerizaciones?solicitud=${record.id}`}>Adjuntar documentos y enviar a Compras →</Link>}</div>
   </form>}
  </div>
 </div>
}
