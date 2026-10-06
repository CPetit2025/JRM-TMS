'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { ClipboardCheck, Plus, RefreshCw, Loader2, Trash2, Edit2, Camera, Eraser } from 'lucide-react'
import { PreuseReports } from '@/components/driver/PreuseReports'

// Inspecciones y checklist (Fase 6). Toda inspección entra por submit_inspection (web y App);
// una respuesta crítica genera la falla y bloquea la unidad (migración 20260927180000).

const supabase = createClient()
const fileStamp = () => `${Date.now()}`

const INSPECTION_TYPES = ['PREOPERACIONAL', 'POSTOPERACIONAL', 'PERIODICA', 'SEGURIDAD', 'INSPECCION_TECNICA']
const ASSET_TYPES = ['CAMION', 'CAMIONETA', 'FURGON', 'TRAILER', 'TRACTO', 'SEMIRREMOLQUE', 'MONTACARGAS', 'APILADOR', 'TRANSPALETA', 'OTRO']
const RESPONSE_TYPES: Record<string, string> = { OK_MAL: 'OK / Malo', YES_NO: 'Sí / No', PASS_FAIL: 'Pasa / Falla', NUMERIC: 'Número', TEXT: 'Texto' }
const RESULT_STYLE: Record<string, string> = { PASSED: 'bg-emerald-100 text-emerald-700', WARNING: 'bg-amber-100 text-amber-700', FAILED: 'bg-red-100 text-red-700' }
const RESULT_LABEL: Record<string, string> = { PASSED: 'Aprobada', WARNING: 'Con observaciones', FAILED: 'Falla crítica' }

interface Item { id?: string; code?: string | null; text: string; is_critical: boolean; response_type: string; requires_photo: boolean; position: number }
interface Template { id: string; name: string; type: string; code: string | null; asset_types: string[] | null; requires_signature: boolean; requires_odometer: boolean; active: boolean; checklist_items: Item[] }
interface InspectionRow {
  id: string; date: string; vehicle_plate: string; vehicle_type: string; inspection_type: string; template_name: string
  global_result: string; failed_items: number; critical_failures: number; odometer: number | null; hours: number | null
  signature_url: string | null; source: string; driver_name: string | null; inspector_name: string | null; requests_created: number; notes: string | null
}
interface Vehicle { plate: string; type: string; current_odometer: number | null; current_hours: number | null }

function loadAll() {
  return Promise.all([
    supabase.from('vw_inspections').select('*').order('date', { ascending: false }).limit(200),
    supabase.from('checklist_templates').select('*, checklist_items(*)').order('name'),
    supabase.from('vehicles').select('plate, type, current_odometer, current_hours').order('plate'),
  ])
}

export default function ChecklistsPage() {
  const [tab, setTab] = useState<'preuso' | 'inspecciones' | 'nueva' | 'plantillas'>('preuso')
  const [inspections, setInspections] = useState<InspectionRow[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [loading, setLoading] = useState(true)
  const [resultFilter, setResultFilter] = useState('TODOS')
  const [detail, setDetail] = useState<InspectionRow | null>(null)
  const [editing, setEditing] = useState<Template | 'new' | null>(null)

  const apply = useCallback(([ins, tpl, veh]: Awaited<ReturnType<typeof loadAll>>) => {
    if (ins.error || tpl.error) toast.error('Error al cargar: ' + (ins.error || tpl.error)?.message)
    setInspections((ins.data || []) as InspectionRow[])
    setTemplates(((tpl.data || []) as Template[]).map(t => ({ ...t, checklist_items: [...(t.checklist_items || [])].sort((a, b) => a.position - b.position) })))
    setVehicles(veh.data || [])
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const filtered = useMemo(() => inspections.filter(i => resultFilter === 'TODOS' || i.global_result === resultFilter), [inspections, resultFilter])

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><ClipboardCheck className="w-6 h-6" />Inspecciones y checklist</h1>
          <p className="text-sm text-slate-500">Plantillas por tipo de activo. Una respuesta crítica genera la falla y bloquea la unidad automáticamente.</p>
        </div>
        <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[['Inspecciones', inspections.length], ['Aprobadas', inspections.filter(i => i.global_result === 'PASSED').length],
          ['Con observaciones', inspections.filter(i => i.global_result === 'WARNING').length], ['Falla crítica', inspections.filter(i => i.global_result === 'FAILED').length]]
          .map(([l, v]) => <div key={l as string} className="bg-white border rounded-xl p-3"><div className="text-xs text-slate-500">{l}</div><div className="text-2xl font-bold">{v}</div></div>)}
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {([['preuso', 'FR-DT 007 · Pre uso'], ['inspecciones', 'Inspecciones'], ['nueva', 'Nueva inspección'], ['plantillas', 'Plantillas']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? 'border-[#002855] text-[#002855] font-semibold' : 'border-transparent text-slate-500'}`}>{l}</button>
        ))}
      </div>

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          {tab === 'preuso' && <PreuseReports />}
          {tab === 'inspecciones' && (
            <div className="space-y-3">
              <select value={resultFilter} onChange={e => setResultFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                <option value="TODOS">Todos los resultados</option>{Object.entries(RESULT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <div className="bg-white border rounded-xl overflow-x-auto">
                {filtered.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">Sin inspecciones registradas.</p> : (
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                      <th className="text-left p-3">Fecha</th><th className="text-left p-3">Unidad</th><th className="text-left p-3">Tipo / plantilla</th>
                      <th className="text-left p-3">Resultado</th><th className="text-left p-3">Inspector</th><th className="text-right p-3">Fallas generadas</th>
                    </tr></thead>
                    <tbody className="divide-y">
                      {filtered.map(i => (
                        <tr key={i.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setDetail(i)}>
                          <td className="p-3">{format(new Date(i.date), 'dd/MM/yyyy HH:mm')}<div className="text-[11px] text-slate-400">{i.source}</div></td>
                          <td className="p-3 font-semibold">{i.vehicle_plate}<div className="text-[11px] text-slate-500 font-normal">{i.vehicle_type}</div></td>
                          <td className="p-3">{i.inspection_type}<div className="text-xs text-slate-500">{i.template_name}</div></td>
                          <td className="p-3"><span className={`px-2 py-1 rounded text-xs font-bold ${RESULT_STYLE[i.global_result] || ''}`}>{RESULT_LABEL[i.global_result] || i.global_result}</span></td>
                          <td className="p-3 text-slate-600">{i.inspector_name || i.driver_name || '—'}</td>
                          <td className="p-3 text-right">{i.requests_created}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
          {tab === 'nueva' && <InspectionForm templates={templates.filter(t => t.active !== false && t.code !== 'FR_DT007')} vehicles={vehicles} onDone={() => { setTab('inspecciones'); refresh() }} />}
          {tab === 'plantillas' && (
            <div className="space-y-3">
              <button onClick={() => setEditing('new')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Nueva plantilla</button>
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {templates.map(t => (
                  <div key={t.id} className="bg-white border rounded-xl p-4 space-y-2">
                    <div className="flex justify-between gap-2">
                      <div><div className="font-semibold">{t.name}</div><div className="text-xs text-slate-500">{t.type} · {t.asset_types?.length ? t.asset_types.join(', ') : 'todos los activos'}</div></div>
                      {!['APP_PRE_RUTA','FR_DT007'].includes(t.code || '') && <button onClick={() => setEditing(t)} className="p-1.5 border rounded-lg h-fit"><Edit2 className="w-4 h-4" /></button>}
                    </div>
                    <div className="text-xs text-slate-500">{t.checklist_items.length} preguntas · {t.checklist_items.filter(i => i.is_critical).length} críticas{t.requires_signature ? ' · requiere firma' : ''}{t.code === 'APP_PRE_RUTA' ? ' · plantilla del sistema (App)' : ''}</div>
                    <ul className="text-xs text-slate-600 list-disc ml-4">{t.checklist_items.slice(0, 5).map(i => <li key={i.id}>{i.text}{i.is_critical ? ' ⚠' : ''}</li>)}</ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {detail && <InspectionDetail row={detail} onClose={() => setDetail(null)} />}
      {editing && <TemplateModal template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
    </div>
  )
}

function InspectionDetail({ row, onClose }: { row: InspectionRow; onClose: () => void }) {
  const [results, setResults] = useState<{ id: string; response: string; observation: string | null; photo_url: string | null; checklist_items: { text: string; is_critical: boolean } | null }[]>([])
  useEffect(() => {
    supabase.from('inspection_results').select('id, response, observation, photo_url, checklist_items(text, is_critical)').eq('inspection_id', row.id)
      .then(({ data }) => setResults((data || []) as unknown as typeof results))
  }, [row.id])
  return (
    <Modal isOpen onClose={onClose} title={`Inspección ${row.vehicle_plate} · ${format(new Date(row.date), 'dd/MM/yyyy HH:mm')}`} maxWidth="max-w-2xl">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2 items-center">
          <span className={`px-2 py-1 rounded text-xs font-bold ${RESULT_STYLE[row.global_result] || ''}`}>{RESULT_LABEL[row.global_result] || row.global_result}</span>
          <span className="text-slate-500">{row.template_name} · odómetro {row.odometer ?? '—'} · horómetro {row.hours ?? '—'} · {row.requests_created} falla(s) generada(s)</span>
        </div>
        <table className="w-full text-sm"><tbody className="divide-y">
          {results.map(r => (
            <tr key={r.id}>
              <td className="py-2">{r.checklist_items?.text}{r.checklist_items?.is_critical ? <span className="text-red-600 text-xs"> (crítica)</span> : null}{r.observation && <div className="text-xs text-slate-500">{r.observation}</div>}</td>
              <td className="py-2 font-semibold text-right">{r.response}</td>
              <td className="py-2 text-right w-16">{r.photo_url && /^https?:/.test(r.photo_url) ? <a href={r.photo_url} target="_blank" rel="noreferrer" className="text-blue-600 text-xs">foto</a> : null}</td>
            </tr>
          ))}
        </tbody></table>
        {row.notes && <p className="text-slate-600">{row.notes}</p>}
        {row.signature_url && /^https?:/.test(row.signature_url) && <a href={row.signature_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline">Ver firma del inspector</a>}
      </div>
    </Modal>
  )
}

function negativeOptions(type: string): [string, string] {
  if (type === 'YES_NO') return ['SI', 'NO']
  if (type === 'PASS_FAIL') return ['PASA', 'FALLA']
  return ['OK', 'MAL']
}

function InspectionForm({ templates, vehicles, onDone }: { templates: Template[]; vehicles: Vehicle[]; onDone: () => void }) {
  const [plate, setPlate] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [answers, setAnswers] = useState<Record<string, { response: string; observation: string; photo_url: string }>>({})
  const [odometer, setOdometer] = useState('')
  const [hours, setHours] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [signed, setSigned] = useState(false)
  const vehicle = vehicles.find(v => v.plate === plate)
  const available = templates.filter(t => t.code !== 'APP_PRE_RUTA' && (!t.asset_types?.length || (vehicle && t.asset_types.includes(vehicle.type))))
  const template = available.find(t => t.id === templateId)

  const setAnswer = (id: string, patch: Partial<{ response: string; observation: string; photo_url: string }>) =>
    setAnswers(a => ({ ...a, [id]: { ...(a[id] ?? { response: '', observation: '', photo_url: '' }), ...patch } }))

  const uploadPhoto = async (itemId: string, file: File) => {
    const path = `inspecciones/${plate}/${fileStamp()}-${file.name.replace(/[^\w.-]/g, '_')}`
    const { error } = await supabase.storage.from('evidence').upload(path, file, { contentType: file.type })
    if (error) return toast.error(error.message)
    setAnswer(itemId, { photo_url: supabase.storage.from('evidence').getPublicUrl(path).data.publicUrl })
    toast.success('Foto adjuntada')
  }

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top] as const
  }
  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true
    const ctx = e.currentTarget.getContext('2d'); if (!ctx) return
    const [x, y] = point(e); ctx.beginPath(); ctx.moveTo(x, y)
  }
  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const ctx = e.currentTarget.getContext('2d'); if (!ctx) return
    const [x, y] = point(e); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineTo(x, y); ctx.stroke(); setSigned(true)
  }
  const clearSignature = () => { const c = canvasRef.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); setSigned(false) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!template) return
    setSaving(true)
    let signatureUrl: string | null = null
    if (signed && canvasRef.current) {
      const blob: Blob | null = await new Promise(res => canvasRef.current!.toBlob(res, 'image/png'))
      if (blob) {
        const path = `inspecciones/${plate}/${fileStamp()}-firma.png`
        const { error } = await supabase.storage.from('signatures').upload(path, blob, { contentType: 'image/png' })
        if (error) { setSaving(false); return toast.error('No se pudo guardar la firma: ' + error.message) }
        signatureUrl = supabase.storage.from('signatures').getPublicUrl(path).data.publicUrl
      }
    }
    const payload = template.checklist_items.map(i => ({ item_id: i.id, response: answers[i.id!]?.response || '', observation: answers[i.id!]?.observation || null, photo_url: answers[i.id!]?.photo_url || null }))
    const { data, error } = await supabase.rpc('submit_inspection', {
      p_vehicle_plate: plate, p_template_id: template.id, p_answers: payload,
      p_odometer: odometer ? Number(odometer) : null, p_hours: hours ? Number(hours) : null,
      p_signature_url: signatureUrl, p_dispatch_id: null, p_notes: notes || null, p_location: null, p_source: 'WEB',
    })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    if (data.global_result === 'FAILED') toast.error(`Falla crítica: se generaron ${data.requests_created} falla(s) y la unidad quedó ${data.vehicle_status}.`, { duration: 8000 })
    else toast.success(data.global_result === 'WARNING' ? 'Inspección registrada con observaciones.' : 'Inspección aprobada.')
    onDone()
  }

  const field = 'border rounded-lg px-3 py-2 text-sm'
  return (
    <form onSubmit={submit} className="bg-white border rounded-xl p-4 space-y-4 text-sm">
      <div className="grid md:grid-cols-4 gap-3">
        <label>Unidad<select required className={`${field} w-full`} value={plate} onChange={e => { setPlate(e.target.value); setTemplateId(''); setAnswers({}) }}>
          <option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.plate} value={v.plate}>{v.plate} · {v.type}</option>)}</select></label>
        <label>Plantilla<select required className={`${field} w-full`} value={templateId} onChange={e => { setTemplateId(e.target.value); setAnswers({}) }} disabled={!plate}>
          <option value="">{plate ? (available.length ? 'Seleccionar…' : 'Sin plantillas para este tipo') : 'Elija la unidad'}</option>{available.map(t => <option key={t.id} value={t.id}>{t.name} ({t.type})</option>)}</select></label>
        <label>Odómetro {vehicle && <span className="text-[11px] text-slate-400">(actual {vehicle.current_odometer ?? 0})</span>}<input type="number" min={0} className={`${field} w-full`} value={odometer} onChange={e => setOdometer(e.target.value)} /></label>
        <label>Horómetro {vehicle && <span className="text-[11px] text-slate-400">(actual {vehicle.current_hours ?? 0})</span>}<input type="number" min={0} step="0.1" className={`${field} w-full`} value={hours} onChange={e => setHours(e.target.value)} /></label>
      </div>

      {template && (
        <>
          <div className="divide-y border rounded-xl">
            {template.checklist_items.map(item => {
              const a = answers[item.id!] || { response: '', observation: '', photo_url: '' }
              const [okV, badV] = negativeOptions(item.response_type)
              return (
                <div key={item.id} className="p-3 grid md:grid-cols-[1fr_auto] gap-2 items-center">
                  <div>
                    <div className="font-medium">{item.text}{item.is_critical && <span className="ml-2 text-xs text-red-600 font-semibold">CRÍTICA</span>}{item.requires_photo && <span className="ml-2 text-xs text-slate-500">foto obligatoria</span>}</div>
                    <input className={`${field} w-full mt-1`} placeholder="Observación" value={a.observation} onChange={e => setAnswer(item.id!, { observation: e.target.value })} />
                  </div>
                  <div className="flex items-center gap-2">
                    {item.response_type === 'NUMERIC' || item.response_type === 'TEXT' ? (
                      <input type={item.response_type === 'NUMERIC' ? 'number' : 'text'} className={`${field} w-32`} value={a.response} onChange={e => setAnswer(item.id!, { response: e.target.value })} />
                    ) : [okV, badV].map(v => (
                      <button type="button" key={v} onClick={() => setAnswer(item.id!, { response: v })}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-bold ${a.response === v ? (v === okV ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-red-500 text-white border-red-500') : ''}`}>{v}</button>
                    ))}
                    <label className={`p-1.5 border rounded-lg cursor-pointer ${a.photo_url ? 'bg-emerald-50 border-emerald-300' : ''}`} title="Adjuntar foto">
                      <Camera className="w-4 h-4" /><input type="file" accept="image/*" className="hidden" onChange={e => e.target.files?.[0] && uploadPhoto(item.id!, e.target.files[0])} />
                    </label>
                  </div>
                </div>
              )
            })}
          </div>
          <label className="block">Notas<textarea className={`${field} w-full`} rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
          <div>
            <div className="flex items-center justify-between"><span>Firma del inspector {template.requires_signature && <span className="text-red-600">*</span>}</span>
              <button type="button" onClick={clearSignature} className="text-xs flex items-center gap-1 text-slate-500"><Eraser className="w-3.5 h-3.5" />Limpiar</button></div>
            <canvas ref={canvasRef} width={500} height={140} className="border rounded-lg bg-slate-50 touch-none max-w-full"
              onPointerDown={startDraw} onPointerMove={draw} onPointerUp={() => { drawing.current = false }} onPointerLeave={() => { drawing.current = false }} />
          </div>
          <div className="flex justify-end"><button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">{saving ? 'Registrando…' : 'Registrar inspección'}</button></div>
        </>
      )}
    </form>
  )
}

function TemplateModal({ template, onClose, onSaved }: { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: template?.name || '', type: template?.type || 'PREOPERACIONAL', asset_types: template?.asset_types || [] as string[],
    requires_signature: template?.requires_signature ?? false, requires_odometer: template?.requires_odometer ?? true, active: template?.active ?? true,
  })
  const [items, setItems] = useState<Item[]>(template?.checklist_items || [])
  const [saving, setSaving] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!items.filter(i => i.text.trim()).length) return toast.error('Agregue al menos una pregunta')
    setSaving(true)
    const payload = { ...form, asset_types: form.asset_types.length ? form.asset_types : null }
    const res = template
      ? await supabase.from('checklist_templates').update(payload).eq('id', template.id).select('id').single()
      : await supabase.from('checklist_templates').insert(payload).select('id').single()
    if (res.error || !res.data) { setSaving(false); return toast.error(res.error?.message || 'No se pudo guardar') }
    const tplId = res.data.id
    const keep = items.filter(i => i.id).map(i => i.id!)
    if (template) {
      const removed = template.checklist_items.filter(i => !keep.includes(i.id!)).map(i => i.id!)
      if (removed.length) await supabase.from('checklist_items').delete().in('id', removed)
    }
    for (const [idx, it] of items.filter(i => i.text.trim()).entries()) {
      const row = { template_id: tplId, text: it.text.trim(), is_critical: it.is_critical, response_type: it.response_type, requires_photo: it.requires_photo, position: idx + 1 }
      const { error } = it.id ? await supabase.from('checklist_items').update(row).eq('id', it.id) : await supabase.from('checklist_items').insert(row)
      if (error) { setSaving(false); return toast.error(error.message) }
    }
    setSaving(false)
    toast.success('Plantilla guardada')
    onSaved()
  }

  const field = 'border rounded-lg px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title={template ? `Editar ${template.name}` : 'Nueva plantilla'} maxWidth="max-w-3xl">
      <form onSubmit={save} className="space-y-3 text-sm max-h-[75vh] overflow-y-auto pr-1">
        <div className="grid md:grid-cols-2 gap-3">
          <label>Nombre<input required className={`${field} w-full`} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>Tipo de inspección<select className={`${field} w-full`} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>{INSPECTION_TYPES.map(t => <option key={t}>{t}</option>)}</select></label>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">Aplica a (vacío = todos los activos)</div>
          <div className="flex flex-wrap gap-2">{ASSET_TYPES.map(a => (
            <label key={a} className="flex items-center gap-1 text-xs border rounded-lg px-2 py-1">
              <input type="checkbox" checked={form.asset_types.includes(a)} onChange={e => setForm({ ...form, asset_types: e.target.checked ? [...form.asset_types, a] : form.asset_types.filter(x => x !== a) })} />{a}
            </label>))}
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.requires_signature} onChange={e => setForm({ ...form, requires_signature: e.target.checked })} />Requiere firma</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.requires_odometer} onChange={e => setForm({ ...form, requires_odometer: e.target.checked })} />Requiere odómetro/horómetro</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />Activa</label>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-500">Preguntas</div>
          {items.map((it, i) => (
            <div key={it.id || i} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-center">
              <input className={field} value={it.text} placeholder="Pregunta" onChange={e => setItems(items.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} />
              <select className={field} value={it.response_type} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, response_type: e.target.value } : x))}>{Object.entries(RESPONSE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={it.is_critical} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, is_critical: e.target.checked } : x))} />Crítica</label>
              <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={it.requires_photo} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, requires_photo: e.target.checked } : x))} />Foto</label>
              <button type="button" onClick={() => setItems(items.filter((_, j) => j !== i))} className="p-1.5 border rounded-lg"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button type="button" onClick={() => setItems([...items, { text: '', is_critical: false, response_type: 'OK_MAL', requires_photo: false, position: items.length + 1 }])} className="text-xs text-blue-600">+ Agregar pregunta</button>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
          <button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </Modal>
  )
}
