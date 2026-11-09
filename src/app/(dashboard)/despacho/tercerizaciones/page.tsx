'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { PageHeader } from '@/components/ui/page-header'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage, money } from '@/lib/caja'
import { OUTSOURCING_STAGES, OUTSOURCING_SERVICES, SPEC_FIELDS, SERVICE_FIELDS, type Outsourcing, type OutsourcingQuote, type OutsourcingService } from '@/lib/outsourcing'
import { OutsourcingRequest } from '@/components/despacho/OutsourcingRequest'
import { workflowLabel, type Preparation } from '@/lib/outsourcing-form'
import { ManagementTable } from '@/components/despacho/outsourcing/ManagementTable'
import { ResourceManager } from '@/components/despacho/outsourcing/ResourceManager'
import { cellDateTime } from '@/lib/table-format'

type Row = Outsourcing & { client: string | null; transport_requests: { request_number: string; contract_id: string | null; contracts: { code: string } | null } }
type Supplier = { id: string; business_name: string }
type Event = { id: string; stage: number; actor_name: string; created_at: string; note: string; evidence: string | null; snapshot?: { action?: string; preparation?:Preparation; assignment_id?:string; dispatch_id?:string } }
const control = 'w-full rounded-lg border border-slate-300 bg-white p-2 text-sm'
const button = 'rounded-lg bg-jrm-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50'
const RESOURCE_EVENTS: Record<string,string> = {RESOURCE_SAVED:'Recurso registrado / actualizado',RESOURCE_APPROVE:'Costo y recurso aprobados',RESOURCE_CONFIRM:'Proveedor confirmado',RESOURCE_CANCEL:'Asignación cancelada',RESOURCE_COMPLETE:'Servicio finalizado',RESOURCE_SCHEDULED:'Recurso programado',RESOURCE_RECTIFIED:'Recurso programado rectificado',RESOURCE_INVALIDATED:'Recurso invalidado por revisión'}
export default function OutsourcingPage() {
 const db = useMemo(() => createClient(), [])
 const { canWrite } = usePermissions()
 const [modalId,setModalId] = useState<string | null>(null)
 const closeModal = useCallback(() => setModalId(null),[])
 const [rows,setRows] = useState<Row[]>([])
 const [id,setId] = useState('')
 const [service,setService] = useState<OutsourcingService>('FLETE')
 const [refresh,setRefresh] = useState(0)
 const [busy,setBusy] = useState(false)
 const [quotes,setQuotes] = useState<OutsourcingQuote[]>([])
 const [events,setEvents] = useState<Event[]>([])
 const [suppliers,setSuppliers] = useState<Supplier[]>([])
 const [note,setNote] = useState('')
 const [hasResources,setHasResources] = useState(true)
 const [file,setFile] = useState<File | null>(null)
 const row = rows.find(r => r.id===id)
 const load = useCallback(async () => { setRefresh(v=>v+1) },[])
 const closeDrawer = useCallback(() => { if(!busy) setId('') },[busy])
 const detail = useCallback(async () => {
  if (!id) return
  const parent=await db.rpc('outsourcing_form_context',{p_id:id})
  if(parent.data?.record) { const {record,request}=parent.data; const extra={...record,client:request.request_client?.business_name,transport_requests:{request_number:request.request_number,contract_id:request.contracts?.id,contracts:{code:request.contracts?.code}}} as Row; setRows(current=>[...current.filter(r=>r.id!==id),extra]) }
  const results = await Promise.all([
   db.from('transport_outsourcing_quotes').select('*').eq('outsourcing_id',id).order('created_at'),
   db.from('transport_outsourcing_events').select('id,stage,actor_name,created_at,note,evidence,snapshot').eq('outsourcing_id',id).order('created_at'),
  ])
  if (results.some(r => r.error)) { toast.error('No se pudo cargar el detalle'); return }
  setQuotes(results[0].data || []); setEvents(results[1].data || [])
 },[db,id])
 useEffect(() => { const timer = setTimeout(() => setId(new URLSearchParams(window.location.search).get('solicitud') || ''),0); return () => clearTimeout(timer) },[])
 useEffect(() => {
  const timer = setTimeout(() => { void load() },0)
  const channel = db.channel('outsourcing-queue').on('postgres_changes',{event:'*',schema:'public',table:'transport_outsourcing'},() => { void load(); void detail() }).subscribe()
  return () => { clearTimeout(timer); void db.removeChannel(channel) }
 },[db,load,detail])
 useEffect(() => { const timer=setTimeout(() => void detail(),0); return () => clearTimeout(timer) },[detail])
 useEffect(() => {
  if (!id || !quotes.length) return
  let active = true
  void db.rpc('outsourcing_options',{p_id:id}).then(({data,error}) => {
   if(active) { if(error) toast.error(errorMessage(error)); else setSuppliers(data?.suppliers || []) }
  })
  return () => { active=false }
 },[db,id,quotes.length])
 async function view(path:string) {
  const {data,error} = await db.storage.from('outsourcing').createSignedUrl(path,120)
  if(error) { toast.error(errorMessage(error)); return }
  window.open(data.signedUrl,'_blank','noopener,noreferrer')
 }
 // Flujo anterior: las solicitudes adjudicadas sin asignaciones (etapas 5–6) solo pueden cerrarse por transición.
 async function legacyAdvance() {
  if(!row || busy) return
  setBusy(true)
  try {
   if(!file || file.size>10485760 || !['application/pdf','image/png','image/jpeg'].includes(file.type)) throw new Error('Adjunte la evidencia: PDF, PNG o JPG de hasta 10 MB')
   const path=`${row.id}/${crypto.randomUUID()}.${file.type==='application/pdf' ? 'pdf' : file.type==='image/png' ? 'png' : 'jpg'}`
   const upload=await db.storage.from('outsourcing').upload(path,file)
   if(upload.error) throw upload.error
   const {error}=await db.rpc('outsourcing_transition',{p_id:row.id,p_version:row.version,p_next:row.stage+1,p_note:note,p_evidence:path,p_quotes:[],p_dispatch:null})
   if(error) throw error
   setNote('');setFile(null);await load();await detail();toast.success('Etapa actualizada')
  }catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}
 }
 async function review(action:'OBSERVE'|'CANCEL') {
  if(!row || busy) return
  if(note.trim().length<5) {toast.error('Registre el motivo (mínimo 5 caracteres).');return}
  if(!window.confirm(action==='OBSERVE'?'¿Devolver la ficha a Transporte para su corrección? Las cotizaciones anteriores quedarán como historial.':'¿Cancelar esta solicitud de tercerización? Se conservará el historial.'))return
  setBusy(true)
  try {
   const {error}=await db.rpc('outsourcing_review',{p_id:row.id,p_version:row.version,p_action:action,p_note:note})
   if(error)throw error
   setNote('');await load();await detail();toast.success(action==='OBSERVE'?'Ficha observada y devuelta para corrección.':'Solicitud cancelada.')
  }catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}
 }
 const services: OutsourcingService[] = ['FLETE',...(row?.specification.services || []).map(s => s.kind)]
 return <div className="space-y-4">
  <PageHeader showTitle title="Solicitudes de tercerización" description="Distribución · Transporte · Compras" actions={<><button className={button} onClick={() => { void load(); void detail() }}>Actualizar</button><Link className="rounded-lg border p-2 text-sm" href="/despacho">Programación y ruteo</Link></>} />
  <ManagementTable refresh={refresh} onSelect={(next,kind)=>{setId(next);setService(kind);setNote('')}}/>
  {/* El panel lateral se oculta mientras la ficha completa está abierta encima. */}
  <Modal side isOpen={!!row && !modalId} onClose={closeDrawer} maxWidth="max-w-3xl" title={row ? `ST-${row.number} · ${OUTSOURCING_SERVICES[service]} · ${workflowLabel(row)}` : ''}>
   {row && <div key={row.id} className="min-w-0 space-y-4">
    <div className="flex flex-wrap gap-3 text-sm"><span>Solicitud: {row.transport_requests.request_number}</span><span>Cliente: {row.client || 'Sin cliente'}</span><span>Prioridad: {String(row.specification.priority)}</span>{row.transport_requests.contract_id && <Link className="text-blue-700 underline" href={`/despacho/control-presupuestal/movimientos?ot=${row.transport_requests.contract_id}`}>Presupuesto y movimientos de la OT</Link>}{row.dispatch_id && <Link className="text-blue-700 underline" href={`/despacho/documentos/economico?despacho=${row.dispatch_id}`}>Cierre económico del despacho</Link>}</div>
    <button type="button" className={button} onClick={()=>setModalId(row.id)}>{row.stage===0 && row.review_status!=='CANCELLED' && canWrite('despacho') ? 'Abrir / corregir ficha' : 'Consultar ficha completa'}</button>
    <ResourceManager onManaged={setHasResources} parent={row.id} service={service} onChanged={()=>{void load();void detail()}}/>
    {!hasResources && row.stage>=5 && row.stage<7 && row.review_status!=='CANCELLED' && canWrite(row.stage===5?'despacho':'cierre-economico') && <form className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3" onSubmit={e=>{e.preventDefault();void legacyAdvance()}}>
     <h3 className="font-semibold">Solicitud del flujo anterior · continuar a: {OUTSOURCING_STAGES[row.stage+1]}</h3>
     <label className="block text-sm">Sustento<textarea required minLength={5} className={control} value={note} onChange={e=>setNote(e.target.value)} /></label>
     <label className="block text-sm">Evidencia (obligatoria) · PDF, PNG o JPG, máximo 10 MB<input required type="file" accept="application/pdf,image/png,image/jpeg" className={control} onChange={e=>setFile(e.target.files?.[0] || null)} /></label>
     <button disabled={busy} className={button}>{busy ? 'Guardando…' : OUTSOURCING_STAGES[row.stage+1]}</button>
    </form>}
    <details><summary className="cursor-pointer font-semibold">Ficha técnica y operativa</summary>{SPEC_FIELDS.map(([section,fields]) => <div key={section} className="mt-3"><h3 className="font-medium text-jrm-navy">{section}</h3><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{fields.map(([key,label]) => <div key={key}><dt className="text-slate-500">{label}</dt><dd className="whitespace-pre-wrap break-words">{key==='required_at' && row.specification[key] ? cellDateTime(String(row.specification[key])) : String(row.specification[key] || '—')}</dd></div>)}</dl></div>)}{row.specification.services.map(s => <p className="mt-3 text-sm" key={s.kind}><strong>{OUTSOURCING_SERVICES[s.kind]}:</strong> {s.requirements}{(SERVICE_FIELDS[s.kind] || []).map(([key,label]) => <span className="block text-slate-600" key={key}>{label}: {s.details?.[key] || '—'}</span>)}</p>)}</details>
    {quotes.length>0 && <details className="space-y-2 border-t pt-3"><summary className="cursor-pointer font-semibold">Cotizaciones del proceso anterior (histórico)</summary>{services.map(kind => <fieldset key={kind} className="rounded-lg border p-3"><legend className="px-1 text-sm font-semibold">{OUTSOURCING_SERVICES[kind]}</legend>{quotes.filter(q=>q.service===kind).map(q => <p key={q.id} className="my-2 text-sm">{q.selected ? 'Seleccionada · ' : ''}{suppliers.find(s=>s.id===q.supplier_id)?.business_name || q.supplier_id} · {money(q.amount_pen)} · {q.terms} <button className="text-blue-700 underline" onClick={() => void view(q.evidence)}>Ver cotización</button></p>)}{!quotes.some(q=>q.service===kind) && <p className="text-sm text-slate-500">Sin cotización</p>}</fieldset>)}</details>}
    {row.review_status!=='CANCELLED' && row.stage<5 && canWrite(row.stage===0?'despacho':row.stage<=2?'compras-tercerizaciones':'compras-aprobar') && <details className="space-y-3 rounded-lg border border-amber-200 p-3"><summary className="cursor-pointer font-semibold">Observar o cancelar el requerimiento</summary><label className="block text-sm">Motivo de observación o cancelación<textarea className={control} value={note} onChange={e=>setNote(e.target.value)} /></label><div className="flex flex-wrap gap-3">{row.stage>0&&row.stage<=3&&<button disabled={busy} className="rounded-lg border px-3 py-2 text-sm" onClick={()=>void review('OBSERVE')}>Observar ficha técnica</button>}<button disabled={busy} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700" onClick={()=>void review('CANCEL')}>Cancelar solicitud</button></div></details>}
    <details className="border-t pt-3"><summary className="cursor-pointer font-semibold">Historial y evidencias</summary><div className="mt-2 space-y-3">{events.map(e=><div className="border-l-2 border-blue-200 pl-3 text-sm" key={e.id}><p className="font-semibold">{e.snapshot?.action?.startsWith('RESOURCE_') ? (RESOURCE_EVENTS[e.snapshot.action]||'Gestión de recursos') : e.snapshot?.action==='OBSERVE' ? 'Observada' : e.snapshot?.action==='CANCEL' ? 'Cancelada' : e.snapshot?.preparation?.state==='PREPARED' ? 'Preparada para envío' : OUTSOURCING_STAGES[e.stage]} · {cellDateTime(e.created_at)}</p><p>{e.actor_name} · {e.note}</p>{e.evidence && <button className="text-blue-700 underline" onClick={()=>void view(e.evidence!)}>Ver evidencia</button>}</div>)}</div></details>
   </div>}
  </Modal>
  {modalId&&<OutsourcingRequest outsourcingId={modalId} onClose={closeModal} onChanged={()=>{void load();void detail()}}/>}
 </div>
}
