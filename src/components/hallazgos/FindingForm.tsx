'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Camera, CheckCircle2, Loader2, Search, Upload, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { StatusBadge } from '@/components/ui/status-badge'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, fmtDate } from '@/lib/caja'
import {
  PHOTO_ACCEPT, SEVERITY, STATUS, afterPhotos, callRpc, canCloseConforme, currentRound, findingActions, signedUrls, uploadEvidence,
  type Abilities, type Category, type Detail, type Evidence, type OtOption, type Phase, type Severity,
} from '@/lib/audit-findings'

export type FindingPreset = { otCode: string | null; dispatchId?: string | null; requestId?: string | null }
type Tab = 'identificacion' | 'hallazgo' | 'evidencias' | 'correccion'
const TABS: [Tab, string][] = [['identificacion', 'Identificación'], ['hallazgo', 'Hallazgo'], ['evidencias', 'Evidencias'], ['correccion', 'Corrección y validación']]
const input = 'h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-jrm-navy disabled:bg-slate-50'
const area = 'w-full rounded-lg border border-slate-300 bg-white p-2 text-sm focus:outline-none focus:ring-2 focus:ring-jrm-navy disabled:bg-slate-50'
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white hover:bg-jrm-navy-dark disabled:bg-slate-200 disabled:text-slate-500'
const secondary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50 disabled:opacity-50'
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="block text-xs font-medium text-slate-500">{label}<span className="mt-1 block">{children}</span></label>
const list = <T,>(data: unknown, ...keys: string[]): T[] => Array.isArray(data) ? data as T[] : (keys.map(k => (data as Record<string, unknown> | null)?.[k]).find(Array.isArray) as T[] | undefined) || []

type Form = {
  contract_id: string; ot_code: string; client_name: string; destination: string; dispatch_id: string; transport_request_id: string
  process_area: string; severity: Severity; category_ids: string[]; description: string; material_code: string; material_description: string
  quantity: string; unit: string; location: string; observations: string
}
const EMPTY: Form = { contract_id: '', ot_code: '', client_name: '', destination: '', dispatch_id: '', transport_request_id: '', process_area: 'Despacho', severity: 'MENOR', category_ids: [], description: '', material_code: '', material_description: '', quantity: '', unit: '', location: '', observations: '' }

/** Formulario de hallazgo en 4 pestañas. `findingId` null = registro nuevo (con `preset` desde Documentos). */
export function FindingForm({ findingId, preset, initialTab = 'identificacion', can, onClose, onSaved }: {
  findingId: string | null; preset?: FindingPreset | null; initialTab?: Tab; can: Abilities; onClose: () => void; onSaved?: (id: string) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [id, setId] = useState(findingId)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [categories, setCategories] = useState<Category[]>([])
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(f => ({ ...f, [key]: value }))

  const reload = useCallback(async () => {
    if (!id) return
    try {
      const d = await callRpc<Detail>(supabase, 'audit_finding_detail', { p_id: id })
      setDetail(d)
      const f = d.finding
      setForm({ contract_id: f.contract_id, ot_code: f.ot_code || '', client_name: f.client_name || '', destination: f.destination || '', dispatch_id: f.dispatch_id || '', transport_request_id: f.transport_request_id || '',
        process_area: f.process_area || '', severity: f.severity, category_ids: d.categories.map(c => c.id), description: f.description || '', material_code: f.material_code || '',
        material_description: f.material_description || '', quantity: f.quantity == null ? '' : String(f.quantity), unit: f.unit || '', location: f.location || '', observations: f.observations || '' })
    } catch (e) { toast.error('No se pudo abrir el hallazgo: ' + errorMessage(e)) }
  }, [id, supabase])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- carga del detalle al abrir
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    void supabase.from('audit_finding_categories').select('id, code, name, is_safety').eq('active', true).order('sort').then(({ data }) => setCategories((data || []) as Category[]))
  }, [supabase])

  const f = detail?.finding
  const round = detail ? currentRound(detail) : null
  const acts = f ? findingActions(f, can, round?.corrected_by || round?.submitted_by || null) : null
  const editable = !id ? can.write : !!acts?.edit

  // Buscador de OT (RPC con límite): completa cliente y destino; luego se elige el despacho o la parada
  const [query, setQuery] = useState(preset?.otCode || '')
  const [options, setOptions] = useState<OtOption[]>([])
  const pick = useCallback((ot: OtOption, dispatchId?: string | null, requestId?: string | null) => {
    const stop = ot.dispatches.find(d => (!dispatchId || d.dispatch_id === dispatchId) && (!requestId || d.transport_request_id === requestId))
    setForm(v => ({ ...v, contract_id: ot.contract_id, ot_code: ot.ot_code, client_name: ot.client_name || '', dispatch_id: dispatchId && stop ? stop.dispatch_id || '' : '', transport_request_id: dispatchId && stop ? stop.transport_request_id || '' : '', destination: dispatchId && stop ? stop.destination || '' : '' }))
  }, [])
  const search = useCallback(async (q: string, auto?: FindingPreset | null) => {
    if (q.trim().length < 2) return
    try {
      const found = list<OtOption>(await callRpc(supabase, 'audit_finding_search_ot', { p_query: q.trim(), p_limit: 20 }), 'items', 'results')
      setOptions(found)
      const exact = auto && found.find(o => o.ot_code === auto.otCode)
      if (exact) pick(exact, auto.dispatchId, auto.requestId)
      else if (!found.length) toast.info('No se encontró la OT')
    } catch (e) { toast.error(errorMessage(e)) }
  }, [supabase, pick])
  const [auto] = useState(preset)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- búsqueda inicial de la OT elegida en Documentos
  useEffect(() => { if (!findingId && auto?.otCode) void search(auto.otCode, auto) }, [findingId, auto, search])
  const chosenOt = options.find(o => o.contract_id === form.contract_id)

  const save = async () => {
    if (!form.contract_id) { setTab('identificacion'); return toast.error('Elija la OT del hallazgo') }
    if (!form.category_ids.length || !form.description.trim()) { setTab('hallazgo'); return toast.error('Indique al menos una categoría y la descripción') }
    const p = { contract_id: form.contract_id, dispatch_id: form.dispatch_id || null, transport_request_id: form.transport_request_id || null, process_area: form.process_area, severity: form.severity,
      category_ids: form.category_ids, description: form.description.trim(), material_code: form.material_code || null, material_description: form.material_description || null,
      quantity: form.quantity ? Number(form.quantity) : null, unit: form.unit || null, location: form.location || null, observations: form.observations || null }
    setBusy(true)
    try {
      if (id) { await callRpc(supabase, 'audit_finding_update', { p_id: id, p }); toast.success('Hallazgo actualizado'); await reload(); onSaved?.(id) }
      else {
        const r = await callRpc<{ id: string; number: string }>(supabase, 'audit_finding_create', { p })
        toast.success(`Hallazgo ${r.number} registrado. Agregue las fotos ANTES.`)
        setId(r.id); setTab('evidencias'); onSaved?.(r.id)
      }
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const run = async (name: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true)
    try { await callRpc(supabase, name, args); toast.success(ok); await reload(); if (id) onSaved?.(id) } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const title = f ? `Hallazgo ${f.number}` : 'Registrar hallazgo'
  return <Modal isOpen onClose={onClose} title={title} maxWidth="max-w-5xl"
    footer={<div className="flex flex-wrap justify-end gap-2">
      <button type="button" onClick={onClose} className={secondary}>Cerrar</button>
      {editable && (tab === 'identificacion' || tab === 'hallazgo') && <button type="button" disabled={busy} onClick={() => void save()} className={primary}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{id ? 'Guardar cambios' : 'Registrar hallazgo'}</button>}
    </div>}>
    <div role="tablist" aria-label="Secciones del hallazgo" className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
      {TABS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`min-h-11 rounded-md px-3 text-sm font-semibold lg:min-h-9 ${tab === value ? 'bg-white text-jrm-navy shadow-sm' : 'text-slate-600 hover:text-jrm-navy'}`}>{label}</button>)}
    </div>

    {tab === 'identificacion' && <div className="grid gap-3 sm:grid-cols-2">
      <Field label="N.º"><input className={input} disabled value={f?.number || 'Se asigna al registrar'} /></Field>
      <Field label="Fecha de registro"><input className={input} disabled value={f ? fmtDate(f.registered_at, true) : 'Ahora'} /></Field>
      {editable && <div className="sm:col-span-2"><Field label="Buscar OT">
        <span className="flex gap-2"><input aria-label="Buscar OT" className={input} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void search(query) } }} placeholder="Código de OT" />
          <button type="button" onClick={() => void search(query)} className={secondary}><Search className="h-4 w-4" />Buscar</button></span></Field>
        {options.length > 0 && <ul className="mt-2 max-h-40 divide-y overflow-auto rounded-lg border border-slate-200 text-sm">{options.map(o => <li key={o.contract_id}>
          <button type="button" onClick={() => pick(o)} className={`w-full px-3 py-2 text-left hover:bg-blue-50 ${o.contract_id === form.contract_id ? 'bg-blue-50 font-semibold' : ''}`}>OT {o.ot_code} · {o.client_name || 'Sin cliente'}</button></li>)}</ul>}
      </div>}
      <Field label="OT"><input className={input} disabled value={form.ot_code ? `OT ${form.ot_code}` : 'Sin elegir'} /></Field>
      <Field label="Cliente"><input className={input} disabled value={form.client_name} /></Field>
      <Field label="Despacho o parada">
        {editable && chosenOt ? <select aria-label="Despacho o parada" className={input} value={`${form.dispatch_id}|${form.transport_request_id}`} onChange={e => {
          const [dispatchId, requestId] = e.target.value.split('|'), stop = chosenOt.dispatches.find(d => (d.dispatch_id || '') === dispatchId && (d.transport_request_id || '') === requestId)
          setForm(v => ({ ...v, dispatch_id: dispatchId, transport_request_id: requestId, destination: stop?.destination || '' }))
        }}>
          <option value="|">Sin despacho (auditoría en almacén)</option>
          {chosenOt.dispatches.map(d => <option key={`${d.dispatch_id}|${d.transport_request_id}`} value={`${d.dispatch_id || ''}|${d.transport_request_id || ''}`}>{[d.dispatch_number, d.request_number, d.status].filter(Boolean).join(' · ')}</option>)}
        </select> : <input className={input} disabled value={form.dispatch_id ? 'Vinculado a un despacho' : 'Sin despacho'} />}
      </Field>
      <Field label="Destino"><input className={input} disabled value={form.destination} /></Field>
      <Field label="Área o proceso"><input className={input} disabled={!editable} value={form.process_area} onChange={e => set('process_area', e.target.value)} /></Field>
      <Field label="Auditor"><input className={input} disabled value={f?.auditor_name || 'Usted'} /></Field>
      {f && <div className="sm:col-span-2 flex items-center gap-2 text-sm">Estado: <StatusBadge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</StatusBadge></div>}
    </div>}

    {tab === 'hallazgo' && <div className="space-y-4">
      <fieldset><legend className="mb-2 text-xs font-medium text-slate-500">Categorías (una o varias)</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{categories.map(c => <label key={c.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm">
          <input type="checkbox" disabled={!editable} checked={form.category_ids.includes(c.id)} onChange={e => set('category_ids', e.target.checked ? [...form.category_ids, c.id] : form.category_ids.filter(x => x !== c.id))} />
          {c.name}{c.is_safety && <span className="text-[10px] font-bold text-rose-700">SEGURIDAD</span>}</label>)}</div>
      </fieldset>
      <fieldset><legend className="mb-2 text-xs font-medium text-slate-500">Criticidad</legend>
        <div className="flex flex-wrap gap-2">{(Object.keys(SEVERITY) as Severity[]).map(s => <button key={s} type="button" disabled={!editable} aria-pressed={form.severity === s} onClick={() => set('severity', s)}
          className={`min-h-11 rounded-lg border px-4 text-sm font-semibold ${form.severity === s ? s === 'CRITICO' ? 'border-rose-600 bg-rose-600 text-white' : s === 'MAYOR' ? 'border-amber-500 bg-amber-500 text-white' : 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>{SEVERITY[s].label}</button>)}</div>
        {form.severity !== 'MENOR' && <p className="mt-2 text-xs text-amber-800">Mayor o Crítico abierto bloquea la salida del despacho vinculado.</p>}
      </fieldset>
      <Field label="Descripción"><textarea aria-label="Descripción" rows={3} className={area} disabled={!editable} value={form.description} onChange={e => set('description', e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Código de material"><input className={input} disabled={!editable} value={form.material_code} onChange={e => set('material_code', e.target.value)} /></Field>
        <Field label="Material"><input className={input} disabled={!editable} value={form.material_description} onChange={e => set('material_description', e.target.value)} /></Field>
        <Field label="Cantidad"><input type="number" min="0" step="any" className={input} disabled={!editable} value={form.quantity} onChange={e => set('quantity', e.target.value)} /></Field>
        <Field label="Unidad"><input className={input} disabled={!editable} value={form.unit} onChange={e => set('unit', e.target.value)} /></Field>
      </div>
      <Field label="Ubicación"><input className={input} disabled={!editable} value={form.location} onChange={e => set('location', e.target.value)} /></Field>
      <Field label="Observaciones"><textarea rows={2} className={area} disabled={!editable} value={form.observations} onChange={e => set('observations', e.target.value)} /></Field>
    </div>}

    {tab === 'evidencias' && (!id || !detail ? <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{id ? 'Cargando…' : 'Registre el hallazgo para adjuntar fotos.'}</p>
      : <div className="grid gap-4 lg:grid-cols-2">
        <PhotoColumn phase="ANTES" detail={detail} canUpload={!!acts?.before} can={can} onChanged={reload} />
        <PhotoColumn phase="DESPUES" detail={detail} canUpload={!!acts?.after} can={can} onChanged={reload} />
      </div>)}

    {tab === 'correccion' && (!detail || !f || !acts ? <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{id ? 'Cargando…' : 'Registre el hallazgo para asignar la corrección.'}</p>
      : <CorrectionTab detail={detail} acts={acts} busy={busy} run={run} />)}
  </Modal>
}

function PhotoColumn({ phase, detail, canUpload, can, onChanged }: { phase: Phase; detail: Detail; canUpload: boolean; can: Abilities; onChanged: () => Promise<void> }) {
  const supabase = useMemo(() => createClient(), [])
  const photos = detail.evidence.filter(e => e.phase === phase)
  const [urls, setUrls] = useState<Map<string, string>>(new Map())
  const [description, setDescription] = useState('')
  const [uploading, setUploading] = useState(false)
  const [zoom, setZoom] = useState<Evidence | null>(null)
  const paths = photos.map(p => p.file_path).join(',')
  useEffect(() => { void signedUrls(supabase, paths ? paths.split(',') : []).then(setUrls) }, [supabase, paths])
  const upload = async (file: File | undefined) => {
    if (!file || !can.userId) return
    setUploading(true)
    try { await uploadEvidence(supabase, detail.finding.id, phase, can.userId, file, description.trim()); setDescription(''); toast.success('Foto registrada'); await onChanged() }
    catch (e) { toast.error('No se pudo subir la foto: ' + errorMessage(e)) } finally { setUploading(false) }
  }
  const label = phase === 'ANTES' ? 'ANTES · hallazgo' : 'DESPUÉS · subsanación'
  return <section aria-label={`Fotos ${label}`} className="rounded-lg border border-slate-200 p-3">
    <h3 className="mb-2 text-sm font-bold text-jrm-navy">{label} <span className="font-normal text-slate-500">({photos.filter(p => !p.voided_at).length})</span></h3>
    {photos.length ? <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">{photos.map(p => <li key={p.id} className={`rounded-lg border border-slate-200 p-1 text-[11px] ${p.voided_at ? 'opacity-50' : ''}`}>
      <button type="button" onClick={() => setZoom(p)} className="block w-full" aria-label="Ampliar foto">
        {urls.get(p.file_path) ? <img src={urls.get(p.file_path)} alt={p.description || label} className="aspect-square w-full rounded object-cover" /> : <span className="grid aspect-square place-items-center rounded bg-slate-100 text-slate-400">…</span>}
      </button>
      <p className="mt-1 line-clamp-2 text-slate-700">{p.description || 'Sin descripción'}</p>
      <p className="text-slate-500">{p.uploaded_by_name || 'Usuario'} · {fmtDate(p.uploaded_at, true)}</p>
      {p.voided_at && <p className="font-semibold text-rose-700">Anulada{p.void_reason ? `: ${p.void_reason}` : ''}</p>}
    </li>)}</ul> : <p className="text-xs text-slate-500">Sin fotos.</p>}
    {canUpload && <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
      <input aria-label={`Descripción de la foto ${phase}`} className={input} placeholder="Descripción de la foto" value={description} onChange={e => setDescription(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <label className={`${secondary} cursor-pointer`}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}Tomar foto
          <input type="file" accept={PHOTO_ACCEPT} capture="environment" className="sr-only" disabled={uploading} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label>
        <label className={`${secondary} cursor-pointer`}><Upload className="h-4 w-4" />Subir
          <input type="file" accept={PHOTO_ACCEPT} className="sr-only" disabled={uploading} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label>
      </div>
      <p className="text-[11px] text-slate-500">JPG, PNG o WEBP. Se reduce a 2000 px antes de subir.</p>
    </div>}
    {zoom && <Modal isOpen onClose={() => setZoom(null)} title={`${label} · ${zoom.description || 'Foto'}`} maxWidth="max-w-4xl">
      {urls.get(zoom.file_path) && <img src={urls.get(zoom.file_path)} alt={zoom.description || label} className="mx-auto max-h-[75vh] w-auto rounded" />}
      <p className="mt-2 text-xs text-slate-500">{zoom.uploaded_by_name || 'Usuario'} · {fmtDate(zoom.uploaded_at, true)}</p>
    </Modal>}
  </section>
}

function CorrectionTab({ detail, acts, busy, run }: {
  detail: Detail; acts: ReturnType<typeof findingActions>; busy: boolean; run: (name: string, args: Record<string, unknown>, ok: string) => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const f = detail.finding
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([])
  const [assign, setAssign] = useState({ responsible: f.responsible_id || '', area: f.responsible_area || '', due: f.due_date || '', action: f.required_action || '' })
  const [fix, setFix] = useState({ action: '', at: '', observations: '' })
  const [result, setResult] = useState<'CONFORME' | 'RECHAZADO'>('CONFORME')
  const [comment, setComment] = useState('')
  const [noPhoto, setNoPhoto] = useState(false)
  const [noPhotoReason, setNoPhotoReason] = useState('')
  useEffect(() => { if (acts.assign) void supabase.rpc('audit_finding_assignable_users').then(({ data }) => setUsers(list(data, 'users'))) }, [acts.assign, supabase])
  const closable = canCloseConforme(detail, noPhoto ? noPhotoReason : '')
  const rounds = [...detail.corrections].sort((a, b) => a.round - b.round)
  return <div className="space-y-4 text-sm">
    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="mb-2 font-bold text-jrm-navy">Asignación</h3>
      {acts.assign ? <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Responsable"><select aria-label="Responsable" className={input} value={assign.responsible} onChange={e => setAssign({ ...assign, responsible: e.target.value })}>
          <option value="">Elegir…</option>{users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></Field>
        <Field label="Área responsable"><input className={input} value={assign.area} onChange={e => setAssign({ ...assign, area: e.target.value })} /></Field>
        <Field label="Fecha compromiso"><input type="date" className={input} value={assign.due} onChange={e => setAssign({ ...assign, due: e.target.value })} /></Field>
        <Field label="Acción requerida"><input className={input} value={assign.action} onChange={e => setAssign({ ...assign, action: e.target.value })} /></Field>
        <div className="sm:col-span-2"><button type="button" disabled={busy || !assign.responsible || !assign.due} onClick={() => void run('audit_finding_assign', { p_id: f.id, p_responsible: assign.responsible, p_area: assign.area, p_due: assign.due, p_required_action: assign.action }, 'Responsable asignado y notificado')} className={primary}>Asignar</button></div>
      </div> : <p className="text-slate-700">{f.responsible_name ? `${f.responsible_name}${f.responsible_area ? ` · ${f.responsible_area}` : ''} · vence ${fmtDate(f.due_date)}${f.overdue ? ' (vencido)' : ''}` : 'Sin responsable asignado.'}{f.required_action && <><br />Acción requerida: {f.required_action}</>}</p>}
    </section>

    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="mb-2 font-bold text-jrm-navy">Rondas de corrección</h3>
      {rounds.length ? <ol className="space-y-2">{rounds.map(r => <li key={r.id} className="rounded-lg bg-slate-50 p-2.5">
        <p className="font-semibold">Ronda {r.round} · {r.corrected_by_name || 'Responsable'} · {fmtDate(r.executed_at, true)}</p>
        <p>{r.action_executed}</p>{r.observations && <p className="text-xs text-slate-500">{r.observations}</p>}
        {r.result && <p className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge tone={r.result === 'CONFORME' ? 'success' : 'danger'}>{r.result === 'CONFORME' ? 'Conforme' : 'Rechazado'}</StatusBadge><span className="text-xs text-slate-600">{r.validated_by_name || 'Validador'} · {fmtDate(r.validated_at, true)}{r.validation_comment ? ` · ${r.validation_comment}` : ''}{r.no_photo_reason ? ` · Sin foto: ${r.no_photo_reason}` : ''}</span></p>}
      </li>)}</ol> : <p className="text-slate-500">Aún no hay correcciones.</p>}
      {acts.correct && <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Acción ejecutada"><textarea aria-label="Acción ejecutada" rows={2} className={area} value={fix.action} onChange={e => setFix({ ...fix, action: e.target.value })} /></Field></div>
        <Field label="Fecha y hora de ejecución"><input type="datetime-local" className={input} value={fix.at} onChange={e => setFix({ ...fix, at: e.target.value })} /></Field>
        <Field label="Observaciones"><input className={input} value={fix.observations} onChange={e => setFix({ ...fix, observations: e.target.value })} /></Field>
        <p className="sm:col-span-2 text-xs text-slate-500">Fotos DESPUÉS de esta ronda: {afterPhotos(detail).length} (se cargan en la pestaña Evidencias).</p>
        <div className="sm:col-span-2"><button type="button" disabled={busy || !fix.action.trim() || !fix.at} onClick={() => void run('audit_finding_submit_correction', { p_id: f.id, p_action: fix.action.trim(), p_executed_at: new Date(fix.at).toISOString(), p_observations: fix.observations || null }, 'Corrección enviada a validación')} className={primary}>Enviar a validación</button></div>
      </div>}
    </section>

    {acts.validate && <section aria-label="Validación" className="rounded-lg border border-blue-200 bg-blue-50/40 p-3">
      <h3 className="mb-2 font-bold text-jrm-navy">Validación</h3>
      <div className="flex flex-wrap gap-2">
        {(['CONFORME', 'RECHAZADO'] as const).map(r => <button key={r} type="button" aria-pressed={result === r} onClick={() => setResult(r)} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 font-semibold ${result === r ? r === 'CONFORME' ? 'border-emerald-700 bg-emerald-700 text-white' : 'border-rose-700 bg-rose-700 text-white' : 'border-slate-300 bg-white'}`}>{r === 'CONFORME' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}{r === 'CONFORME' ? 'Conforme' : 'Rechazado'}</button>)}
      </div>
      <div className="mt-3"><Field label={result === 'RECHAZADO' ? 'Comentario (obligatorio)' : 'Comentario'}><textarea aria-label="Comentario de validación" rows={2} className={area} value={comment} onChange={e => setComment(e.target.value)} /></Field></div>
      {result === 'CONFORME' && <div className="mt-2 space-y-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={noPhoto} onChange={e => setNoPhoto(e.target.checked)} />No requiere foto de subsanación</label>
        {noPhoto && <input aria-label="Motivo sin foto" className={input} placeholder="Motivo" value={noPhotoReason} onChange={e => setNoPhotoReason(e.target.value)} />}
        {!closable && <p role="alert" className="text-xs font-semibold text-rose-700">Para cerrar como Conforme se necesita al menos una foto DESPUÉS de esta ronda, o indicar por qué no se requiere.</p>}
      </div>}
      <button type="button" className={`${primary} mt-3`} disabled={busy || (result === 'CONFORME' ? !closable : !comment.trim())}
        onClick={() => void run('audit_finding_validate', { p_id: f.id, p_result: result, p_comment: comment.trim() || null, p_no_photo_reason: result === 'CONFORME' && noPhoto ? noPhotoReason.trim() : null }, result === 'CONFORME' ? 'Hallazgo cerrado' : 'Corrección rechazada; vuelve al responsable')}>Registrar validación</button>
    </section>}

    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="mb-2 font-bold text-jrm-navy">Historial</h3>
      {detail.events.length ? <ol className="space-y-1 text-xs">{[...detail.events].sort((a, b) => b.at.localeCompare(a.at)).map(ev => <li key={ev.id} className="flex flex-wrap gap-x-2">
        <span className="text-slate-500">{fmtDate(ev.at, true)}</span><span className="font-semibold">{ev.event_type}</span>
        {ev.to_status && <span>{STATUS[ev.from_status as keyof typeof STATUS]?.label || ev.from_status || '—'} → {STATUS[ev.to_status as keyof typeof STATUS]?.label || ev.to_status}</span>}
        <span className="text-slate-500">{ev.actor_name || ''}</span></li>)}</ol> : <p className="text-slate-500">Sin movimientos.</p>}
    </section>
  </div>
}
