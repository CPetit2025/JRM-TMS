'use client'
import type { ReactNode } from 'react'
import { CalendarDays, MapPin, UserRound } from 'lucide-react'
import { localDate } from '@/lib/outsourcing-form'
import type { WizardField, FormIssue } from '@/lib/outsourcing-form'

export function WizardFieldControl({field,value,onChange,error,disabled=false,icon}: {field:WizardField;value:unknown;onChange:(value:string)=>void;error?:string;disabled?:boolean;icon?:ReactNode}) {
 const id=`out-${field.key}`
 const dateParts=field.type==='datetime-local' ? localDate(value).split('T') : []
 const dateText=dateParts[0] ? `${dateParts[0].slice(8,10)}/${dateParts[0].slice(5,7)}/${dateParts[0].slice(0,4)} ${dateParts[1]}` : 'dd/mm/aaaa hh:mm'
 const props={id,'aria-label':field.label,value:String(value ?? ''),disabled,'aria-invalid':!!error,'aria-describedby':error ? `${id}-error` : undefined,onChange:(e:{target:{value:string}})=>onChange(e.target.value),className:`ow-control ${icon ? 'ow-with-icon' : ''} ${field.type==='datetime-local'?'ow-date':''}`}
 return <div className={`ow-field ${field.type==='textarea' ? 'ow-wide' : ''}`}>
  <label htmlFor={id}>{field.label}{!field.optional && <span className="ow-required"> *</span>}</label>
  <div className="ow-input-wrap">{icon && <span className="ow-field-icon" aria-hidden="true">{icon}</span>}
   {field.type==='select' ? <select {...props}><option value="">Seleccione</option>{field.options?.map(o=><option key={o}>{o}</option>)}</select>
    : field.type==='textarea' ? <textarea {...props} rows={3} />
    : <input {...props} type={field.type || 'text'} step={field.type==='number' ? field.integer ? '1' : 'any' : undefined} min={field.type==='number' ? field.integer ? '1' : '0.001' : undefined} />}
   {field.type==='datetime-local'&&<span aria-hidden="true" className={`ow-date-readable ${icon?'has-icon':''}`}>{dateText}</span>}
  </div>{error && <span id={`${id}-error`} className="ow-error">{error}</span>}
 </div>
}
export function WizardFields({fields,spec,setValue,issues=[],disabled=false,prefix=''}:{fields:WizardField[];spec:Record<string,unknown>;setValue:(key:string,value:string)=>void;issues?:FormIssue[];disabled?:boolean;prefix?:string}) {
 return <div className="ow-fields">{fields.map(f=><WizardFieldControl key={f.key} field={{...f,key:prefix+f.key}} value={spec[f.key]} disabled={disabled} onChange={v=>setValue(f.key,v)} error={issues.find(i=>i.field===prefix+f.key)?.message} />)}</div>
}
export const GENERAL_ICONS = {required_at:<CalendarDays/>,pickup:<MapPin/>,delivery:<MapPin/>,responsible:<UserRound/>}
export function SummaryValues({fields,spec}:{fields:WizardField[];spec:Record<string,unknown>}) {
 return <dl className="ow-review-values">{fields.filter(f=>String(spec[f.key] ?? '').trim()).map(f=><div key={f.key}><dt>{f.label}</dt><dd>{f.type==='datetime-local' ? String(spec[f.key]).replace('T',' ')+' (Lima)' : String(spec[f.key])}</dd></div>)}</dl>
}
