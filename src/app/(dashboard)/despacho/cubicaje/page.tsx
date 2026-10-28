"use client"
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Save, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { errorMessage } from '@/lib/caja'
import { fmtDateTime } from '@/lib/apt/format'

// Densidad de carga (kg por m³) por familia de producto del ERP. Con ella «Armar ruta» convierte el peso de cada OT en
// volumen y lo compara con la capacidad de la unidad. El LPN estándar por familia queda pendiente.
type Familia = { familia: string; kg_por_m3: number | null; notas: string | null; updated_at: string | null; kg_stock: number; en_erp: boolean }
type Lista = { success: true; puede_editar: boolean; familias: Familia[] }

const supabase = createClient()

export default function CubicajePage() {
  const [data, setData] = useState<Lista | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Record<string, { kg_por_m3: string; notas: string }>>({})
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data: out, error } = await supabase.rpc('cubicaje_familias_lista')
    if (error || !out?.success) toast.error('No se pudo cargar el catálogo: ' + (error ? errorMessage(error) : out?.error ?? 'sin acceso'))
    else setData(out as Lista)
    setLoading(false)
  }, [])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const filas = useMemo(() => (data?.familias ?? []).filter(f => !q.trim() || f.familia.toLowerCase().includes(q.trim().toLowerCase())), [data, q])
  const configuradas = (data?.familias ?? []).filter(f => f.kg_por_m3).length

  const save = async (f: Familia) => {
    const e = edit[f.familia]
    if (!e) return
    setSaving(f.familia)
    const { data: out, error } = await supabase.rpc('cubicaje_familia_guardar', { p: { familia: f.familia, kg_por_m3: e.kg_por_m3, notas: e.notas } })
    setSaving(null)
    if (error || !out?.success) { toast.error(error ? errorMessage(error) : out?.error ?? 'No se pudo guardar'); return }
    toast.success(`Densidad de ${f.familia} guardada`)
    setEdit(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== f.familia)))
    void load()
  }

  return (
    <div className="mx-auto w-full space-y-3">
      <PageHeader showTitle title="Cubicaje por familia" description="Densidad de carga (kg por m³) para estimar el volumen de cada ruta"
        actions={<Link href="/despacho" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Volver a Programación</Link>} />
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
        <p>El volumen de una ruta se calcula como <b>kg de la familia ÷ kg por m³</b>. Ejemplo: 2.000 kg de una familia con 250 kg/m³ ocupan 8 m³.
          Las familias sin densidad se informan como «sin medida» y el volumen de la ruta queda parcial. El peso viene del ERP (pendiente con stock) o del peso estimado de la solicitud.</p>
        <p className="mt-1 text-xs text-blue-800">LPN (pallet o bulto estándar por familia): pendiente de definir.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 basis-64"><span className="sr-only">Buscar familia</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar familia…" className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]" /></label>
        {data && <p className="text-sm text-slate-600"><b>{configuradas}</b> de <b>{data.familias.length}</b> familias con densidad</p>}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {loading && !data ? <p className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Cargando familias…</p>
          : !filas.length ? <p className="p-8 text-center text-sm text-slate-500">{data?.familias.length ? 'Ninguna familia coincide con la búsqueda.' : 'Aún no hay familias: cargue el stock o el Actualizable del ERP.'}</p>
          : <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr><th className="px-3 py-2 font-semibold">Familia</th><th className="px-3 py-2 text-right font-semibold">kg en stock</th><th className="px-3 py-2 font-semibold">kg por m³</th><th className="px-3 py-2 font-semibold">Notas</th><th className="px-3 py-2 font-semibold">Actualizado</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filas.map(f => {
                const e = edit[f.familia]
                const value = e ?? { kg_por_m3: f.kg_por_m3 == null ? '' : String(f.kg_por_m3), notas: f.notas ?? '' }
                const set = (patch: Partial<typeof value>) => setEdit(prev => ({ ...prev, [f.familia]: { ...value, ...patch } }))
                return <tr key={f.familia}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{f.familia}{!f.en_erp && <span className="ml-2 text-xs font-normal text-slate-500">(no está en el ERP vigente)</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{f.kg_stock.toLocaleString('es-PE')}</td>
                  <td className="px-3 py-2">{data?.puede_editar
                    ? <input type="number" min="0" step="0.01" inputMode="decimal" aria-label={`kg por m³ de ${f.familia}`} value={value.kg_por_m3} onChange={ev => set({ kg_por_m3: ev.target.value })} placeholder="Sin medida"
                        className="w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]" />
                    : f.kg_por_m3 ?? <span className="font-semibold text-amber-700">Sin medida</span>}</td>
                  <td className="px-3 py-2">{data?.puede_editar
                    ? <input type="text" aria-label={`Notas de ${f.familia}`} value={value.notas} onChange={ev => set({ notas: ev.target.value })} placeholder="Opcional"
                        className="w-full min-w-40 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]" />
                    : f.notas}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{f.updated_at && f.kg_por_m3 != null ? fmtDateTime(f.updated_at) : '—'}</td>
                  <td className="px-3 py-2 text-right">{data?.puede_editar && e && <button type="button" onClick={() => void save(f)} disabled={saving === f.familia}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#001d3d] disabled:opacity-50">
                    {saving === f.familia ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}Guardar</button>}</td>
                </tr>
              })}
            </tbody>
          </table>}
      </div>
    </div>
  )
}
