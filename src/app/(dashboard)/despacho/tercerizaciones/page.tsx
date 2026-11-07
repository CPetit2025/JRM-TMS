'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { PageHeader } from '@/components/ui/page-header'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage, money } from '@/lib/caja'
import { OUTSOURCING_STAGES, OUTSOURCING_SERVICES, SPEC_FIELDS, SERVICE_FIELDS, nextPermission, type Outsourcing, type OutsourcingQuote, type OutsourcingService } from '@/lib/outsourcing'
import { cellDateTime } from '@/lib/table-format'

type Row = Outsourcing & { client: string | null; transport_requests: { request_number: string; contract_id: string | null; contracts: { code: string } | null } }
type Supplier = { id: string; business_name: string }
type Event = { id: string; stage: number; actor_name: string; created_at: string; note: string; evidence: string | null }
const control = 'w-full rounded-lg border border-slate-300 bg-white p-2 text-sm'
const button = 'rounded-lg bg-jrm-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50'
export default function OutsourcingPage() {
 const db = useMemo(() => createClient(), [])
 const { canWrite } = usePermissions()
 const [rows,setRows] = useState<Row[]>([])
 const [id,setId] = useState('')
 const [filter,setFilter] = useState('')
 const [search,setSearch] = useState('')
 const [loading,setLoading] = useState(true)
 const [busy,setBusy] = useState(false)
 const [quotes,setQuotes] = useState<OutsourcingQuote[]>([])
 const [events,setEvents] = useState<Event[]>([])
 const [suppliers,setSuppliers] = useState<Supplier[]>([])
 const [dispatches,setDispatches] = useState<{id:string;dispatch_number:string}[]>([])
 const [note,setNote] = useState('')
 const [file,setFile] = useState<File | null>(null)
 const [dispatch,setDispatch] = useState('')
 const [selected,setSelected] = useState<Record<string,string>>({})
 const [quote,setQuote] = useState({ service:'FLETE' as OutsourcingService, supplier:'', amount:'', terms:'' })
 const row = rows.find(r => r.id===id)
 const load = useCallback(async () => {
  const { data,error } = await db.rpc('outsourcing_queue')
  if (error) { toast.error(errorMessage(error)); setLoading(false); return }
  setRows(data as Row[]); setLoading(false)
 },[db])
 const detail = useCallback(async () => {
  if (!id) return
  const results = await Promise.all([
   db.from('transport_outsourcing_quotes').select('*').eq('outsourcing_id',id).order('created_at'),
   db.from('transport_outsourcing_events').select('id,stage,actor_name,created_at,note,evidence').eq('outsourcing_id',id).order('created_at'),
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
  if (!id) return
  let active = true
  void db.rpc('outsourcing_options',{p_id:id}).then(({data,error}) => {
   if(active) { if(error) toast.error(errorMessage(error)); else { setSuppliers(data?.suppliers || []); setDispatches(data?.dispatches || []) } }
  })
  return () => { active=false }
 },[db,id,row?.version])
 async function upload() {
  if(!file || !row) throw new Error('Seleccione una evidencia PDF, PNG o JPG (máximo 10 MB)')
  if(file.size>10485760 || !['application/pdf','image/png','image/jpeg'].includes(file.type)) throw new Error('Archivo inválido: PDF, PNG o JPG de hasta 10 MB')
  const path=`${row.id}/${crypto.randomUUID()}.${file.type==='application/pdf' ? 'pdf' : file.type==='image/png' ? 'png' : 'jpg'}`
  const {error} = await db.storage.from('outsourcing').upload(path,file)
  if(error) throw error
  return path
 }
 async function view(path:string) {
  const {data,error} = await db.storage.from('outsourcing').createSignedUrl(path,120)
  if(error) { toast.error(errorMessage(error)); return }
  window.open(data.signedUrl,'_blank','noopener,noreferrer')
 }
 async function act(addQuote=false) {
  if(!row) return
  setBusy(true)
  try {
   const evidence = row.stage===0 && !file ? null : await upload()
   const result = addQuote ? await db.rpc('outsourcing_add_quote',{p_id:row.id,p_service:quote.service,p_supplier:quote.supplier,p_amount:Number(quote.amount),p_terms:quote.terms,p_evidence:evidence})
    : await db.rpc('outsourcing_transition',{p_id:row.id,p_version:row.version,p_next:row.stage+1,p_note:note,p_evidence:evidence,p_quotes:Object.values(selected),p_dispatch:dispatch || null})
   if(result.error) throw result.error
   toast.success(addQuote ? 'Cotización registrada' : 'Etapa actualizada')
   setFile(null); setNote(''); setSelected({}); setQuote({service:'FLETE',supplier:'',amount:'',terms:''})
   await load(); await detail()
  } catch(e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
 }
 const visible=rows.filter(r => (filter==='' || r.stage===Number(filter)) && `${r.number} ${r.transport_requests.request_number} ${r.transport_requests.contracts?.code || ''} ${r.specification.delivery} ${r.specification.responsible}`.toLowerCase().includes(search.toLowerCase()))
 const services: OutsourcingService[] = ['FLETE',...(row?.specification.services || []).map(s => s.kind)]
 return <div className="space-y-4">
  <PageHeader showTitle title="Solicitudes de tercerización" description="Distribución · Transporte · Compras" actions={<><button className={button} onClick={() => { void load(); void detail() }}>Actualizar</button><Link className="rounded-lg border p-2 text-sm" href="/despacho">Programación y ruteo</Link></>} />
  <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
   <section className="space-y-3 rounded-xl border bg-white p-3" aria-label="Bandeja de Compras">
    <label className="block text-sm">Buscar por ST, OT, solicitud o destino<input className={control} type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
    <label className="block text-sm">Estado<select className={control} value={filter} onChange={e => setFilter(e.target.value)}><option value="">Todos</option>{OUTSOURCING_STAGES.map((s,i) => <option value={i} key={s}>{s}</option>)}</select></label>
    <p className="text-xs text-slate-500">Hasta 500 solicitudes recientes · {visible.length} resultados</p>
    {loading ? <p role="status">Cargando…</p> : !visible.length ? <p className="p-4 text-sm">Sin solicitudes. Genérelas desde Acciones en Programación y Ruteo.</p> : visible.map(r => <button disabled={busy} key={r.id} onClick={() => {setId(r.id);setQuotes([]);setEvents([]);setDispatches([]);setNote('');setFile(null);setSelected({});setDispatch('')}} className={`block w-full space-y-1 rounded-lg border p-3 text-left ${r.id===id ? 'border-blue-700 bg-blue-50' : 'hover:bg-slate-50'}`}>
     <span className="block font-semibold text-jrm-navy">ST-{r.number} · {r.transport_requests.request_number}</span><span className="block text-sm">OT {r.transport_requests.contracts?.code || 'Sin OT'} · {String(r.specification.delivery || 'Sin destino')}</span><span className="block text-xs text-blue-800">{OUTSOURCING_STAGES[r.stage]} · {String(r.specification.priority || 'NORMAL')}</span>
    </button>)}
   </section>
   {row ? <section key={row.id} className="min-w-0 space-y-4 rounded-xl border bg-white p-4">
    <h2 className="text-xl font-bold text-jrm-navy">ST-{row.number} · {OUTSOURCING_STAGES[row.stage]}</h2>
    <ol className="flex flex-wrap gap-2" aria-label="Avance de la solicitud">{OUTSOURCING_STAGES.map((s,i) => <li key={s} aria-current={i===row.stage ? 'step' : undefined} className={`rounded-full px-3 py-1 text-xs ${i<=row.stage ? 'bg-blue-100 text-blue-900' : 'bg-slate-100 text-slate-500'}`}>{i+1}. {s}</li>)}</ol>
    <div className="flex flex-wrap gap-3 text-sm"><span>Solicitud: {row.transport_requests.request_number}</span><span>Cliente: {row.client || 'Sin cliente'}</span><span>Prioridad: {String(row.specification.priority)}</span>{row.transport_requests.contract_id && <Link className="text-blue-700 underline" href={`/despacho/control-presupuestal/movimientos?ot=${row.transport_requests.contract_id}`}>Presupuesto y movimientos de la OT</Link>}{row.dispatch_id && <Link className="text-blue-700 underline" href={`/despacho/documentos/economico?despacho=${row.dispatch_id}`}>Cierre económico del despacho</Link>}</div>
    <details open><summary className="cursor-pointer font-semibold">Ficha técnica y operativa</summary>{SPEC_FIELDS.map(([section,fields]) => <div key={section} className="mt-3"><h3 className="font-medium text-jrm-navy">{section}</h3><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{fields.map(([key,label]) => <div key={key}><dt className="text-slate-500">{label}</dt><dd className="whitespace-pre-wrap break-words">{key==='required_at' && row.specification[key] ? cellDateTime(String(row.specification[key])) : String(row.specification[key] || '—')}</dd></div>)}</dl></div>)}{row.specification.services.map(s => <p className="mt-3 text-sm" key={s.kind}><strong>{OUTSOURCING_SERVICES[s.kind]}:</strong> {s.requirements}{(SERVICE_FIELDS[s.kind] || []).map(([key,label]) => <span className="block text-slate-600" key={key}>{label}: {s.details?.[key] || '—'}</span>)}</p>)}</details>
    <section className="space-y-2 border-t pt-3"><h3 className="font-semibold">Cotizaciones por servicio · PEN (incluye impuestos y adicionales)</h3>{services.map(service => <fieldset key={service} className="rounded-lg border p-3"><legend className="px-1 text-sm font-semibold">{OUTSOURCING_SERVICES[service]}</legend>{quotes.filter(q=>q.service===service).map(q => <label key={q.id} className="my-2 flex flex-wrap items-center gap-2 text-sm"><input type="radio" name={service} disabled={row.stage!==2 || !canWrite('compras-tercerizaciones') || busy} checked={row.stage===2 ? selected[service]===q.id : q.selected} onChange={() => setSelected({...selected,[service]:q.id})} /><span>{suppliers.find(s=>s.id===q.supplier_id)?.business_name || q.supplier_id} · {money(q.amount_pen)} · {q.terms}</span><button className="text-blue-700 underline" onClick={() => void view(q.evidence)}>Ver cotización</button></label>)}{!quotes.some(q=>q.service===service) && <p className="text-sm text-slate-500">Sin cotización</p>}</fieldset>)}<p className="text-sm font-semibold">Total seleccionado: {money(quotes.filter(q=>row.stage===2 ? Object.values(selected).includes(q.id) : q.selected).reduce((sum,q)=>sum+Number(q.amount_pen),0))}</p></section>
    {row.stage===2 && canWrite('compras-tercerizaciones') && <form className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void act(true)}}><h3 className="font-semibold sm:col-span-2">Registrar alternativa de cotización</h3>
     <label className="text-sm">Servicio<select className={control} value={quote.service} onChange={e=>setQuote({...quote,service:e.target.value as OutsourcingService})}>{services.map(s=><option key={s} value={s}>{OUTSOURCING_SERVICES[s]}</option>)}</select></label>
     <label className="text-sm">Proveedor<select required className={control} value={quote.supplier} onChange={e=>setQuote({...quote,supplier:e.target.value})}><option value="">Seleccione proveedor</option>{suppliers.map(s=><option key={s.id} value={s.id}>{s.business_name}</option>)}</select></label>
     <label className="text-sm">Costo total S/<input required className={control} type="number" min="0.01" step="0.01" value={quote.amount} onChange={e=>setQuote({...quote,amount:e.target.value})} /></label><label className="text-sm">Alcance, vigencia y condiciones<input required minLength={5} className={control} value={quote.terms} onChange={e=>setQuote({...quote,terms:e.target.value})} /></label>
     <p className="text-xs sm:col-span-2">Adjunte la cotización en el campo Evidencia antes de registrar.</p><button disabled={busy} className={button}>Registrar cotización</button></form>}
    {row.stage<7 && canWrite(nextPermission(row.stage)) && <form className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3" onSubmit={e=>{e.preventDefault();void act()}}>
     <h3 className="font-semibold">Continuar a: {OUTSOURCING_STAGES[row.stage+1]}</h3>
     {row.stage===4 && <><p className="text-sm">Programe la ruta con los proveedores y montos adjudicados. Sus líneas de flete y servicios reservan la partida una sola vez. Stocka se registra como Otros.</p><label className="block text-sm">Despacho vinculado<select required className={control} value={dispatch} onChange={e=>setDispatch(e.target.value)}><option value="">Seleccione despacho</option>{dispatches.map(d=><option key={d.id} value={d.id}>{d.dispatch_number}</option>)}</select></label></>}
     <label className="block text-sm">Sustento / instrucciones<textarea required minLength={5} className={control} value={note} onChange={e=>setNote(e.target.value)} /></label>
     <label className="block text-sm">Evidencia {row.stage===0 ? '(opcional)' : '(obligatoria)'} · PDF, PNG o JPG, máximo 10 MB<input key={file ? 'selected' : 'empty'} type="file" accept="application/pdf,image/png,image/jpeg" className={control} onChange={e=>setFile(e.target.files?.[0] || null)} /></label>{file && <p className="text-xs">Seleccionado: {file.name}</p>}
     <button disabled={busy} className={button}>{busy ? 'Guardando…' : OUTSOURCING_STAGES[row.stage+1]}</button>
    </form>}
    <section className="space-y-3 border-t pt-3"><h3 className="font-semibold">Historial y evidencias</h3>{events.map(e=><div className="border-l-2 border-blue-200 pl-3 text-sm" key={e.id}><p className="font-semibold">{OUTSOURCING_STAGES[e.stage]} · {cellDateTime(e.created_at)}</p><p>{e.actor_name} · {e.note}</p>{e.evidence && <button className="text-blue-700 underline" onClick={()=>void view(e.evidence!)}>Ver evidencia</button>}</div>)}</section>
   </section> : <p className="p-6 text-slate-500">Seleccione una solicitud para revisar el detalle y gestionar su avance.</p>}
  </div>
 </div>
}
