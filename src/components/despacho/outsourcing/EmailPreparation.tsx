'use client'
import { useState } from 'react'
import { Copy, Download, Check, X, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { type OutsourcingDocument } from '@/lib/outsourcing-document'
import { localDate } from '@/lib/outsourcing-form'
export type MailDraft={to:string;cc:string;subject:string;text:string}
export type PreparedView={model:OutsourcingDocument;pdfUrl:string;annexUrl:string;annexName:string}
export function EmailPreparation({view,draft,onChange,onClose,onConfirm,busy,canConfirm}:{view:PreparedView;draft:MailDraft;onChange:(draft:MailDraft)=>void;onClose:()=>void;onConfirm:(at:string,reference:string)=>void;busy:boolean;canConfirm:boolean}) {
 const [copied,setCopied]=useState(''),[ack,setAck]=useState(false),[sentAt,setSentAt]=useState(()=>localDate(new Date().toISOString())),[reference,setReference]=useState('')
 async function copy(label:string,text:string) {
  try {await navigator.clipboard.writeText(text);setCopied(label);toast.success(`${label} copiado.`)}
  catch {toast.error('El navegador no permitió copiar. Seleccione el texto y use Ctrl+C.');setCopied('')}
 }
 return <section className="ow-preparation" aria-label="Preparar correo para Compras">
  <p className="ow-notice">Preparada para copiar y descargar. No se ha enviado ningún correo desde el TMS. Adjunte el PDF ejecutivo, el anexo y los archivos de referencia en su cliente de correo.</p>
  <div className="ow-mail-addresses"><label>Destinatario<input className="ow-control" value={draft.to} onChange={e=>onChange({...draft,to:e.target.value})}/></label><label>Con copia a<input className="ow-control" value={draft.cc} onChange={e=>onChange({...draft,cc:e.target.value})}/></label></div>
  <label className="ow-mail-field">Asunto<input className="ow-control" value={draft.subject} onChange={e=>onChange({...draft,subject:e.target.value})}/></label>
  <label className="ow-mail-field">Cuerpo del correo<textarea aria-label="Cuerpo del correo" className="ow-control ow-mail-body" value={draft.text} onChange={e=>onChange({...draft,text:e.target.value})}/></label>
  <div className="ow-copy-actions">{[['Asunto',draft.subject],['Mensaje',draft.text],['Correo completo',`Para: ${draft.to}\nCC: ${draft.cc}\nAsunto: ${draft.subject}\n\n${draft.text}`]].map(([label,text])=><button type="button" className="ow-button" key={label} disabled={busy} onClick={()=>void copy(label,text)}>{copied===label?<Check/>:<Copy/>}Copiar {label.toLowerCase()}</button>)}</div>
  <div className="ow-prepared-files"><h3><FileText/>Documentos generados</h3><a className="ow-button ow-primary" href={view.pdfUrl} download={view.model.filename}><Download/>Descargar PDF ejecutivo</a><a className="ow-button" href={view.annexUrl} download={view.annexName}><Download/>Descargar anexo técnico</a><p>{view.model.filename}</p><p>{view.annexName} · detalle completo de requisitos y bultos</p>
  <h4>Archivos de referencia disponibles en el registro</h4>{view.model.executive.attachments.length?<ul>{view.model.executive.attachments.map((name,i)=><li key={i}>{name}</li>)}</ul>:<p>No hay archivos de referencia vinculados.</p>}
  <details className="ow-details"><summary>Vista previa del PDF ejecutivo · A4 horizontal, una página</summary><iframe title="Vista previa del PDF ejecutivo" src={`${view.pdfUrl}#view=FitH`} className="ow-document-frame"/></details></div>
  {canConfirm&&<details className="ow-details ow-manual-confirmation"><summary>Registrar posteriormente una confirmación de envío manual</summary><p className="ow-hint">Use esta opción después de enviar el correo desde Outlook. Registra su declaración y habilita la gestión en Compras; no equivale a una verificación técnica ni acredita entrega o lectura.</p><label>Fecha y hora del envío (Lima)<input className="ow-control" type="datetime-local" value={sentAt} onChange={e=>setSentAt(e.target.value)}/></label><label>Referencia del envío (asunto, ID de mensaje o evidencia)<textarea className="ow-control" value={reference} onChange={e=>setReference(e.target.value)}/></label><label className="ow-none-service"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} disabled={busy}/>Confirmo que envié manualmente este correo con su documentación.</label><button type="button" className="ow-button" disabled={busy||!ack||reference.trim().length<5||!sentAt} onClick={()=>onConfirm(sentAt,reference)}><Check/>Registrar confirmación manual</button></details>}
  <div className="ow-preparation-close"><button type="button" className="ow-button" onClick={onClose} disabled={busy}><X/>Cerrar preparación</button></div>
 </section>
}
