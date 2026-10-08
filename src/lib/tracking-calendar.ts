export type PortalRequest = {
 id: string; request_number: string; ot_code: string | null; created_at: string; required_date: string;
 required_at: string | null; request_type: string; attention_mode: string | null; delivery_zone: string | null;
 lead_time_policy: {enabled?: boolean; zones?: Record<string,{enabled?: boolean;hours?:number}>} | null;
 pickup_address: string; delivery_address: string; status: string
 ot_type?: string | null; parent_ot?: string | null; client_name?: string | null
 reference_type?: string | null; reference_number?: string | null; purchase_order?: string | null
}
export const limaDay = (value: string) => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))
export function monthDays(month: string) {
 const [year,m] = month.split('-').map(Number)
 const first = new Date(Date.UTC(year,m-1,1)); const offset=(first.getUTCDay()+6)%7
 return Array.from({length:42},(_,i)=>new Date(Date.UTC(year,m-1,1-offset+i)).toISOString().slice(0,10))
}
export function requestAnticipation(request: PortalRequest): {label:string;earliest:string|null;color:string} {
 const policy=request.lead_time_policy; const zone=policy?.zones?.[request.delivery_zone || '']
 if(request.request_type!=='DESPACHO'||request.attention_mode==='RECOJO_CLIENTE') return {label:'No aplica',earliest:null,color:'text-slate-500'}
 if(!policy || !request.required_at || !zone || typeof zone.hours!=='number') return {label:'Sin evaluación histórica',earliest:null,color:'text-slate-500'}
 if(!policy.enabled||!zone.enabled) return {label:'Control desactivado',earliest:null,color:'text-slate-500'}
 const registered=new Date(request.created_at).getTime(); const required=new Date(request.required_at).getTime()
 if(!Number.isFinite(registered)||!Number.isFinite(required)) return {label:'Sin hora precisa',earliest:null,color:'text-slate-500'}
 const earliest=new Date(registered+zone.hours*3600000).toISOString(); const compliant=required>=new Date(earliest).getTime()
 return {label:compliant?'Cumple anticipación':'Anticipación insuficiente',earliest,color:compliant?'text-emerald-700':'text-red-700'}
}
export const portalAllowedTime=(value:string|null)=>value?portalTime(new Date(Math.ceil(new Date(value).getTime()/60000)*60000).toISOString()):'—'
export const portalTime=(value:string|null)=>value?new Date(value).toLocaleString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'Sin hora registrada'
