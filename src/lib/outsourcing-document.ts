import { GENERAL_FIELDS, OPERATION_FIELDS, TRANSPORT_FIELDS, WIZARD_SERVICE_FIELDS, localDate, type WizardSpec, type WizardField } from './outsourcing-form'
import { OUTSOURCING_SERVICES, OUTSOURCING_STAGES, type Outsourcing } from './outsourcing'

export const OUTSOURCING_MAIL_TO = ['rruesta@jrmsac.com.pe', 'dramirez@jrmsac.com.pe']
export const OUTSOURCING_MAIL_CC = ['cpetit@jrmsac.com.pe', 'acamargo@jrmsac.com.pe', 'rsolis@jrmsac.com.pe']
export type DocumentIdentity = { request: string; ot: string; client: string }
export type DocumentSection = { title: string; rows: [string, string][] }
export type OutsourcingDocument = {
 identity: DocumentIdentity; number: string; revision: number; status: string; draft: boolean; issuedAt: string
 priority: string; responsible: string; requiredAt: string; pickup: string; delivery: string; services: string
 dispatch: string; id: string | null; filename: string; sections: DocumentSection[]
}
export const documentDate = (value: unknown) => {
 const local = localDate(value)
 return local ? `${local.slice(8,10)}/${local.slice(5,7)}/${local.slice(0,4)} ${local.slice(11,16)} (Lima)` : 'Por definir'
}
const value = (v: unknown) => String(v ?? '').trim() || 'Por definir'
const rows = (fields: WizardField[], spec: Record<string, unknown>): [string,string][] => fields
 .filter(f => !f.optional || String(spec[f.key] ?? '').trim())
 .map(f => [f.label, f.type === 'datetime-local' ? documentDate(spec[f.key]) : value(spec[f.key])])

/** Snapshot único para el correo y su PDF; no cambia la solicitud ni acredita aprobación. */
export function buildOutsourcingDocument(identity: DocumentIdentity, spec: WizardSpec, record: Outsourcing | null, issuedAt: string, pendingFiles: string[] = []): OutsourcingDocument {
 const draft = !record || record.stage === 0
 const status = record?.review_status === 'CANCELLED' ? 'Cancelada' : record?.review_status === 'OBSERVED' ? 'Observada' : draft ? 'Borrador' : OUTSOURCING_STAGES[record.stage] || 'En gestión'
 const number = record ? `ST-${record.number}` : 'Sin número · borrador'
 const revision = record?.revision || 1
 const sections: DocumentSection[] = [
  {title:'1. Información general', rows:[...rows(GENERAL_FIELDS,spec),['Puntos intermedios',spec.intermediate_stops.length ? spec.intermediate_stops.map((s,i)=>`${i+1}. ${s.address}`).join('\n') : value(spec.intermediate_points)]]},
  {title:'2. Transporte y carga',rows:rows(TRANSPORT_FIELDS,spec)},
  {title:'Detalle de bultos',rows:spec.packages.length ? spec.packages.map((p,i)=>[`Bulto ${i+1} · ${p.kind}`,`${p.quantity} unidades · ${p.length_m} × ${p.width_m} × ${p.height_m} m por bulto · ${p.weight_kg} kg por bulto`]) : [['Detalle','Pendiente de registrar']]},
  {title:'3. Servicios complementarios',rows:spec.services.length ? [] : [['Servicios',spec.services_confirmed==='true' ? 'No requeridos' : 'Pendientes de definir']]},
  ...spec.services.map(s=>({title:OUTSOURCING_SERVICES[s.kind],rows:[...rows(WIZARD_SERVICE_FIELDS[s.kind] || [],s.details || {}),['Requisitos particulares',value(s.requirements)]] as [string,string][]})),
  {title:'4. Condiciones operativas',rows:rows(OPERATION_FIELDS,spec)},
  {title:'5. Archivos de referencia',rows:[...spec.attachments.map(a=>['Archivo registrado',a.name] as [string,string]),...pendingFiles.map(name=>['Pendiente de guardar',name] as [string,string])]},
 ]
 if(!sections.at(-1)!.rows.length)sections.at(-1)!.rows.push(['Archivos','Sin archivos de referencia'])
 return {identity:{...identity},number,revision,status,draft,issuedAt,priority:value(spec.priority),responsible:value(spec.responsible),requiredAt:documentDate(spec.required_at),pickup:value(spec.pickup),delivery:value(spec.delivery),services:spec.services.length ? spec.services.map(s=>OUTSOURCING_SERVICES[s.kind]).join(', ') : spec.services_confirmed==='true' ? 'No requeridos' : 'Por definir',dispatch:record?.dispatch_id || 'Pendiente de vincular',id:record?.id || null,filename:`Solicitud-tercerizacion-${(record ? `ST-${record.number}` : identity.request).replace(/[^a-zA-Z0-9_-]/g,'_')}-R${revision}${draft?'-BORRADOR':''}.pdf`,sections}
}
export const escapeEmailHtml = (v: string) => v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export function outsourcingEmailTemplate(d: OutsourcingDocument) {
 const subject = `JRM TMS | ${d.draft?'BORRADOR | ':''}Solicitud de tercerización ${d.number} | OT ${d.identity.ot} | ${d.identity.client}`.replace(/[\r\n]+/g,' ')
 const summary: [string,string][] = [['Solicitud de transporte',d.identity.request],['Cliente',d.identity.client],['Orden de trabajo',d.identity.ot],['Prioridad',d.priority],['Fecha requerida',d.requiredAt],['Recojo',d.pickup],['Entrega',d.delivery],['Servicios complementarios',d.services],['Responsable',d.responsible]]
 const url = d.id ? `https://www.jrmlogistica.app/despacho/tercerizaciones?solicitud=${encodeURIComponent(d.id)}` : null
 const greeting='Estimados Rosa y David:'
 const intro='Solicito gestionar la cotización y contratación del transporte y los servicios complementarios detallados en la solicitud adjunta, considerando las condiciones técnicas y operativas indicadas.'
 const instructions='Agradeceré registrar las cotizaciones, disponibilidad, alcance, exclusiones y costos en el TMS para su evaluación y aprobación antes de confirmar la contratación.'
 const warning='Este requerimiento no constituye una orden de compra ni autoriza la contratación. La adjudicación y los costos requieren la aprobación correspondiente en el TMS.'
 const text=[d.draft?'VISTA PREVIA · BORRADOR, SIN ENVÍO':d.status,greeting,intro,...summary.map(([k,v])=>`${k}: ${v}`),`PDF de la solicitud: ${d.filename}`,instructions,url?`Consultar solicitud (requiere acceso al TMS): ${url}`:'El enlace de seguimiento estará disponible al guardar la solicitud.',warning,'Atentamente,',d.responsible,'Transporte y Distribución | JRM'].join('\n\n')
 const e=escapeEmailHtml
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:#172b46"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;margin:auto;background:#fff;border:1px solid #dce4ef;border-radius:12px"><tr><td style="padding:24px 28px;border-bottom:4px solid #e51d35"><img src="https://www.jrmlogistica.app/logo-jrm.png" width="96" alt="JRM" style="display:block;height:auto"><p style="font-size:11px;letter-spacing:2px;color:#58708e;margin:18px 0 6px">TRANSPORTE Y DISTRIBUCIÓN · COMPRAS</p><h1 style="font-size:24px;line-height:1.3;margin:0;color:#002b61">Solicitud de tercerización</h1><p style="font-size:13px;margin:8px 0 0">${e(d.number)} · Revisión ${d.revision} · ${e(d.status)}</p></td></tr><tr><td style="padding:24px 28px;font-size:14px;line-height:1.65">${d.draft?'<p style="background:#fff3d6;padding:12px;color:#735000"><b>Vista previa de borrador.</b> No se ha enviado ningún correo.</p>':''}<p>${greeting}</p><p>${intro}</p><table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dce4ef;border-collapse:collapse">${summary.map(([k,v],i)=>`<tr style="background:${i%2?'#fff':'#f5f8fc'}"><th align="left" valign="top" style="width:34%;padding:9px 12px;border-bottom:1px solid #e5eaf2;font-size:12px;color:#526581">${e(k)}</th><td style="padding:9px 12px;border-bottom:1px solid #e5eaf2;font-size:13px;overflow-wrap:anywhere">${e(v).replace(/\n/g,'<br>')}</td></tr>`).join('')}</table><p style="padding:12px;background:#edf4ff;color:#003b83"><b>Ficha técnica en PDF</b><br>${e(d.filename)}<br><span style="font-size:12px">Transporte, carga, recursos, condiciones operativas y relación de archivos de referencia.</span></p><p>${instructions}</p>${url?`<p><a href="${e(url)}" style="display:inline-block;background:#003b83;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">Consultar solicitud en TMS</a></p><p style="font-size:11px;color:#526581">Requiere una cuenta autorizada en el TMS.</p>`:''}<p style="font-size:12px;color:#526581;border-top:1px solid #dce4ef;padding-top:16px">${warning}</p><p>Atentamente,<br><b>${e(d.responsible)}</b><br>Transporte y Distribución | JRM</p></td></tr><tr><td style="padding:16px 28px;background:#f5f8fc;font-size:11px;color:#62748c">JRM TMS · Requerimiento vinculado a la OT y al proceso de Compras.<br>Los archivos de referencia permanecen en el TMS y se consultan con los permisos correspondientes.</td></tr></table></td></tr></table></body></html>`
 return {to:[...OUTSOURCING_MAIL_TO],cc:[...OUTSOURCING_MAIL_CC],subject,html,text,attachmentName:d.filename}
}
