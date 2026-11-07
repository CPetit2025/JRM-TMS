'use client'
import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, Mail, ArrowLeft, Loader2 } from 'lucide-react'
import { outsourcingEmailTemplate, type OutsourcingDocument } from '@/lib/outsourcing-document'

type Props={document:OutsourcingDocument;onClose:()=>void}
export function DocumentPreview({document:model,onClose}:Props) {
 const [tab,setTab]=useState<'email'|'pdf'>('email')
 const [result,setResult]=useState<{model:OutsourcingDocument;url:string;error:string}|null>(null)
 const pdf=result?.model===model?result.url:''
 const error=result?.model===model?result.error:''
 const [attempt,setAttempt]=useState(0)
 const mail=useMemo(()=>outsourcingEmailTemplate(model),[model])
 useEffect(()=>{
  let active=true,url=''
  void import('@/lib/outsourcing-pdf').then(m=>m.createOutsourcingPdf(model)).then(blob=>{
   if(!active)return
   url=URL.createObjectURL(blob);setResult({model,url,error:''})
  }).catch(()=>{if(active)setResult({model,url:'',error:'No se pudo generar el PDF. Vuelva a intentarlo.'})})
  return()=>{active=false;if(url)URL.revokeObjectURL(url)}
 },[model,attempt])
 function downloadHtml() {
  const url=URL.createObjectURL(new Blob([mail.html],{type:'text/html;charset=utf-8'}))
  const a=window.document.createElement('a');a.href=url;a.download=model.filename.replace(/\.pdf$/,'.html');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
 }
 return <section className="ow-document-preview" aria-label="Vista previa de la solicitud">
  <div className="ow-preview-toolbar"><button type="button" className="ow-text-button" onClick={onClose}><ArrowLeft/>Volver a revisión</button><div>
   <button type="button" className="ow-button" onClick={downloadHtml}><Download/>Plantilla HTML</button>
   {pdf&&<a className="ow-button" href={pdf} download={model.filename}><Download/>Descargar PDF</a>}
  </div></div>
  <div className="ow-preview-tabs" role="tablist" aria-label="Documento a previsualizar">
   <button id="ow-email-tab" type="button" role="tab" aria-selected={tab==='email'} aria-controls="ow-document-panel" onClick={()=>setTab('email')}><Mail/>Correo</button>
   <button id="ow-pdf-tab" type="button" role="tab" aria-selected={tab==='pdf'} aria-controls="ow-document-panel" onClick={()=>setTab('pdf')}><FileText/>PDF de la solicitud</button>
  </div>
  <p className="ow-preview-notice">Vista previa · No se ha enviado ningún correo. El envío automático requiere conectar Microsoft 365. «Enviar a Compras» registra la solicitud en la bandeja interna.</p>
  <div id="ow-document-panel" role="tabpanel" aria-labelledby={tab==='email'?'ow-email-tab':'ow-pdf-tab'}>
   {tab==='email'?<><details className="ow-envelope-details"><summary>Ver destinatarios, asunto y PDF preparado</summary><dl className="ow-mail-envelope"><div><dt>De</dt><dd>Cuenta Microsoft 365 del usuario que envíe la solicitud · pendiente de autorización</dd></div><div><dt>Para</dt><dd>{mail.to.join('; ')}</dd></div><div><dt>CC</dt><dd>{mail.cc.join('; ')}</dd></div><div><dt>Asunto</dt><dd>{mail.subject}</dd></div><div><dt>PDF preparado</dt><dd>{mail.attachmentName}{!pdf&&!error?' · Generando…':''}</dd></div></dl></details><iframe className="ow-document-frame ow-email-frame" title="Vista previa del correo a Compras" sandbox="" srcDoc={mail.html.replace('https://www.jrmlogistica.app/logo-jrm.png','/logo-jrm.png')}/></>:error?<p role="alert">{error} <button type="button" className="ow-text-button" onClick={()=>{setResult(null);setAttempt(n=>n+1)}}>Reintentar</button></p>:pdf?<><p className="ow-hint">Si su navegador no muestra el PDF, use «Descargar PDF». Los archivos de referencia se enumeran; su contenido se consulta por separado en el TMS.</p><iframe className="ow-document-frame" title="Vista previa del PDF de tercerización" src={`${pdf}#view=FitH`}/></>:<p className="ow-loading" role="status"><Loader2/>Generando ficha técnica en PDF…</p>}
  </div>
  {tab==='email'&&error&&<p role="alert">{error} <button type="button" className="ow-text-button" onClick={()=>{setResult(null);setAttempt(n=>n+1)}}>Reintentar PDF</button></p>}
 </section>
}
