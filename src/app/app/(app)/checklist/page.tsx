'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useActiveTrip } from '@/contexts/ActiveTripContext'
import { PreuseSignature } from '@/components/driver/PreuseSignature'
import { PREUSE_FORMAT, blankPreuseAnswers, validPreuseSignature, validatePreuseAnswers, type PreuseAnswer, type PreuseContext, type SignaturePoint } from '@/lib/preuse'
import { db, type OfflinePreuse } from '@/lib/offline/db'
import { useLiveQuery } from 'dexie-react-hooks'
import { syncOwnPreuse } from '@/lib/offline/preuse-runtime'
import { errorMessage } from '@/lib/caja'

type Draft = { answers: PreuseAnswer[]; license: string; soat_expiration: string; technical_review_expiration: string; vehicle_operational: boolean | null; observation: string; inspector_name: string; signature: SignaturePoint[][] }
export default function ChecklistPage() {
 const supabase = useMemo(() => createClient(), [])
 const { refresh, assigned_unit } = useActiveTrip()
 const [context, setContext] = useState<PreuseContext | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
 const [plate, setPlate] = useState(''), [revision, setRevision] = useState<string | null>(null), [busy, setBusy] = useState(false)
 const [draft, setDraft] = useState<Draft>({ answers: blankPreuseAnswers(), license: '', soat_expiration: '', technical_review_expiration: '', vehicle_operational: null, observation: '', inspector_name: '', signature: [] })
 const [retry, setRetry] = useState<{ operation: string; captured: string } | null>(null)
 const pending = useLiveQuery<OfflinePreuse[]>(() => context?.driver?.profile_id ? db.preuse.where('profile_id').equals(context.driver.profile_id).filter(row => row.synced === 0).toArray() : Promise.resolve([]), [context?.driver?.profile_id])
 const storageKey = context?.driver?.profile_id && revision ? `jrm-preuse:${context.driver.profile_id}:${revision}` : null
 const load = useCallback(async () => {
  setLoading(true)
  try { const { data, error } = await supabase.rpc('get_driver_preuse_context'); if (error) throw error
   const value = data as PreuseContext; setContext(value); setError(''); setPlate(value.unit?.vehicle_plate || value.route_plate || '')
  } catch (e) { setError(errorMessage(e)) } finally { setLoading(false) }
 }, [supabase])
 useEffect(() => { if (revision) return; const initial = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(initial) }, [load, assigned_unit?.plate, revision])
 const assignmentChanged = !!revision && (assigned_unit ? assigned_unit.plate !== plate : assigned_unit === null && !!context?.assigned_unit)
 useEffect(() => {
  if (!storageKey) return
  try { localStorage.setItem(storageKey, JSON.stringify({ draft, retry })) } catch { /* The form remains in memory if local storage is full. */ }
 }, [storageKey, draft, retry])
 const begin = async () => {
  if (!plate || busy || !context?.driver) return
  setBusy(true)
  try {
   const { data, error } = await supabase.rpc('select_driver_preuse_unit', { p_plate: plate }); if (error) throw error
   const unit = context.vehicles.find(v => v.plate === plate)
   const initial: Draft = { answers: blankPreuseAnswers(), license: context.driver.license, soat_expiration: unit?.soat_expiration || '', technical_review_expiration: unit?.technical_review_expiration || '', vehicle_operational: null, observation: '', inspector_name: context.driver.name, signature: [] }
   const key = `jrm-preuse:${context.driver.profile_id}:${data.revision}`
   let saved: { draft?: Draft; retry?: typeof retry } | null = null
   try { saved = JSON.parse(localStorage.getItem(key) || 'null') } catch { /* Ignore an invalid draft. */ }
   const candidate = saved?.draft
   const validDraft = candidate && Array.isArray(candidate.answers) && candidate.answers.length === 34 &&
    PREUSE_FORMAT.items.every((item,i) => candidate.answers[i]?.code === item.code && typeof candidate.answers[i]?.comment === 'string') &&
    ['license','soat_expiration','technical_review_expiration','observation','inspector_name'].every(key => typeof candidate[key as keyof Draft] === 'string') &&
    Array.isArray(candidate.signature) && (!candidate.signature.length || validPreuseSignature(candidate.signature)) && (candidate.vehicle_operational === null || typeof candidate.vehicle_operational === 'boolean')
   setDraft(validDraft ? candidate : initial); setRetry(validDraft && saved?.retry?.operation && saved.retry.captured ? saved.retry : null); setPlate(data.vehicle_plate); setContext(current => current ? { ...current, unit: data, operation_date: data.operation_date } : current); setRevision(data.revision)
  } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
 }
 const submit = async (event: React.FormEvent) => {
  event.preventDefault(); if (!revision || !context?.driver || !context.driver.profile_id || busy || assignmentChanged) return
  if (!validatePreuseAnswers(draft.answers)) { toast.error('Complete los 34 ítems: B, M, R o N/A.'); return }
  if (draft.vehicle_operational === null || !validPreuseSignature(draft.signature)) { toast.error('Indique Vehículo Operativo y registre la firma de quien inspecciona.'); return }
  const operation = retry || { operation: crypto.randomUUID(), captured: new Date().toISOString() }
  setRetry(operation); setBusy(true)
  const data = { ...draft, format_code: PREUSE_FORMAT.code, format_version: PREUSE_FORMAT.version }
  try {
   if (!navigator.onLine) {
    await db.preuse.put({ operation_id: operation.operation, profile_id: context.driver.profile_id, unit_revision: revision, vehicle_plate: plate, operation_date: context.operation_date, captured_at: operation.captured, data, synced: 0, created_at: new Date().toISOString() })
    window.dispatchEvent(new Event('jrm:preuse-queue-changed'))
    toast.success('Inspección guardada en el dispositivo. Pendiente de sincronizar; todavía no habilita iniciar ruta.')
   } else {
    const { data: result, error } = await supabase.rpc('submit_driver_preuse', { p_operation: operation.operation, p_revision: revision, p_captured_at: operation.captured, p_data: data })
    if (error || !result?.success) throw error || new Error(result?.error || 'No se pudo guardar la inspección')
    toast[result.can_operate ? 'success' : 'warning'](result.can_operate ? 'Inspección registrada. La ruta se inicia por separado.' : 'Inspección registrada. La unidad no está habilitada para operar; revisa las observaciones y Mantenimiento.')
   }
   if (storageKey) localStorage.removeItem(storageKey)
   setRevision(null); setRetry(null); await refresh(); await load()
  } catch (e) { toast.error('No se pudo registrar: ' + errorMessage(e)) } finally { setBusy(false) }
 }
 const set = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft(current => ({ ...current, [key]: value })); setRetry(null) }
 const input = 'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm'
 return <div className="mx-auto max-w-2xl space-y-4 p-4 pb-8">
  <header className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold text-slate-500">SISTEMA INTEGRADO DE GESTIÓN · {PREUSE_FORMAT.code} · Versión {PREUSE_FORMAT.version}</p><h1 className="mt-2 flex items-start gap-2 text-lg font-bold text-[#002855]"><ClipboardCheck className="h-6 w-6 shrink-0" />Inspección de pre uso de vehículos livianos y pesados</h1><p className="mt-2 text-sm text-slate-600">Obligatoria al iniciar operaciones, con o sin ruta. Al cambiar de unidad realiza una nueva inspección.</p></header>
  {!!pending?.length && <section className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><h2 className="font-semibold">Inspecciones pendientes de sincronizar ({pending.length})</h2><p>No habilitan el inicio de ruta hasta que el servidor confirme el registro.</p>{pending.map(row => <p key={row.operation_id}>{row.vehicle_plate || 'Unidad'} · {row.operation_date || row.captured_at.slice(0,10)}{row.last_error && <span className="block text-xs">{row.last_error}</span>}</p>)}<button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await syncOwnPreuse(supabase); await load(); await refresh() } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) } }} className="min-h-11 rounded-lg border border-amber-400 px-3 font-semibold">Sincronizar pendientes</button></section>}
  {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
  {loading && !context ? <p className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin" /></p> : !revision ? <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
   <p className="text-sm"><b>Conductor:</b> {context?.driver?.name || 'Sin conductor activo'} · <b>Fecha:</b> {context?.operation_date || 'Sin confirmar'}</p>
   {context?.assigned_unit && <p className="rounded-lg bg-blue-50 p-3 text-sm text-[#002855]">Unidad asignada por Transporte: <b>{context.assigned_unit.plate}</b>. Para cambiarla, solicita la actualización en Flota.</p>}
   {context?.latest && <p className={`rounded-lg p-3 text-sm ${context.pending ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800'}`}>Última inspección del día: {context.latest.vehicle_plate}. {context.pending ? 'Operación pendiente de habilitar.' : 'Inspección vigente para la unidad actual.'}</p>}
   <label className="block text-sm font-semibold">Placa<select aria-label="Placa" value={plate} onChange={e => setPlate(e.target.value)} className={input}><option value="">Seleccione la unidad que utilizará</option>{context?.vehicles.map(v => <option key={v.plate} value={v.plate}>{v.plate}</option>)}</select></label>
   {!context?.vehicles.length && !error && <p className="text-sm text-amber-800">No hay unidades disponibles para tu sede. Solicita a Transporte que revise tu acceso de sede o tu unidad asignada.</p>}
   <p className="text-xs text-slate-500">Confirma la unidad al iniciar el día. Si cambias de placa, el checklist anterior deja de habilitar operaciones.</p>
   <button type="button" disabled={!plate || busy} onClick={() => void begin()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Confirmar unidad e iniciar inspección</button>
   <button type="button" onClick={() => void load()} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button>
  </section> : <form onSubmit={submit} className="space-y-4">
   {assignmentChanged && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Transporte cambió tu asignación{assigned_unit ? ` a ${assigned_unit.plate}` : ''}. Pulsa «Cambiar unidad» y confirma la unidad vigente antes de registrar.</p>}
   <fieldset disabled={busy || assignmentChanged} className="space-y-4 disabled:opacity-70">
    <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
     <p className="text-sm sm:col-span-2"><b>Nombres y Apellidos del Conductor:</b> {context?.driver?.name}</p>
     <p className="text-sm"><b>Placa:</b> {plate}</p><p className="text-sm"><b>Fecha:</b> {context?.operation_date}</p>
     <label className="text-sm">Brevete (Clase/catg)<input required maxLength={120} value={draft.license} onChange={e => set('license',e.target.value)} className={input} /></label>
     <label className="text-sm">Fecha de vencimiento SOAT<input required type="date" value={draft.soat_expiration} onChange={e => set('soat_expiration',e.target.value)} className={input} /></label>
     <label className="text-sm">Fecha de vencimiento Rev. Tec.<input required type="date" value={draft.technical_review_expiration} onChange={e => set('technical_review_expiration',e.target.value)} className={input} /></label>
    </section>
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><h2 className="border-b bg-slate-50 p-4 text-sm font-bold text-[#002855]">ÍTEMS A VERIFICAR</h2><p className="border-b px-4 py-3 text-xs text-slate-600">B: bueno · M: malo · R: regular · N/A: no aplica. Responde cada ítem según la inspección realizada.</p>
     <div className="divide-y divide-slate-200">{PREUSE_FORMAT.items.map((item,index) => <fieldset key={item.code} className="space-y-3 p-4"><legend className="sr-only">{item.text}</legend><p className="text-sm font-semibold text-slate-800">{index+1}. {item.text}</p><div className="grid grid-cols-4 gap-2">{(['B','M','R','N/A'] as const).map(value => <label key={value} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg border text-sm font-semibold ${draft.answers[index]?.response === value ? 'border-[#002855] bg-[#002855] text-white' : 'border-slate-300 text-slate-600'}`}><input type="radio" name={item.code} value={value} checked={draft.answers[index]?.response === value} onChange={() => set('answers',draft.answers.map(a => a.code === item.code ? { ...a,response:value } : a))} className="sr-only" />{value}</label>)}</div><label className="block text-xs text-slate-500">Comentarios<input maxLength={120} value={draft.answers[index]?.comment || ''} onChange={e => set('answers',draft.answers.map(a => a.code === item.code ? { ...a,comment:e.target.value } : a))} className={input} /></label></fieldset>)}</div>
    </section>
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-600">Nota: Todos los defectos deben ser corregidos antes de poner el vehículo en servicio.</p><fieldset><legend className="text-sm font-semibold">Vehículo Operativo</legend><div className="mt-2 flex gap-4">{[true,false].map(value => <label key={String(value)} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm"><input required type="radio" name="operational" checked={draft.vehicle_operational === value} onChange={() => set('vehicle_operational',value)} />{value ? 'SÍ' : 'NO'}</label>)}</div></fieldset><label className="block text-sm">Observación<textarea maxLength={1000} rows={3} value={draft.observation} onChange={e => set('observation',e.target.value)} className={input} /></label><label className="block text-sm">Inspeccionado por · Nombre<input required maxLength={120} value={draft.inspector_name} onChange={e => set('inspector_name',e.target.value)} className={input} /></label><PreuseSignature value={draft.signature} onChange={value => set('signature',value)} disabled={busy} /></section>
    <button type="submit" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#002855] px-4 text-sm font-bold text-white">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Registrar inspección</button>
   </fieldset>
   <button type="button" disabled={busy} onClick={() => { setRevision(null); setRetry(null) }} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm">Cambiar unidad</button>
  </form>}
  <Link href="/app" className="block py-3 text-center text-sm font-semibold text-[#002855]">Volver a Inicio</Link>
 </div>
}
