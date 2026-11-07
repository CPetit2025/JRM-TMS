'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarCheck, FileText, Flag, Info, Loader2, Save, Send, ShoppingCart, UserRound, Warehouse, Wrench, Truck, ClipboardList, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage } from '@/lib/caja'
import type { TransportRequest } from './programar-ruta/types'
import { type Outsourcing } from '@/lib/outsourcing'
import { normalizeSpec, serializeSpec, validateWizard, workflowLabel, isoLima, localDate, type WizardSpec, type OutsourcingAttachment, type Preparation } from '@/lib/outsourcing-form'
import { GeneralSection, TransportSection, ServicesSection, OperationsSection } from './outsourcing/RequestSections'
import { EmailPreparation, type MailDraft, type PreparedView } from './outsourcing/EmailPreparation'
import { buildOutsourcingDocument, outsourcingEmailTemplate } from '@/lib/outsourcing-document'
import './outsourcing/wizard.css'

type Context={record:Outsourcing;request:TransportRequest;observation?:string}
export function OutsourcingRequest({request:initialRequest,outsourcingId,onClose,onChanged}:{request?:TransportRequest;outsourcingId?:string;onClose:()=>void;onChanged?:()=>void}) {
 const db=useMemo(()=>createClient(),[])
 const {canWrite,isLoaded}=usePermissions()
 const [request,setRequest]=useState(initialRequest)
 const [record,setRecord]=useState<Outsourcing|null>(null)
 const [spec,setSpec]=useState<WizardSpec>(()=>normalizeSpec({},initialRequest))
 const [baseline,setBaseline]=useState(()=>JSON.stringify(normalizeSpec({},initialRequest)))
 const [files,setFiles]=useState<File[]>([])
 const [loading,setLoading]=useState(true)
 const [loadError,setLoadError]=useState('')
 const [busy,setBusy]=useState(false)
 const [preparedView,setPreparedView]=useState<PreparedView|null>(null)
 const [mailBaseline,setMailBaseline]=useState('')
 const [mailDraft,setMailDraft]=useState<MailDraft>({to:'',cc:'',subject:'',text:''})
 const [showErrors,setShowErrors]=useState(false)
 const [observation,setObservation]=useState('')
 const [receipt,setReceipt]=useState('')
 const dialogRef=useRef<HTMLDivElement>(null)
 const contentRef=useRef<HTMLDivElement>(null)
 const actionRef=useRef(false)
 const closeRef=useRef<()=>void>(()=>{})
 const dirty=JSON.stringify(spec)!==baseline||files.length>0
 const mailDirty=!!preparedView&&JSON.stringify(mailDraft)!==mailBaseline
 const editable=(!record||record.stage===0)&&record?.review_status!=='CANCELLED'&&canWrite('despacho')
 const disabled=busy||!editable
 const identity=useMemo(()=>({request:request?.request_number || '—',ot:request?.contracts?.code || 'Sin OT',client:request?.request_client?.business_name || request?.contracts?.clients?.business_name || 'Sin cliente'}),[request])
 const issues=useMemo(()=>validateWizard({...spec,attachments:[...spec.attachments,...files.map(f=>({name:f.name,path:'pending'}))]},!!request?.contract_id,identity.client!=='Sin cliente'),[spec,files,request,identity.client])
 const status=workflowLabel(record?{...record,specification:spec}:null)
 const updateSpec=(fn:(p:WizardSpec)=>WizardSpec)=>setSpec(p=>{const next=fn(p);delete next.preparation;delete next.mail_draft;return next})
 useEffect(()=>()=>{if(preparedView){URL.revokeObjectURL(preparedView.pdfUrl);URL.revokeObjectURL(preparedView.annexUrl)}},[preparedView])
 const requestClose=useCallback(()=>{if(busy)return;if(dirty&&!window.confirm('Hay cambios sin guardar. ¿Desea cerrar y descartarlos?'))return;onClose()},[busy,dirty,onClose])
 useEffect(()=>{closeRef.current=preparedView?()=>{void closePreparation()}:requestClose})
 useEffect(()=>{if(preparedView)dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus()},[preparedView])
 useEffect(()=>{
  let alive=true
  async function load() {
   try {
    let item:Outsourcing|null=null,original=initialRequest
    if(outsourcingId) {
     const {data,error}=await db.rpc('outsourcing_form_context',{p_id:outsourcingId})
     if(error)throw error
     const context=data as Context;item=context.record;original=context.request;setObservation(context.observation || '')
    } else if(initialRequest) {
     const [saved,items]=await Promise.all([db.from('transport_outsourcing').select('*').eq('request_id',initialRequest.id).maybeSingle(),db.from('transport_request_items').select('*').eq('transport_request_id',initialRequest.id)])
     if(saved.error)throw saved.error
     if(items.error)throw items.error
     item=saved.data;original={...initialRequest,transport_request_items:items.data || initialRequest.transport_request_items}
     if(item?.review_status==='OBSERVED') {
      const {data:context,error:contextError}=await db.rpc('outsourcing_form_context',{p_id:item.id})
      if(contextError)throw contextError
      if(alive)setObservation((context as Context).observation || '')
     }
    } else throw new Error('No se encontró la solicitud de transporte.')
    if(!alive)return
    const normalized=normalizeSpec(item?.specification as Partial<WizardSpec> || {},original)
    setRequest(original);setRecord(item);setSpec(normalized);setBaseline(JSON.stringify(normalized));setLoadError('')
   } catch(e) {if(alive)setLoadError(errorMessage(e))} finally {if(alive)setLoading(false)}
  }
  void load()
  return()=>{alive=false}
 },[db,initialRequest,outsourcingId])
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow
  document.body.style.overflow='hidden'
  dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  function keyboard(e:KeyboardEvent) {
   if(e.key==='Escape'){e.preventDefault();closeRef.current()}
   if(e.key!=='Tab')return
   const nodes=Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') || []).filter(el=>el.getClientRects().length>0)
   const first=nodes[0],last=nodes.at(-1)
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
  }
  document.addEventListener('keydown',keyboard)
  return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keyboard);previous?.focus()}
 },[])
 useEffect(()=>{
  if(!dirty&&!mailDirty)return
  const prevent=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''}
  window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)
 },[dirty,mailDirty])
 function focusIssue(field:string) {
  const el=document.getElementById(`out-${field}`)
  if(el){let parent=el.parentElement;while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement}el.scrollIntoView({block:'center'});el.focus()}
 }
 function failValidation() {setShowErrors(true);toast.error('Revise los campos señalados antes de preparar la solicitud.');setTimeout(()=>focusIssue(issues[0]?.field||''),0)}
 function selectFiles(next:File[]) {
  if(next.some(f=>f.size>10485760||!['application/pdf','image/png','image/jpeg'].includes(f.type))){toast.error('Adjunte únicamente PDF, PNG o JPG de hasta 10 MB por archivo.');return}
  setFiles(next)
  setSpec(p=>({...p,preparation:undefined,mail_draft:undefined}))
 }
 async function saveRecord(value:WizardSpec,current:Outsourcing|null) {
  const {data,error}=await db.rpc('outsourcing_save',{p_request:request!.id,p_spec:serializeSpec(value),p_version:current?.version ?? null})
  if(error)throw error
  const result=await db.from('transport_outsourcing').select('*').eq('id',data).single()
  if(result.error)throw result.error
  setRecord(result.data);return result.data as Outsourcing
 }
 async function verifyReferences(value:WizardSpec) {
  if(!value.attachments.length)return
  const {data,error}=await db.storage.from('outsourcing').createSignedUrls(value.attachments.map(a=>a.path),60)
  if(error)throw error
  await Promise.all(value.attachments.map(async(a,i)=>{const signed=data?.[i];if(!signed?.signedUrl||signed.error)throw new Error(`Archivo no disponible: ${a.name}`);const result=await fetch(signed.signedUrl,{method:'HEAD'});if(!result.ok)throw new Error(`Archivo no disponible: ${a.name}`)}))
 }
 async function openPreparation(value:WizardSpec,current:Outsourcing,persistState:boolean) {
  await verifyReferences(value)
  const candidate=persistState?{...value,preparation:{state:'PREPARED',revision:current.revision||1,prepared_at:current.updated_at} satisfies Preparation}:value
  const model=buildOutsourcingDocument(identity,candidate,current,new Date().toISOString())
  const pdfModule=await import('@/lib/outsourcing-pdf')
  const bundle=await pdfModule.createOutsourcingPdfBundle(model)
  const saved=persistState?await saveRecord(candidate,current):current
  const mail=outsourcingEmailTemplate(model,true)
  const stored=candidate.mail_draft as MailDraft|undefined
  const initialMail=stored||{to:mail.to.join('; '),cc:mail.cc.join('; '),subject:mail.subject,text:mail.text}
  setMailDraft(initialMail);setMailBaseline(JSON.stringify(initialMail))
  setPreparedView({model,pdfUrl:URL.createObjectURL(bundle.executive),annexUrl:URL.createObjectURL(bundle.annex),annexName:pdfModule.annexFilename(model)})
  setRecord(saved);setSpec(candidate);setBaseline(JSON.stringify(candidate));setFiles([])
  contentRef.current?.scrollTo({top:0})
 }
 async function persist(prepare=false) {
  if(actionRef.current||!request||!editable)return
  if(prepare&&issues.length){failValidation();return}
  actionRef.current=true;setBusy(true)
  let working=spec,current=record
  try {
   if(files.length) {
    current=await saveRecord(working,current)
    for(const file of files) {
     const path=`${current.id}/${crypto.randomUUID()}.${file.type==='application/pdf'?'pdf':file.type==='image/png'?'png':'jpg'}`
     const {error}=await db.storage.from('outsourcing').upload(path,file)
     if(error)throw error
     const attachment:OutsourcingAttachment={name:file.name,path}
     working={...working,attachments:[...working.attachments,attachment]};setSpec(working)
     setFiles(p=>p.filter(f=>f!==file))
    }
   }
   current=await saveRecord(working,current)
   setSpec(working);setBaseline(JSON.stringify(working))
   if(prepare)await openPreparation(working,current,true)
   else toast.success('Borrador guardado. Puede reabrirlo sin perder datos.')
   onChanged?.()
  } catch(e) {toast.error(errorMessage(e))} finally {actionRef.current=false;setBusy(false)}
 }
 async function reopenPreparation() {
  if(!record||actionRef.current||dirty)return
  if(issues.length){failValidation();return}
  actionRef.current=true;setBusy(true)
  try{await openPreparation(spec,record,false)}catch(e){toast.error(errorMessage(e))}finally{actionRef.current=false;setBusy(false)}
 }
 async function closePreparation() {
  if(busy||actionRef.current)return
  if(editable&&record) {
   actionRef.current=true;setBusy(true)
   try{const next={...spec,mail_draft:mailDraft};await saveRecord(next,record);setSpec(next);setBaseline(JSON.stringify(next));setPreparedView(null);onChanged?.()}
   catch(e){toast.error(errorMessage(e))}finally{actionRef.current=false;setBusy(false)}
  } else setPreparedView(null)
 }
 async function confirmManual(at:string,reference:string) {
  if(actionRef.current||!request||!record||!editable)return
  if(!Number.isFinite(Date.parse(isoLima(at)))||localDate(new Date(Date.parse(isoLima(at))).toISOString())!==at||Date.parse(isoLima(at))>Date.now()){toast.error('Indique una fecha y hora de envío válidas, sin fechas futuras.');return}
  const prep=spec.preparation as Preparation|undefined
  if(issues.length||prep?.state!=='PREPARED'||prep.revision!==(record.revision||1)||reference.trim().length<5){toast.error('Prepare primero la revisión vigente y registre la referencia del envío.');return}
  if(!window.confirm('¿Registrar su confirmación de envío manual? No se verificará técnicamente la entrega del correo.'))return
  actionRef.current=true;setBusy(true)
  try {
   await verifyReferences(spec)
   const next={...spec,mail_draft:mailDraft,preparation:{...prep,state:'MANUAL_SENT',confirmed_at:new Date().toISOString(),sent_at:isoLima(at),reference:reference.trim(),confirmation_kind:'USER_ATTESTED'}}
   const {data,error}=await db.rpc('outsourcing_submit',{p_request:request.id,p_spec:serializeSpec(next),p_version:record.version,p_note:`Confirmación manual declarada por el usuario; sin verificación técnica de entrega. Fecha declarada: ${isoLima(at)}. Referencia: ${reference.trim()}`})
   if(error)throw error
   setRecord(data as Outsourcing);setSpec(next);setBaseline(JSON.stringify(next));setPreparedView(null)
   setReceipt('Confirmación manual registrada en el historial. No acredita entrega ni lectura del correo. La solicitud está disponible en la bandeja de Compras.');onChanged?.()
  } catch(e){toast.error(errorMessage(e))}finally{actionRef.current=false;setBusy(false)}
 }
 async function view(path:string) {
  const {data,error}=await db.storage.from('outsourcing').createSignedUrl(path,120)
  if(error){toast.error(errorMessage(error));return}
  window.open(data.signedUrl,'_blank','noopener,noreferrer')
 }
 const common={spec,setSpec:updateSpec,issues:showErrors?issues:[],disabled}
 if(typeof document==='undefined')return null
 return createPortal(<div className="ow-backdrop"><div ref={dialogRef} className="ow-modal" role="dialog" aria-modal="true" aria-labelledby="outsourcing-title" aria-busy={busy}>
  <header className="ow-header"><div className="ow-brand">{/* eslint-disable-next-line @next/next/no-img-element */}
  <img src="/logo-jrm.png" alt="JRM" className="h-7 w-auto shrink-0 object-contain"/><div className="ow-brand-separator"/><div><h2 id="outsourcing-title">{preparedView?'Preparar correo para Compras':'Solicitud de tercerización'}</h2><p>Transporte y Distribución | Requerimiento a Compras</p></div></div><div className="ow-header-actions"><span className="ow-status"><FileText/>{status}</span><button type="button" className="ow-close" aria-label="Cerrar solicitud de tercerización" onClick={()=>preparedView?void closePreparation():requestClose()} disabled={busy}><X/></button></div></header>
  <div className="ow-scroll" ref={contentRef}>
   {!preparedView&&<section className="ow-identity" aria-label="Identificación del requerimiento">
    <div className="ow-identity-item"><CalendarCheck/><div><strong>{identity.request}</strong><span>N° Solicitud</span></div></div>
    <div className="ow-identity-item"><FileText/><div><strong>{request?.contracts?.code?`OT ${identity.ot}`:identity.ot}</strong><span>Orden de Trabajo</span></div></div>
    <div className="ow-identity-item ow-client"><Warehouse/><div><strong title={identity.client}>{identity.client}</strong><span>Cliente</span></div></div>
    <div className="ow-identity-item ow-identity-separated"><UserRound/><div><span>Responsable</span><strong className="ow-normal" title={String(spec.responsible || '')}>{String(spec.responsible || 'Por definir')}</strong></div></div>
    <div className="ow-identity-item ow-identity-separated"><ShoppingCart/><div><span>Dirigida a</span><strong className="ow-normal">Compras</strong></div></div>
    <div className="ow-identity-item ow-identity-separated"><Flag/><label>Prioridad<div className="ow-priority-picker" data-priority={String(spec.priority)}><span aria-hidden="true" className="ow-priority-dot"/><select aria-label="Prioridad de la solicitud" value={String(spec.priority)} disabled={disabled} onChange={e=>updateSpec(p=>({...p,priority:e.target.value}))}><option value="NORMAL">NORMAL</option><option value="ALTA">ALTA</option><option value="URGENTE">URGENTE</option></select></div></label></div>
   </section>}
   {loading||!isLoaded?<div className="ow-loading" role="status"><Loader2/>Recuperando solicitud y permisos…</div>:loadError?<div className="ow-loading ow-error" role="alert">{loadError}</div>:preparedView?<EmailPreparation view={preparedView} draft={mailDraft} onChange={setMailDraft} busy={busy} canConfirm={editable} onClose={()=>void closePreparation()} onConfirm={(at,ref)=>void confirmManual(at,ref)}/>:<>
    {record?.review_status==='OBSERVED'&&<p className="ow-notice">Compras observó esta solicitud: {observation || 'Revise el historial.'} Corrija la ficha y vuelva a prepararla.</p>}
    {receipt&&<p className="ow-success" role="status">{receipt}</p>}
    {record&&!dirty&&<p className="ow-saved-state">{status} · Revisión {record.revision||1}. <button type="button" className="ow-text-button" disabled={busy||issues.length>0} onClick={()=>void reopenPreparation()}>Preparar copia de correo y PDF</button></p>}
    {showErrors&&issues.length>0&&<div className="ow-error-summary" role="alert"><strong>Revise {issues.length} campos señalados.</strong><ul>{issues.map((i,n)=><li key={n}><button type="button" onClick={()=>focusIssue(i.field)}>{i.message}</button></li>)}</ul></div>}
    <div className="ow-section-grid">
     <section className="ow-card" aria-labelledby="out-general-title"><h3 id="out-general-title"><Info/>Información general</h3><GeneralSection {...common}/></section>
     <section className="ow-card" aria-labelledby="out-transport-title"><h3 id="out-transport-title"><Truck/>Transporte y carga</h3><TransportSection {...common}/></section>
     <section className="ow-card" aria-labelledby="out-services-title"><h3 id="out-services-title"><Wrench/>Servicios complementarios</h3><ServicesSection {...common}/></section>
     <section className="ow-card" aria-labelledby="out-operations-title"><h3 id="out-operations-title"><ClipboardList/>Condiciones operativas</h3><OperationsSection {...common} files={files} onFiles={selectFiles} onRemoveAttachment={path=>updateSpec(p=>({...p,attachments:p.attachments.filter(a=>a.path!==path)}))} onView={path=>void view(path)}/></section>
    </div>
    <div className="ow-important"><Info/><p><strong>Importante:</strong> Complete los requisitos para Lima o provincias. Use “No aplica” cuando corresponda. El envío valida todos los campos obligatorios.</p></div>
   </>}
  </div>
  {!preparedView&&<footer className="ow-footer"><button type="button" className="ow-button ow-cancel" onClick={requestClose} disabled={busy}><X/>Cancelar</button><div className="ow-footer-right"><button type="button" className="ow-button ow-save" disabled={busy||!editable||loading||!!loadError} onClick={()=>void persist()}><Save/>{busy?'Procesando…':'Guardar borrador'}</button><button type="button" className="ow-button ow-primary" disabled={busy||!editable||loading||!!loadError} onClick={()=>void persist(true)}><Send/>Enviar a Compras</button></div></footer>}
 </div></div>,document.body)
}
