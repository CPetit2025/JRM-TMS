import type { TransportRequest } from '@/components/despacho/programar-ruta/types'
import type { Outsourcing, OutsourcingService, ServiceRequirement, Specification } from './outsourcing'

export type CargoPackage = { id: string; kind: string; quantity: string; length_m: string; width_m: string; height_m: string; weight_kg: string }
export type IntermediateStop = { id: string; address: string }
export type OutsourcingAttachment = { name: string; path: string }
export type WizardSpec = Omit<Specification, 'services'> & {
 service_drafts?: ServiceRequirement[]; services: ServiceRequirement[]; packages: CargoPackage[]; intermediate_stops: IntermediateStop[]; attachments: OutsourcingAttachment[]
}
export type WizardField = { key: string; label: string; type?: 'number' | 'datetime-local' | 'textarea' | 'select'; options?: string[]; optional?: boolean; integer?: boolean }
export type FormIssue = { step: number; field: string; message: string }
export const WIZARD_STEPS = ['Información general','Transporte y carga','Servicios complementarios','Condiciones operativas','Revisión y envío']
export const WIZARD_SUBTITLES = ['Datos principales de la operación.','Especificaciones técnicas de la unidad y mercancía.','Equipos y recursos adicionales requeridos para la operación.','Programación, accesos, documentación y seguridad.','Validación final del requerimiento dirigido a Compras.']
export const UNIT_TYPES = ['Camión','Plataforma','Tráiler','Furgón','Camión baranda','Otros']
export const TRANSPORT_FIELDS: WizardField[] = [
 {key:'unit_type',label:'Tipo de unidad',type:'select',options:UNIT_TYPES}, {key:'unit_count',label:'Cantidad de unidades requeridas',type:'number',integer:true},
 {key:'unit_other',label:'Especifique otro tipo de unidad',optional:true},
 {key:'length_m',label:'Largo útil mínimo (m)',type:'number'},{key:'width_m',label:'Ancho útil mínimo (m)',type:'number'},
 {key:'height_m',label:'Alto útil mínimo (m)',type:'number'},{key:'capacity_t',label:'Capacidad mínima por unidad (t)',type:'number'},
 {key:'cargo_weight_kg',label:'Peso total de mercancía (kg)',type:'number'},{key:'volume_m3',label:'Volumen requerido (m³)',type:'number'},
 {key:'cargo_quantity',label:'Cantidad total de bultos',type:'number',integer:true},{key:'cargo',label:'Descripción de la mercancía',type:'textarea'},
 {key:'packaging',label:'Tipo de embalaje'},{key:'special_conditions',label:'Permisos especiales, sujeción y protección (o No aplica)',type:'textarea'},
 {key:'traffic_restrictions',label:'Restricciones de circulación (o No aplica)'},{key:'technical_notes',label:'Observaciones técnicas',type:'textarea',optional:true},
]
export const OPERATION_FIELDS: WizardField[] = [
 {key:'loading_start',label:'Inicio de ventana de carga',type:'datetime-local'},{key:'loading_end',label:'Fin de ventana de carga',type:'datetime-local'},
 {key:'unloading_start',label:'Inicio de ventana de descarga',type:'datetime-local'},{key:'unloading_end',label:'Fin de ventana de descarga',type:'datetime-local'},
 {key:'loading_window',label:'Ventana horaria de carga / indicaciones'},{key:'unloading_window',label:'Ventana horaria de descarga / indicaciones'},
 {key:'duration_hours',label:'Tiempo estimado de operación (horas)',type:'number'},{key:'schedule_restrictions',label:'Restricciones de horario (o No aplica)'},
 {key:'attention_at',label:'Fecha y hora de atención adicional',type:'datetime-local',optional:true},
 {key:'entry_requirements',label:'Requisitos de ingreso a planta u obra',type:'textarea'},{key:'site_requirements',label:'Requisitos particulares de obra',optional:true},
 {key:'access',label:'Condiciones de acceso',type:'textarea'},{key:'destination_zone',label:'Ámbito del destino',type:'select',options:['Lima','Provincia','Otro']},
 {key:'destination_conditions',label:'Condiciones particulares del destino (o No aplica)',type:'textarea'},
 {key:'max_access_height',label:'Altura máxima de acceso (m)',type:'number',optional:true},
 {key:'dimension_restrictions',label:'Restricciones de dimensiones',optional:true},{key:'maneuver_conditions',label:'Condiciones de maniobra',optional:true},
 {key:'delivery_conditions',label:'Condiciones especiales del punto de entrega',optional:true},
 {key:'documents',label:'Documentación obligatoria / requisitos generales',type:'textarea'},
 {key:'documents_supplier',label:'Documentación del proveedor'},{key:'documents_vehicle',label:'Documentación de la unidad'},
 {key:'documents_driver',label:'Documentación del conductor'},{key:'documents_operators',label:'Documentación de operadores (o No aplica)'},
 {key:'documents_personnel',label:'Documentación de personal complementario (o No aplica)'},
 {key:'safety',label:'EPP y condiciones de seguridad',type:'textarea'},{key:'inductions',label:'Inducciones y requisitos especiales (o No aplica)'},
 {key:'notes',label:'Observaciones e instrucciones especiales para Compras',type:'textarea',optional:true},
]
const number = (key:string,label:string,integer=false): WizardField => ({key,label,type:'number',integer})
const text = (key:string,label:string,optional=false): WizardField => ({key,label,optional})
const date = (key='at',label='Fecha y hora'): WizardField => ({key,label,type:'datetime-local'})
const place: WizardField = {key:'operation_place',label:'Lugar de operación',type:'select',options:['Carga','Descarga','Ambos']}
const operator: WizardField = {key:'operator',label:'Operador',type:'select',options:['Incluido','Requerido por separado']}
export const WIZARD_SERVICE_FIELDS: Partial<Record<OutsourcingService,WizardField[]>> = {
 MONTACARGAS:[number('quantity','Cantidad',true),number('capacity','Capacidad requerida (t)'),number('height','Altura de elevación (m)'),text('type','Tipo de montacargas',true),place,date(),number('hours','Horas estimadas'),operator],
 GRUA:[number('quantity','Cantidad',true),text('type','Tipo de grúa'),number('capacity','Capacidad nominal (t)'),number('load_kg','Peso de la carga a izar (kg)'),number('reach','Alcance requerido (m)'),{...number('lift_height','Altura de izaje (m), si corresponde'),optional:true},text('maneuver','Tipo y condiciones de maniobra'),text('location','Ubicación'),date(),number('hours','Tiempo estimado (horas)'),operator,text('accessories','Accesorios de izaje')],
 STOCKA:[text('type','Tipo de stocka / transpaleta'),number('quantity','Cantidad',true),number('capacity','Capacidad (t)'),text('location','Lugar de uso'),number('hours','Tiempo estimado (horas)'),text('characteristics','Piso, acceso y características requeridas')],
 ESTIBA:[number('workers','Cantidad de trabajadores',true),place,text('location','Lugar'),date(),text('schedule','Horario'),number('hours','Duración estimada (horas)'),text('activities','Actividades de estiba / desestiba'),text('safety','Requisitos de seguridad')],
 OTROS:[text('resource','Descripción del recurso'),number('quantity','Cantidad'),text('unit','Unidad de medida'),text('schedule','Horario')],
}
export const GENERAL_FIELDS: WizardField[] = [{key:'required_at',label:'Fecha y hora requerida',type:'datetime-local'},{key:'pickup',label:'Lugar de recojo'},{key:'delivery',label:'Lugar de entrega'},{key:'responsible',label:'Responsable de la solicitud'}]
export function localDate(value: unknown): string {
 if(typeof value!=='string' || !value) return ''
 if(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return value
 const t=Date.parse(value)
 return Number.isFinite(t) ? new Date(t-5*3600000).toISOString().slice(0,16) : ''
}
export const isoLima = (value: string) => value ? `${localDate(value)}:00-05:00` : ''
export function normalizeSpec(source: Partial<WizardSpec> = {}, request?: TransportRequest): WizardSpec {
 const items=request?.transport_request_items || []
 const time=request?.time_window?.trim() || ''
 const inheritedAt=request?.required_at || (request?.required_date && /^\d{1,2}:\d{2}$/.test(time) ? `${request.required_date.slice(0,10)}T${time.padStart(5,'0')}` : '')
 const defaults = {cargo:items.map(i=>i.description).filter(Boolean).join('; '),schema_version:'2',priority:'NORMAL',unit_count:'1',pickup:request?.pickup_address || '',delivery:request?.delivery_address || '',responsible:request?.requester_name || '',required_at:inheritedAt,intermediate_points:'No aplica',
 cargo_weight_kg:String(request?.estimated_weight || items.reduce((n,i)=>n+Number(i.weight || 0),0) || ''),volume_m3:String(items.reduce((n,i)=>n+Number(i.volume_m3 || 0),0) || ''),cargo_quantity:''}
 const spec = {...defaults,...source,schema_version:'2',services:Array.isArray(source.services) ? source.services.map(s=>({...s,details:{...s.details}})) : [],packages:Array.isArray(source.packages) ? source.packages : [],intermediate_stops:Array.isArray(source.intermediate_stops) ? source.intermediate_stops : [],attachments:Array.isArray(source.attachments) ? source.attachments : []} as WizardSpec
 if(!spec.intermediate_stops.length && typeof spec.intermediate_points==='string' && spec.intermediate_points.trim() && spec.intermediate_points.toLocaleLowerCase('es-PE')!=='no aplica') spec.intermediate_stops=spec.intermediate_points.split('\n').filter(Boolean).map((address,i)=>({id:`legacy-stop-${i}`,address:address.replace(/^\d+\.\s*/, '')}))
 if(spec.unit_type && !UNIT_TYPES.includes(String(spec.unit_type))) {
  const known=UNIT_TYPES.find(t=>t.toLocaleLowerCase('es-PE')===String(spec.unit_type).toLocaleLowerCase('es-PE'))
  if(known)spec.unit_type=known
  else {spec.legacy_unit_type=spec.unit_type;spec.unit_other=spec.unit_type;spec.unit_type='Otros'}
 }
 for(const f of [...GENERAL_FIELDS,...OPERATION_FIELDS].filter(f=>f.type==='datetime-local')) spec[f.key]=localDate(spec[f.key])
 spec.services=spec.services.map(s=>({...s,details:{...s.details,...Object.fromEntries((WIZARD_SERVICE_FIELDS[s.kind] || []).filter(f=>f.type==='datetime-local').map(f=>[f.key,localDate(s.details?.[f.key])]))}}))
 return spec
}
export function serializeSpec(spec:WizardSpec): WizardSpec {
 const out:WizardSpec={...spec,services:spec.services.map(s=>({...s,details:{...s.details}}))}
 for(const f of [...GENERAL_FIELDS,...OPERATION_FIELDS].filter(f=>f.type==='datetime-local')) out[f.key]=isoLima(String(spec[f.key] || ''))
 out.services=out.services.map(s=>({...s,details:{...s.details,...Object.fromEntries((WIZARD_SERVICE_FIELDS[s.kind] || []).filter(f=>f.type==='datetime-local').map(f=>[f.key,isoLima(s.details?.[f.key] || '')]))}}))
 if(spec.intermediate_stops.length) out.intermediate_points=spec.intermediate_stops.map((s,i)=>`${i+1}. ${s.address}`).join('\n')
 return out
}
export function packageTotals(packages:CargoPackage[]) {
 return packages.reduce((sum,p)=>({quantity:sum.quantity+Number(p.quantity || 0),weight:sum.weight+Number(p.quantity || 0)*Number(p.weight_kg || 0),volume:sum.volume+Number(p.quantity || 0)*Number(p.length_m || 0)*Number(p.width_m || 0)*Number(p.height_m || 0)}),{quantity:0,weight:0,volume:0})
}
export function validateWizard(spec:WizardSpec,hasContract=true,hasClient=true): FormIssue[] {
 const issues:FormIssue[]=[]
 const add=(step:number,field:string,message:string)=>issues.push({step,field,message})
 const fields=(list:WizardField[],values:Record<string,unknown>,step:number,prefix='')=>{
  for(const f of list) {
   const value=String(values[f.key] ?? '').trim(), key=prefix+f.key
   if(!value) {if(!f.optional)add(step,key,`Complete ${f.label.toLowerCase()}.`);continue}
   if(f.type==='number' && (!Number.isFinite(Number(value)) || Number(value)<=0 || Number(value)>100000000 || (f.integer && !Number.isInteger(Number(value))))) add(step,key,`${f.label}: ingrese ${f.integer ? 'un entero' : 'un valor'} mayor que cero.`)
   if(f.type==='datetime-local' && (!localDate(value) || !Number.isFinite(Date.parse(isoLima(value))) || localDate(new Date(Date.parse(isoLima(value))).toISOString())!==localDate(value)))add(step,key,`${f.label}: fecha y hora inválidas.`)
   if(f.options && !f.options.includes(value))add(step,key,`${f.label}: seleccione una opción válida.`)
  }
 }
 fields(GENERAL_FIELDS,spec,0)
 if(!hasClient)add(0,'client_id','Vincule un cliente real a la solicitud o a su OT antes de enviar.')
 if(!hasContract)add(0,'contract_id','Vincule una OT antes de enviar a Compras.')
 if(!['NORMAL','ALTA','URGENTE'].includes(String(spec.priority)))add(0,'priority','Seleccione una prioridad válida.')
 if(!String(spec.intermediate_points || '').trim() && !spec.intermediate_stops.length)add(0,'intermediate_points','Indique puntos intermedios o No aplica.')
 spec.intermediate_stops.forEach((s,i)=>{if(!s.address.trim())add(0,`stop.${s.id}`,`Complete el punto intermedio ${i+1}.`)})
 if(spec.transport_required!=='false') {
 fields(TRANSPORT_FIELDS,spec,1)
 if(spec.unit_type==='Otros' && !String(spec.unit_other || '').trim())add(1,'unit_other','Especifique el otro tipo de unidad.')
 const capacity=Number(spec.capacity_t)*Number(spec.unit_count)*1000
 if(capacity>0 && Number(spec.cargo_weight_kg)>capacity)add(1,'capacity_t','El peso total supera la capacidad conjunta de las unidades. Revise cantidad y capacidad; esto no acredita viabilidad técnica.')
 spec.packages.forEach((p,i)=>fields([{key:'kind',label:`Tipo de bulto ${i+1}`},...(['quantity','length_m','width_m','height_m','weight_kg'] as const).map(key=>({key,label:`Bulto ${i+1}: ${key}`,type:'number' as const,integer:key==='quantity'}))],p,1,`package.${p.id}.`))
 if(!spec.packages.length)add(1,'packages','Registre al menos una fila de detalle de bultos.')
 const totals=packageTotals(spec.packages)
 if(spec.packages.length && Math.abs(totals.quantity-Number(spec.cargo_quantity))>0.001)add(1,'cargo_quantity','La cantidad consolidada no coincide con el detalle de bultos.')
 if(spec.packages.length && Math.abs(totals.weight-Number(spec.cargo_weight_kg))>Math.max(0.01,Number(spec.cargo_weight_kg)*0.01))add(1,'cargo_weight_kg','El peso consolidado no coincide con los bultos (tolerancia 1 %).')
 if(spec.packages.length && Math.abs(totals.volume-Number(spec.volume_m3))>Math.max(0.001,Number(spec.volume_m3)*0.01))add(1,'volume_m3','El volumen consolidado no coincide con los bultos (tolerancia 1 %).')
 }
 if(spec.transport_required==='false'&&!spec.services.length)add(2,'services','Seleccione al menos un servicio sin transporte.')
 if(!spec.services.length && spec.services_confirmed!=='true')add(2,'services_confirmed','Seleccione recursos o confirme que no requiere servicios complementarios.')
 spec.services.forEach(s=>{
  fields(WIZARD_SERVICE_FIELDS[s.kind] || [],s.details || {},2,`service.${s.kind}.`)
  if(!s.requirements.trim() || s.requirements.trim().length<5)add(2,`service.${s.kind}.requirements`,`Complete requisitos particulares de ${s.kind} (mínimo 5 caracteres; puede indicar No aplica).`)
  if(s.kind==='GRUA' && Number(s.details?.load_kg)>Number(s.details?.capacity)*1000)add(2,'service.GRUA.capacity','El peso a izar supera la capacidad nominal de la grúa.')
 })
 fields(OPERATION_FIELDS,spec,3)
 if(spec.technical_access==='true' && !['max_access_height','dimension_restrictions','maneuver_conditions','delivery_conditions'].some(key=>String(spec[key] || '').trim()))add(3,'technical_access','Describa al menos una restricción técnica adicional de acceso.')
 for(const kind of ['loading','unloading']) {
  const from=String(spec[`${kind}_start`] || ''),to=String(spec[`${kind}_end`] || '')
  if(from && to && from>=to)add(3,`${kind}_end`,`${kind==='loading' ? 'Carga' : 'Descarga'}: el fin debe ser posterior al inicio.`)
 }
 if(spec.loading_start && spec.unloading_start && String(spec.unloading_start)<String(spec.loading_start))add(3,'unloading_start','La descarga no puede comenzar antes de la carga.')
 if(spec.required_at && spec.loading_start && spec.loading_end && (String(spec.required_at)<String(spec.loading_start)||String(spec.required_at)>String(spec.loading_end)))add(3,'loading_start','La fecha requerida debe estar dentro de la ventana de carga.')
 spec.services.forEach(service=>{
  const at=localDate(service.details?.at),place=service.details?.operation_place
  const start=String(spec[place==='Descarga'?'unloading_start':'loading_start'] || ''),end=String(spec[place==='Carga'?'loading_end':'unloading_end'] || '')
  if(at && start && end && (at<start || at>end))add(2,`service.${service.kind}.at`,`${service.kind}: la atención debe estar dentro de las ventanas operativas de su lugar de operación.`)
 })
 if(spec.transport_required!=='false' && spec.max_access_height && Number(spec.height_m)>Number(spec.max_access_height))add(3,'max_access_height','El alto útil de la unidad excede la altura de acceso declarada. Revise las dimensiones totales del vehículo con el proveedor.')
 if(spec.references_required==='true'&&!spec.attachments.length)add(3,'attachments','Adjunte los documentos de referencia obligatorios antes de preparar la solicitud.')
 if(spec.transport_required!=='false'&&disproportionateUnits(spec)&&String(spec.unit_justification||'').trim().length<10)add(1,'unit_justification','Justifique la cantidad de unidades solicitadas (mínimo 10 caracteres).')
 return issues
}
export function wizardProgress(issues:FormIssue[]) {
 const complete=[0,1,2,3].map(step=>!issues.some(i=>i.step===step));complete.push(complete.every(Boolean))
 return {complete,count:complete.filter(Boolean).length,percent:complete.filter(Boolean).length*20}
}
export function workflowLabel(o:(Pick<Outsourcing,'stage'|'review_status'> & Partial<Pick<Outsourcing,'specification'|'revision'>>) | null) {
 if(o?.review_status==='CANCELLED')return 'Cancelada'
 const prep=o?.specification?.preparation as Preparation | undefined
 if(o?.stage===0&&prep?.state==='PREPARED'&&prep.revision===(o.revision||1))return 'Preparada para envío'
 if(o?.review_status==='OBSERVED')return 'Observada'
 if(!o || o.stage===0)return 'Borrador'
 if(o.stage===1)return prep?.state==='MANUAL_SENT'?'Enviada · confirmación manual':'Recibida en bandeja de Compras'
 if(o.stage===7)return 'Cerrada'
 return o.stage>=5 ? 'Confirmada' : 'En gestión'
}

export type Preparation={state:'PREPARED'|'MANUAL_SENT';revision:number;prepared_at?:string;confirmed_at?:string;reference?:string;confirmation_kind?:'USER_ATTESTED'}
/** Advertencia orientativa: no sustituye la validación técnica de capacidad o cubicaje. */
export function disproportionateUnits(s:WizardSpec) {
 const units=Number(s.unit_count),capacity=Number(s.capacity_t),weight=Number(s.cargo_weight_kg)
 const usable=Number(s.length_m)*Number(s.width_m)*Number(s.height_m),volume=Number(s.volume_m3)
 return units>=2&&capacity>0&&weight>0&&usable>0&&volume>0&&weight/(units*capacity*1000)<0.2&&volume/(units*usable)<0.2
}
export function toggleOutsourcingService(s:WizardSpec,kind:OutsourcingService,checked:boolean):WizardSpec {
 const cache=s.service_drafts||[],existing=s.services.find(x=>x.kind===kind)
 return checked?{...s,services_confirmed:'false',services:existing?s.services:[...s.services,cache.find(x=>x.kind===kind)||{kind,requirements:'',details:{}}],service_drafts:cache.filter(x=>x.kind!==kind)}
  :{...s,services:s.services.filter(x=>x.kind!==kind),service_drafts:existing?[...cache.filter(x=>x.kind!==kind),existing]:cache}
}
export function windowSummary(start:unknown,end:unknown) {
 const a=localDate(start),b=localDate(end)
 return a&&b?`${a.replace('T',' ')} a ${b.replace('T',' ')} (Lima)`:''
}
