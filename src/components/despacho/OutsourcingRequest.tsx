'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarCheck, ChevronLeft, ChevronRight, ClipboardList, FileText, Flag, Info, Loader2, MapPin, Save, Send, ShoppingCart, Truck, UserRound, Warehouse, Wrench, X, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage } from '@/lib/caja'
import type { TransportRequest } from './programar-ruta/types'
import { OUTSOURCING_SERVICES, type Outsourcing } from '@/lib/outsourcing'
import { normalizeSpec, serializeSpec, validateWizard, wizardProgress, workflowLabel, WIZARD_STEPS, WIZARD_SUBTITLES, type WizardSpec, type OutsourcingAttachment } from '@/lib/outsourcing-form'
import { GeneralStep, TransportStep, ServicesStep, OperationsStep, ReviewStep } from './outsourcing/WizardSteps'
import './outsourcing/wizard.css'

const STEP_ICONS=[FileText,Truck,Wrench,ClipboardList,Send]
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
 const [step,setStep]=useState(0)
 const [showErrors,setShowErrors]=useState(false)
 const [observation,setObservation]=useState('')
 const [receipt,setReceipt]=useState('')
 const dialogRef=useRef<HTMLDivElement>(null)
 const contentRef=useRef<HTMLDivElement>(null)
 const actionRef=useRef(false)
 const closeRef=useRef<()=>void>(()=>{})
 const dirty=JSON.stringify(spec)!==baseline||files.length>0
 const editable=(!record||record.stage===0)&&record?.review_status!=='CANCELLED'&&canWrite('despacho')
 const disabled=busy||!editable
 const identity={request:request?.request_number || '—',ot:request?.contracts?.code || 'Sin OT',client:request?.request_client?.business_name || request?.contracts?.clients?.business_name || 'Sin cliente'}
 const issues=useMemo(()=>validateWizard(spec,!!request?.contract_id,identity.client!=='Sin cliente'),[spec,request?.contract_id,identity.client])
 const progress=wizardProgress(issues)
 const status=workflowLabel(record)
 const requestClose=useCallback(()=>{if(busy)return;if(dirty&&!window.confirm('Hay cambios sin guardar. ¿Desea cerrar y descartarlos?'))return;onClose()},[busy,dirty,onClose])
 useEffect(()=>{closeRef.current=requestClose},[requestClose])
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
   const nodes=Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])
   const first=nodes[0],last=nodes.at(-1)
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
  }
  document.addEventListener('keydown',keyboard)
  return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keyboard);previous?.focus()}
 },[])
 useEffect(()=>{
  if(!dirty)return
  const prevent=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''}
  window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)
 },[dirty])
 function navigate(next:number) {setStep(next);contentRef.current?.scrollTo({top:0,behavior:'instant'})}
 function selectFiles(next:File[]) {
  if(next.some(f=>f.size>10485760||!['application/pdf','image/png','image/jpeg'].includes(f.type))){toast.error('Adjunte únicamente PDF, PNG o JPG de hasta 10 MB por archivo.');return}
  setFiles(next)
 }
 async function saveRecord(value:WizardSpec,current:Outsourcing|null) {
  const {data,error}=await db.rpc('outsourcing_save',{p_request:request!.id,p_spec:serializeSpec(value),p_version:current?.version ?? null})
  if(error)throw error
  const result=await db.from('transport_outsourcing').select('*').eq('id',data).single()
  if(result.error)throw result.error
  setRecord(result.data);return result.data as Outsourcing
 }
 async function persist(send=false) {
  if(actionRef.current||!request||!editable)return
  setShowErrors(send)
  if(send&&issues.length){navigate(4);toast.error('Revise los campos pendientes antes de enviar a Compras.');return}
  if(send&&!window.confirm('¿Enviar este requerimiento a Compras? La ficha técnica quedará registrada para su gestión.'))return
  actionRef.current=true;setBusy(true)
  let working=spec,current=record
  try {
   if(files.length) {
    current=await saveRecord(working,current)
    const uploaded:OutsourcingAttachment[]=[]
    for(const file of files) {
     const path=`${current.id}/${crypto.randomUUID()}.${file.type==='application/pdf'?'pdf':file.type==='image/png'?'png':'jpg'}`
     const {error}=await db.storage.from('outsourcing').upload(path,file)
     if(error)throw error
     uploaded.push({name:file.name,path})
     working={...working,attachments:[...spec.attachments,...uploaded]};setSpec(working)
     setFiles(p=>p.filter(f=>f!==file))
    }
   }
   if(send) {
    const {data,error}=await db.rpc('outsourcing_submit',{p_request:request.id,p_spec:serializeSpec(working),p_version:current?.version ?? null,p_note:'Requerimiento técnico revisado y enviado a Compras desde el asistente.'})
    if(error)throw error
    current=data as Outsourcing
    setReceipt(`ST-${current.number} enviada a la bandeja de Compras. Fecha y responsable registrados en el historial.`)
   } else current=await saveRecord(working,current)
   setRecord(current);setSpec(working);setBaseline(JSON.stringify(working));setFiles([])
   toast.success(send?'Solicitud enviada a Compras.':'Borrador guardado. Puede continuar y reabrirlo sin perder datos.')
   onChanged?.()
  } catch(e) {toast.error(errorMessage(e))} finally {actionRef.current=false;setBusy(false)}
 }
 async function view(path:string) {
  const {data,error}=await db.storage.from('outsourcing').createSignedUrl(path,120)
  if(error){toast.error(errorMessage(error));return}
  window.open(data.signedUrl,'_blank','noopener,noreferrer')
 }
 const common={spec,setSpec,issues:showErrors?issues:[],disabled}
 const Icon=step===0?Info:STEP_ICONS[step]
 if(typeof document==='undefined')return null
 return createPortal(<div className="ow-backdrop"><div ref={dialogRef} className="ow-modal" role="dialog" aria-modal="true" aria-labelledby="outsourcing-title" aria-busy={busy}>
  <header className="ow-header"><div className="ow-brand">{/* eslint-disable-next-line @next/next/no-img-element */}
  <img src="/logo-jrm.png" alt="JRM" className="h-7 w-auto shrink-0 object-contain"/><div className="ow-brand-separator"/><div><h2 id="outsourcing-title">Solicitud de tercerización</h2><p>Registro y envío de requerimiento a Compras</p></div></div><div className="ow-header-actions"><span className="ow-status"><FileText/>{status}</span><button type="button" className="ow-close" aria-label="Cerrar solicitud de tercerización" onClick={requestClose} disabled={busy}><X/></button></div></header>
  <div className="ow-scroll" ref={contentRef}>
   <section className="ow-identity" aria-label="Identificación del requerimiento">
    <div className="ow-identity-item"><CalendarCheck/><div><strong>{identity.request}</strong><span>N° Solicitud</span></div></div>
    <div className="ow-identity-item"><FileText/><div><strong>{request?.contracts?.code?`OT ${identity.ot}`:identity.ot}</strong><span>Orden de Trabajo</span></div></div>
    <div className="ow-identity-item ow-client"><Warehouse/><div><strong title={identity.client}>{identity.client}</strong><span>Cliente</span></div></div>
    <div className="ow-identity-item ow-identity-separated"><UserRound/><div><span>Responsable</span><strong className="ow-normal" title={String(spec.responsible || '')}>{String(spec.responsible || 'Por definir')}</strong></div></div>
    <div className="ow-identity-item ow-identity-separated"><ShoppingCart/><div><span>Dirigida a</span><strong className="ow-normal">Compras</strong></div></div>
    <div className="ow-identity-item ow-identity-separated"><Flag/><label>Prioridad<div className="ow-priority-picker" data-priority={String(spec.priority)}><span aria-hidden="true" className="ow-priority-dot"/><select aria-label="Prioridad de la solicitud" value={String(spec.priority)} disabled={disabled} onChange={e=>setSpec(p=>({...p,priority:e.target.value}))}><option value="NORMAL">NORMAL</option><option value="ALTA">ALTA</option><option value="URGENTE">URGENTE</option></select></div></label></div>
   </section>
   <nav className="ow-tabs" aria-label="Secciones de la solicitud">{WIZARD_STEPS.map((name,i)=>{const TabIcon=STEP_ICONS[i];return <button type="button" key={name} aria-current={step===i?'step':undefined} aria-label={`${i+1}. ${name}${progress.complete[i]?', completa':', pendiente'}`} className={step===i?'is-active':''} onClick={()=>navigate(i)} disabled={busy}><span className="ow-step-number">{i+1}</span><TabIcon/><span>{name}</span></button>})}</nav>
   {loading||!isLoaded?<div className="ow-loading" role="status"><Loader2/>Recuperando solicitud y permisos…</div>:loadError?<div className="ow-loading ow-error" role="alert">{loadError}</div>:<div className="ow-columns">
    <main className="ow-card ow-form-card"><div className="ow-card-heading"><span className="ow-heading-icon"><Icon/></span><div><h3>{WIZARD_STEPS[step]}</h3><p>{WIZARD_SUBTITLES[step]}</p></div></div>
     {record?.review_status==='OBSERVED'&&<p className="ow-notice">Compras observó esta solicitud: {observation || 'Revise el historial de observaciones.'} Corrija la ficha y vuelva a enviarla.</p>}
     {receipt&&<p className="ow-success" role="status">{receipt}</p>}
     {!editable&&<p className="ow-notice">Consulta de la ficha registrada. El avance, responsables y evidencias están en la bandeja de Tercerizaciones · Compras.</p>}
     {step===0&&<GeneralStep {...common}/>}{step===1&&<TransportStep {...common}/>}{step===2&&<ServicesStep {...common}/>}{step===3&&<OperationsStep {...common}/>}{step===4&&<ReviewStep spec={spec} issues={issues} onEdit={navigate} files={files} onFiles={selectFiles} onRemoveAttachment={path=>setSpec(p=>({...p,attachments:p.attachments.filter(a=>a.path!==path)}))} onView={path=>void view(path)} disabled={disabled} identity={identity}/>}
     {showErrors&&step<4&&issues.some(i=>i.step===step)&&<div className="ow-step-issues" role="alert"><strong>Revise esta sección</strong><ul>{issues.filter(i=>i.step===step).map((i,n)=><li key={n}>{i.message}</li>)}</ul></div>}
    </main>
    <aside className="ow-card ow-summary"><h3><FileText/>Resumen de la solicitud</h3><dl>{[[Warehouse,'Cliente',identity.client],[ClipboardList,'OT',identity.ot],[Flag,'Prioridad',<span key="priority" className="ow-priority">{String(spec.priority)==='NORMAL'?'Normal':String(spec.priority)==='ALTA'?'Alta':'Urgente'}</span>],[MapPin,'Origen',String(spec.pickup||'No definido')],[MapPin,'Destino',String(spec.delivery||'No definido')],[Wrench,'Servicios',spec.services.length?spec.services.map(s=>OUTSOURCING_SERVICES[s.kind]).join(', '):spec.services_confirmed==='true'?'No requeridos':'No definido'],[Clock,'Estado',<span key="status" className="ow-summary-status">{status}</span>]].map(([RowIcon,label,value])=>{const Row=RowIcon as typeof FileText;return <div key={String(label)}><dt><Row/>{String(label)}</dt><dd>{value as React.ReactNode}</dd></div>})}</dl>
     <div className="ow-progress"><strong>Avance del registro</strong><div className="ow-progress-row"><div role="progressbar" aria-label="Avance del registro" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${progress.percent}%`}}/></div><b>{progress.percent} %</b></div><p>{progress.count} de 5 secciones completadas</p></div>
     {step!==4&&issues.some(i=>i.step===step)&&<p className="ow-summary-hint">Puede avanzar y guardar parcialmente. Los datos pendientes se validan antes del envío.</p>}
    </aside>
   </div>}
  </div>
  <footer className="ow-footer"><button type="button" className="ow-button ow-cancel" onClick={requestClose} disabled={busy}><X/>Cancelar</button><div className="ow-footer-right"><button type="button" className="ow-button ow-save" disabled={busy||!editable||loading||!!loadError} onClick={()=>void persist()}><Save/>{busy?'Guardando…':'Guardar borrador'}</button><button type="button" className="ow-button ow-previous" disabled={step===0||busy||loading} onClick={()=>navigate(step-1)}><ChevronLeft/>Anterior</button>{step<4?<button type="button" className="ow-button ow-primary" disabled={busy||loading||!!loadError} onClick={()=>navigate(step+1)}>Siguiente<ChevronRight/></button>:<button type="button" className="ow-button ow-primary" disabled={busy||!editable||loading||!!loadError} onClick={()=>void persist(true)}><Send/>Enviar a Compras</button>}</div></footer>
 </div></div>,document.body)
}
