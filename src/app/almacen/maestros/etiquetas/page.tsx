'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Pencil, Ruler, Tag } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { PackageLabelPaperSettings } from '@/components/warehouse/PackageLabelPaperSettings'
import type { LabelFormat, LabelKind } from '@/lib/warehouse/label-format'

const KINDS: Array<{ kind: LabelKind; label: string; hint: string }> = [
  { kind: 'PAQUETE', label: 'Etiqueta de paquete', hint: 'Recepción y etiquetado, y reimpresiones desde el detalle del paquete.' },
  { kind: 'LPN', label: 'Etiqueta LPN', hint: 'LPN consolidado en picking.' },
]
const empty = { id: '', name: '', width: '', height: '', dpi: '203', active: true }
const inches = (mm: number) => (mm / 25.4).toLocaleString('es-PE', { maximumFractionDigits: 2 })

export default function WarehouseLabelFormatsPage() {
  const { hasAccess } = usePermissions()
  const canEdit = hasAccess('almacen-supervisor')
  const [formats, setFormats] = useState<LabelFormat[]>([])
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [form, setForm] = useState(empty)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const db = createClient()
    const [f, s] = await Promise.all([
      db.from('wh_label_formats').select('id,name,width_mm,height_mm,dpi,is_active').order('width_mm').order('height_mm'),
      db.from('wh_label_settings').select('kind,format_id'),
    ])
    if (f.error || s.error) setError((f.error || s.error)!.message)
    else {
      setFormats((f.data || []).map(r => ({ ...r, width_mm: Number(r.width_mm), height_mm: Number(r.height_mm) })) as LabelFormat[])
      setSettings(Object.fromEntries((s.data || []).map(r => [r.kind, r.format_id])))
    }
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setBusy(true); setError(''); setNotice('')
    const { error } = await fn()
    if (error) setError(error.message); else { setNotice(ok); await load() }
    setBusy(false)
    return !error
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const done = await run(() => createClient().rpc('wh_label_format_save', {
      p_id: form.id || null, p_name: form.name, p_width_mm: Number(form.width), p_height_mm: Number(form.height), p_dpi: Number(form.dpi), p_active: form.active,
    }), `Formato ${form.name.trim()} guardado.`)
    if (done) setForm(empty)
  }
  const assign = (kind: LabelKind, formatId: string) =>
    void run(() => createClient().rpc('wh_label_setting_set', { p_kind: kind, p_format_id: formatId }), 'Tamaño asignado. Se aplica en la próxima impresión.')

  const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal'
  return <div className="w-full space-y-5">
    <header>
      <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Configuración</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Tamaños de etiqueta</h1>
      <p className="mt-1 text-sm text-slate-600">Defina las medidas de la etiqueta y su orientación. Configure por separado la hoja de la impresora: imprimir en A4 no cambia el tamaño de la etiqueta.</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

    <PackageLabelPaperSettings />
    <h2 className="font-bold text-[#002855]">Formatos de etiqueta compartidos del almacén</h2>
    <section className="grid gap-3 sm:grid-cols-2">
      {KINDS.map(k => {
        const current = formats.find(f => f.id === settings[k.kind])
        return <div key={k.kind} className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="flex items-center gap-2 font-bold text-[#002855]"><Tag size={16}/>{k.label}</h2>
          <p className="text-xs text-slate-500">{k.hint}</p>
          <select disabled={!canEdit || busy || loading} value={settings[k.kind] || ''} onChange={e => assign(k.kind, e.target.value)} className={field} aria-label={`Tamaño de ${k.label}`}>
            {!current && <option value="">Sin asignar</option>}
            {formats.filter(f => f.is_active || f.id === settings[k.kind]).map(f => <option key={f.id} value={f.id}>{f.name} · {f.width_mm} x {f.height_mm} mm</option>)}
          </select>
          {current && <div className="mt-3 flex h-28 items-center justify-center rounded-lg bg-slate-50">
            {/* Muestra proporcional del tamaño elegido */}
            <div className="flex items-center justify-center border-2 border-dashed border-slate-400 bg-white text-[10px] text-slate-500"
              style={{ width: `${current.width_mm / Math.max(current.width_mm, current.height_mm) * 96}px`, height: `${current.height_mm / Math.max(current.width_mm, current.height_mm) * 96}px` }}>
              {current.width_mm} x {current.height_mm}
            </div>
          </div>}
        </div>
      })}
    </section>

    {canEdit && <form onSubmit={save} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-[1.6fr_1fr_1fr_1fr_auto] sm:items-end">
      <label className="text-sm font-semibold">Nombre<input required minLength={2} maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Zebra 4 x 6 pulg" className={field}/></label>
      <label className="text-sm font-semibold">Ancho (mm)<input required type="number" min={15} max={450} step="0.1" value={form.width} onChange={e => setForm({ ...form, width: e.target.value })} className={field}/></label>
      <label className="text-sm font-semibold">Alto (mm)<input required type="number" min={10} max={650} step="0.1" value={form.height} onChange={e => setForm({ ...form, height: e.target.value })} className={field}/></label>
      <label className="text-sm font-semibold">Resolución Zebra<select value={form.dpi} onChange={e => setForm({ ...form, dpi: e.target.value })} className={field}><option value="203">203 dpi</option><option value="300">300 dpi</option><option value="600">600 dpi</option></select></label>
      <div className="flex gap-2">
        {form.id && <button type="button" onClick={() => setForm(empty)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Cancelar</button>}
        <button disabled={busy} className="rounded-lg bg-[#002855] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{form.id ? 'Guardar' : 'Agregar'}</button>
      </div>
      {form.id && <label className="flex items-center gap-2 text-sm sm:col-span-5"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })}/>Disponible para asignar</label>}
    </form>}

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex items-center gap-2 border-b p-4"><Ruler size={18} className="text-blue-700"/><h2 className="font-bold text-[#002855]">Formatos · {formats.length}</h2></header>
      {loading ? <p className="p-8 text-center text-sm text-slate-500">Cargando formatos…</p> : <div className="overflow-x-auto"><table className="min-w-[560px] lg:min-w-0 w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs font-bold uppercase text-slate-600"><tr><th className="px-4 py-2">Nombre</th><th className="px-4 py-2">Medida</th><th className="px-4 py-2">Resolución</th><th className="px-4 py-2">Uso</th><th className="px-4 py-2"/></tr></thead>
        <tbody className="divide-y divide-slate-100">{formats.map(f => {
          const usedBy = KINDS.filter(k => settings[k.kind] === f.id).map(k => k.label)
          return <tr key={f.id} className={f.is_active ? '' : 'text-slate-400'}>
            <td className="px-4 py-2 font-semibold">{f.name}{!f.is_active && ' · inactivo'}</td>
            <td className="px-4 py-2">{f.width_mm} x {f.height_mm} mm <small className="text-slate-500">({inches(f.width_mm)} x {inches(f.height_mm)} pulg)</small></td>
            <td className="px-4 py-2">{f.dpi} dpi</td>
            <td className="px-4 py-2 text-xs">{usedBy.join(', ') || '—'}</td>
            <td className="px-4 py-2 text-right">{canEdit && <button type="button" onClick={() => setForm({ id: f.id, name: f.name, width: String(f.width_mm), height: String(f.height_mm), dpi: String(f.dpi), active: f.is_active })} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-800"><Pencil size={13}/>Editar</button>}</td>
          </tr>
        })}</tbody>
      </table></div>}
    </section>
  </div>
}
