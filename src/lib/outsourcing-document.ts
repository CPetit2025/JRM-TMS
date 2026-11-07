import { workflowLabel } from './outsourcing-form'
import { GENERAL_FIELDS, OPERATION_FIELDS, TRANSPORT_FIELDS, WIZARD_SERVICE_FIELDS, localDate, type WizardSpec, type WizardField } from './outsourcing-form'
import { OUTSOURCING_SERVICES, type Outsourcing } from './outsourcing'

export const OUTSOURCING_MAIL_TO = ['rruesta@jrmsac.com.pe', 'dramirez@jrmsac.com.pe']
export const OUTSOURCING_MAIL_CC = ['cpetit@jrmsac.com.pe', 'acamargo@jrmsac.com.pe', 'rsolis@jrmsac.com.pe']
export type DocumentIdentity = { request: string; ot: string; client: string }
export type DocumentSection = { title: string; rows: [string, string][] }
export type OutsourcingDocument = {
 identity: DocumentIdentity; number: string; revision: number; status: string; draft: boolean; issuedAt: string
 priority: string; responsible: string; requiredAt: string; pickup: string; delivery: string; services: string
 executive: {service:[string,string][];cargo:[string,string][];resources:string[][];operations:[string,string][];attachments:string[];pending:string[]}; dispatch: string; id: string | null; filename: string; sections: DocumentSection[]
}
export const documentDate = (value: unknown) => {
 const local = localDate(value)
 return local ? `${local.slice(8,10)}/${local.slice(5,7)}/${local.slice(0,4)} ${local.slice(11,16)} (Lima)` : 'Por definir'
}
const value = (v: unknown) => String(v ?? '').trim() || 'Por definir'
const rows = (fields: WizardField[], spec: Record<string, unknown>): [string,string][] => fields
 .filter(f => !f.optional || String(spec[f.key] ?? '').trim())
 .map(f => [f.label, f.type === 'datetime-local' ? documentDate(spec[f.key]) : value(spec[f.key])])

const compactRange=(start:unknown,end:unknown)=>{
 const a=localDate(start),b=localDate(end)
 if(!a||!b)return 'Pendiente de definir'
 const date=(v:string)=>`${v.slice(8,10)}/${v.slice(5,7)}/${v.slice(0,4)}`
 return `${date(a)} ${a.slice(11,16)} a ${a.slice(0,10)===b.slice(0,10)?'':date(b)+' '}${b.slice(11,16)} (Lima)`
}
const resourceTime=(at:string|undefined)=>{const v=localDate(at);return v?`${v.slice(8,10)}/${v.slice(5,7)} ${v.slice(11,16)}`:''}

/** Snapshot único para el correo y su PDF; no cambia la solicitud ni acredita aprobación. */
export function buildOutsourcingDocument(identity: DocumentIdentity, spec: WizardSpec, record: Outsourcing | null, issuedAt: string, pendingFiles: string[] = []): OutsourcingDocument {
 const status=workflowLabel(record?{...record,specification:spec}:null)
 const draft = status==='Borrador'||status==='Observada'
 const number = record ? `ST-${record.number}` : 'Sin número · borrador'
 const revision = record?.revision || 1
 const joined=(keys:string[])=>keys.map(k=>String(spec[k]||'').trim()).filter(Boolean).join(' · ')
 const executive={
  service:[['Transporte',`${value(spec.unit_count)} × ${value(spec.unit_type==='Otros'?spec.unit_other:spec.unit_type)}`],['Fecha requerida',documentDate(spec.required_at)],['Origen',value(spec.pickup)],['Destino',value(spec.delivery)],['Puntos intermedios',spec.intermediate_stops.length?spec.intermediate_stops.map(s=>s.address).join(' > '):value(spec.intermediate_points)]] as [string,string][],
  cargo:[['Mercancía',value(spec.cargo)],['Peso / volumen',`${value(spec.cargo_weight_kg)} kg / ${value(spec.volume_m3)} m³`],['Bultos / embalaje',`${value(spec.cargo_quantity)} / ${value(spec.packaging)}`],['Dimensiones útiles',`${value(spec.length_m)} × ${value(spec.width_m)} × ${value(spec.height_m)} m`],['Capacidad / unidad',`${value(spec.capacity_t)} t`],['Restricciones',joined(['special_conditions','traffic_restrictions','technical_notes'])||'No aplica'],['Justificación unidades',value(spec.unit_justification)]] as [string,string][],
  resources:spec.services.map(s=>{const t=s.details||{};const capacity=t.capacity?`${t.capacity} t`:'';return [OUTSOURCING_SERVICES[s.kind],t.quantity||t.workers||'Por definir',[t.type,t.resource,capacity,t.reach?`Alcance ${t.reach} m`:'',t.height?`Elevación ${t.height} m`:'',t.operator?`Operador: ${t.operator}`:'',t.activities,s.requirements].filter(Boolean).join(' · '),t.operation_place||t.location||'Por definir',[resourceTime(t.at),t.schedule,t.hours?`${t.hours} h`:''].filter(Boolean).join(' · ')||'Por definir']}),
  operations:[['Carga',compactRange(spec.loading_start,spec.loading_end)],['Descarga',compactRange(spec.unloading_start,spec.unloading_end)],['Duración / ámbito',`${value(spec.duration_hours)} h · ${value(spec.destination_zone)}`],['Acceso / ingreso',joined(['entry_requirements','access','destination_conditions','max_access_height','dimension_restrictions','maneuver_conditions','delivery_conditions'])],['Documentación',joined(['documents','documents_supplier','documents_vehicle','documents_driver','documents_operators','documents_personnel'])],['Seguridad',joined(['safety','inductions'])],['Observaciones',joined(['notes','schedule_restrictions'])||'No aplica']] as [string,string][],
  attachments:spec.attachments.map(a=>a.name),pending:pendingFiles,
 }
 if(!String(spec.unit_justification||'').trim())executive.cargo=executive.cargo.filter(r=>r[0]!=='Justificación unidades')
 const sections: DocumentSection[] = [
  {title:'1. Información general', rows:[...rows(GENERAL_FIELDS,spec),['Puntos intermedios',spec.intermediate_stops.length ? spec.intermediate_stops.map((s,i)=>`${i+1}. ${s.address}`).join('\n') : value(spec.intermediate_points)]]},
  {title:'2. Transporte y carga',rows:[...rows(TRANSPORT_FIELDS,spec),...(spec.unit_justification?[['Justificación de unidades',String(spec.unit_justification)] as [string,string]]:[])]},
  {title:'Detalle de bultos',rows:spec.packages.length ? spec.packages.map((p,i)=>[`Bulto ${i+1} · ${p.kind}`,`${p.quantity} unidades · ${p.length_m} × ${p.width_m} × ${p.height_m} m por bulto · ${p.weight_kg} kg por bulto`]) : [['Detalle','Pendiente de registrar']]},
  {title:'3. Servicios complementarios',rows:spec.services.length ? [] : [['Servicios',spec.services_confirmed==='true' ? 'No requeridos' : 'Pendientes de definir']]},
  ...spec.services.map(s=>({title:OUTSOURCING_SERVICES[s.kind],rows:[...rows(WIZARD_SERVICE_FIELDS[s.kind] || [],s.details || {}),['Requisitos particulares',value(s.requirements)]] as [string,string][]})),
  {title:'4. Condiciones operativas',rows:rows(OPERATION_FIELDS,spec)},
  {title:'5. Archivos de referencia',rows:[...spec.attachments.map(a=>['Archivo registrado',a.name] as [string,string]),...pendingFiles.map(name=>['Pendiente de guardar',name] as [string,string])]},
 ]
 if(!sections.at(-1)!.rows.length)sections.at(-1)!.rows.push(['Archivos','Sin archivos de referencia'])
 return {executive,identity:{...identity},number,revision,status,draft,issuedAt,priority:value(spec.priority),responsible:value(spec.responsible),requiredAt:documentDate(spec.required_at),pickup:value(spec.pickup),delivery:value(spec.delivery),services:spec.services.length ? spec.services.map(s=>OUTSOURCING_SERVICES[s.kind]).join(', ') : spec.services_confirmed==='true' ? 'No requeridos' : 'Por definir',dispatch:record?.dispatch_id || 'Pendiente de vincular',id:record?.id || null,filename:`Solicitud-tercerizacion-${(record ? `ST-${record.number}` : identity.request).replace(/[^a-zA-Z0-9_-]/g,'_')}-R${revision}${draft?'-BORRADOR':''}.pdf`,sections}
}
export const escapeEmailHtml = (v: string) => v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export function outsourcingEmailTemplate(d: OutsourcingDocument, pdfAvailable=false) {
 const subject=`SOLICITUD DE TERCERIZACIÓN | RT-${d.identity.request.replace(/^RT-/i,'')} | OT ${d.identity.ot} | ${d.identity.client}`.replace(/[\r\n]+/g,' ')
 const short=(v:string,max=280)=>v.length>max?v.slice(0,max)+'… (ver ficha técnica y anexo)':v
 const text=[
 'Estimados, buenos días:',
 `Solicito su apoyo con la gestión de tercerización correspondiente a la OT ${d.identity.ot} del cliente ${d.identity.client}, de acuerdo con el siguiente requerimiento:`,
 `Datos del servicio\nFecha requerida: ${d.requiredAt}\nOrigen: ${short(d.pickup)}\nDestino: ${short(d.delivery)}\nTransporte requerido: ${d.executive.service[0][1]}\nCarga: ${short(d.executive.cargo[0][1])}; ${d.executive.cargo[1][1]}`,
 `Recursos complementarios\n${d.executive.resources.length?d.executive.resources.map(r=>`- ${r[0]}: ${r[1]}; ${short(r[2],160)}; ${short(r[3],70)}`).join('\n'):'No se requieren servicios complementarios.'}`,
 `Condiciones particulares\n${short(d.executive.operations.map(([k,v])=>`${k}: ${v}`).join('\n'),700)}`,
 pdfAvailable?'Adjunto la ficha técnica con las especificaciones del servicio para su revisión y gestión de cotización. Cuando corresponda, acompaña el anexo técnico con el detalle completo.':'La ficha técnica está pendiente de generar. No se declara ningún PDF adjunto.',
 'Agradeceré confirmar la disponibilidad, condiciones del servicio y propuesta económica correspondiente.',
 `Saludos,\n${d.responsible}`,
 ].join('\n\n')
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;color:#172b46;max-width:700px;margin:24px auto;line-height:1.5"><h2 style="color:#002b61">Solicitud de tercerización</h2><div style="white-space:pre-wrap">${escapeEmailHtml(text)}</div></body></html>`
 return {to:[...OUTSOURCING_MAIL_TO],cc:[...OUTSOURCING_MAIL_CC],subject,text,html,attachmentName:pdfAvailable?d.filename:''}
}
