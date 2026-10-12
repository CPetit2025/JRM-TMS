'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { fetchServiceTypes } from '@/lib/request-service'
import { referenceLabel } from '@/lib/suppliers'

type Request = { id: string; number: string; type: string; ot: string | null; origin: string; destination: string; required_at: string | null; required_date: string | null; weight_kg: string | null }
type Stop = { id: string; order: number; number: string; ot: string | null; status: string; origin: string; destination: string; locked: boolean }
type Context = { revision: string; frontier: number; capacity_kg: number | null; stops: Stop[]; requests: Request[]; dispatch: { number: string; plate: string; driver: string; status: string; operating_day?: string; cutoff_at?: string } }
const field = 'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm'
const attention = (r: Request) => r.required_at ? new Date(r.required_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : r.required_date || 'Sin fecha'

export function AddRouteService({ dispatchId, initialRequestId, onClose, onChanged }: { dispatchId: string | null; initialRequestId?: string; onClose: () => void; onChanged: (requestId: string) => void }) {
 const supabase = useMemo(() => createClient(), [])
 const [context, setContext] = useState<Context | null>(null)
 const [references, setReferences] = useState<Map<string, string>>(new Map())
 const [error, setError] = useState('')
 const [busy, setBusy] = useState(false)
 const [requestId, setRequestId] = useState('')
 const [before, setBefore] = useState('')
 const [search, setSearch] = useState('')
 const [cargo, setCargo] = useState('')
 const [available, setAvailable] = useState('')
 const [expected, setExpected] = useState('')
 const [reason, setReason] = useState('')
 const [confirmed, setConfirmed] = useState(false)
 const operation = useRef('')
 useEffect(() => {
   if (!dispatchId) return
   let cancelled = false
   const timer = window.setTimeout(async () => {
     setContext(null); setError(''); setRequestId(''); setBefore(''); setSearch(''); setCargo(''); setAvailable(''); setExpected(''); setReason(''); setConfirmed(false)
     operation.current = crypto.randomUUID()
     const { data, error: failure } = await supabase.rpc('active_route_context', { p_dispatch: dispatchId })
     const nextContext = !failure ? data as Context : null
     const types = nextContext ? await fetchServiceTypes(supabase, [...nextContext.requests.map(r => r.id), ...nextContext.stops.map(s => s.id)]) : new Map()
     if (!cancelled) { setReferences(new Map([...types].map(([id, info]) => [id, referenceLabel(info) || 'Sin referencia']))); if (failure) setError(failure.message); else {
       const next = data as Context
       setContext(next)
       const initial = next.requests.find(r => r.id === initialRequestId)
       if (initial) { setRequestId(initial.id); setCargo(initial.weight_kg && Number(initial.weight_kg) > 0 ? initial.weight_kg : '') }
     } }
   }, 0)
   return () => { cancelled = true; window.clearTimeout(timer) }
 }, [dispatchId, initialRequestId, supabase])
 const selected = context?.requests.find(r => r.id === requestId)
 const filtered = context?.requests.filter(r => `${r.number} ${r.ot || references.get(r.id) || ''} ${r.origin} ${r.destination}`.toLowerCase().includes(search.toLowerCase())) || []
 const preview = context ? [...context.stops] : []
 if (selected) {
   const index = before ? preview.findIndex(s => s.id === before) : preview.length
   preview.splice(index < 0 ? preview.length : index, 0, { id: selected.id, order: 0, number: selected.number, ot: selected.ot, status: 'NUEVO', origin: selected.origin, destination: selected.destination, locked: false })
 }
 const submit = async (event: React.FormEvent) => {
   event.preventDefault()
   if (!context || !selected || busy || !confirmed) return
   setBusy(true); setError('')
   try {
     const { error: failure } = await supabase.rpc('add_active_route_service', {
       p_dispatch: dispatchId, p_request: requestId, p_before: before || null, p_revision: context.revision, p_operation: operation.current,
       // Los servicios agregados a la ruta no se valorizan aquí (flota propia: se documentan, no se cobra flete
       // adicional); el recorrido real lo registra el GPS.
       p_freight: 0, p_extra_km: 0, p_cargo_kg: Number(cargo), p_available_kg: Number(available),
       p_expected_at: new Date(`${expected}:00-05:00`).toISOString(), p_reason: reason.trim(),
     })
     if (failure) throw failure
     toast.success('Servicio agregado. El conductor verá la ruta actualizada; el tercero conserva su enlace de acceso.')
     onChanged(requestId); onClose()
   } catch (failure) { setError(failure instanceof Error ? failure.message : (failure as { message?: string }).message || 'No se pudo agregar el servicio. Puede reintentar sin duplicarlo.') }
   finally { setBusy(false) }
 }
 return <Modal isOpen={!!dispatchId} onClose={() => { if (!busy) onClose() }} title="Agregar servicio a la ruta" maxWidth="max-w-6xl">
   {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<span className="block mt-1">Si la ruta cambió, cierre y vuelva a abrir esta ventana para revisar el orden actual.</span></p>}
   {!context ? !error && <p className="p-6 text-slate-500">Consultando ruta y solicitudes disponibles…</p> : <form onSubmit={submit} className="space-y-5">
     <div className="rounded-xl bg-slate-50 p-4"><p className="font-bold text-jrm-navy">{context.dispatch.number} · {context.dispatch.plate}</p><p className="text-sm text-slate-600">{context.dispatch.driver} · {context.dispatch.status}</p><p className="mt-2 text-xs text-slate-600">Las paradas atendidas y el tramo iniciado conservan su posición, kilometraje y evidencias.</p><p className="mt-2 text-sm font-semibold text-amber-800">Adicionales solo para el día {context.dispatch.operating_day || 'operativo de esta ruta'}. Corte a las 00:00 de Lima; la documentación pendiente se conserva.</p></div>
     <div className="grid gap-5 lg:grid-cols-2">
       <section className="space-y-3"><h3 className="font-bold text-jrm-navy">1. Seleccionar solicitud aprobada</h3>
         <input aria-label="Buscar solicitud, OT u orden" className={field} placeholder="Buscar solicitud, OT, OC, OS, RQ o dirección…" value={search} onChange={e => setSearch(e.target.value)} />
         <div className="max-h-72 overflow-auto rounded-lg border"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-50"><tr><th className="p-3">Solicitud / OT / Orden</th><th className="p-3">Servicio / Atención</th><th className="p-3">Seleccionar</th></tr></thead><tbody>
           {!filtered.length && <tr><td colSpan={3} className="p-4 text-slate-500">No hay solicitudes aprobadas disponibles con este filtro.</td></tr>}
           {filtered.map(r => <tr key={r.id} className={`border-t ${requestId === r.id ? 'bg-blue-50' : ''}`}><td className="p-3 font-semibold">{r.number}<span className="block font-normal">{r.ot ? `OT ${r.ot}` : references.get(r.id) || 'Sin referencia'}</span></td><td className="p-3">{r.type === 'RECOJO' ? 'Recojo' : r.type === 'TRASLADO' ? 'Punto a punto' : 'Entrega'}<span className="block">{attention(r)}</span></td><td className="p-3"><button type="button" className="min-h-10 rounded-lg border px-3 font-semibold text-jrm-navy" onClick={() => { setRequestId(r.id); setCargo(r.weight_kg && Number(r.weight_kg) > 0 ? r.weight_kg : ''); setConfirmed(false) }}>{requestId === r.id ? 'Seleccionada' : 'Seleccionar'}</button></td></tr>)}
         </tbody></table></div>
         {selected && <div className="rounded-lg border bg-blue-50 p-3 text-sm"><p><strong>Punto de carga / recojo:</strong> {selected.origin}</p><p className="mt-1"><strong>Destino:</strong> {selected.destination}</p></div>}
       </section>
       <section className="space-y-3"><h3 className="font-bold text-jrm-navy">2. Revisar secuencia</h3>
         <label className="block text-sm">Ubicación del nuevo servicio<select className={field} value={before} onChange={e => { setBefore(e.target.value); setConfirmed(false) }}><option value="">Al final de la ruta</option>{context.stops.filter(s => !s.locked).map(s => <option key={s.id} value={s.id}>Antes de {s.number} · {s.destination}</option>)}</select></label>
         <ol className="max-h-72 space-y-2 overflow-auto">{preview.map((s, index) => <li key={s.id} className={`rounded-lg border p-3 text-sm ${s.status === 'NUEVO' ? 'border-blue-300 bg-blue-50' : 'bg-white'}`}><p className="font-semibold">{index + 1}. {s.number} · {s.ot ? `OT ${s.ot}` : references.get(s.id) || 'Sin referencia'} <span className="text-xs text-slate-500">{s.status === 'NUEVO' ? 'Nuevo servicio' : s.locked ? 'Posición protegida' : 'Pendiente'}</span></p><p className="mt-1 text-xs text-slate-600">{s.origin} → {s.destination}</p></li>)}</ol>
       </section>
     </div>
     <section><h3 className="font-bold text-jrm-navy">3. Validar operación</h3><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
       <label className="text-sm">Peso del nuevo servicio (kg)<input required type="number" min={Math.max(Number(selected?.weight_kg || 0), 0.01)} step="0.01" value={cargo} onChange={e => setCargo(e.target.value)} className={field} /></label>
       <label className="text-sm">Capacidad disponible al cargar (kg)<input required type="number" min={Number(cargo) || 0.01} max={context.capacity_kg && context.capacity_kg > 0 ? context.capacity_kg : undefined} step="0.01" value={available} onChange={e => setAvailable(e.target.value)} className={field} /><span className="text-xs text-slate-500">{context.capacity_kg && context.capacity_kg > 0 ? `Capacidad de la unidad: ${context.capacity_kg} kg.` : 'Capacidad sin registrar: confirme la disponibilidad con el conductor o proveedor.'}</span></label>
       <label className="text-sm">Atención prevista (hora de Lima)<input required type="datetime-local" min={context.dispatch.operating_day ? `${context.dispatch.operating_day}T00:00` : undefined} max={context.dispatch.operating_day ? `${context.dispatch.operating_day}T23:59` : undefined} value={expected} onChange={e => setExpected(e.target.value)} className={field} /></label>
       <label className="text-sm">Motivo de incorporación<input required minLength={10} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} className={field} /></label>
     </div><p className="mt-3 text-xs text-slate-600">El servicio agregado no se valoriza en la ruta: se documenta (guía, Nota de Despacho, Packing List) y el GPS registra el recorrido real.</p></section>
     <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><input required type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-1" /><span>Confirmo con el conductor o proveedor la capacidad disponible, el punto de carga y los tiempos de atención de todos los servicios pendientes.</span></label>
     <div className="flex flex-wrap justify-end gap-3"><button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-lg border px-4 text-sm font-semibold">Cancelar</button><button disabled={busy || !selected || !confirmed} className="min-h-11 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Agregando servicio…' : 'Confirmar incorporación'}</button></div>
   </form>}
 </Modal>
}
