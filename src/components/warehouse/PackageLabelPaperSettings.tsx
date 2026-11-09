'use client'
import { usePersonalLabelFormat } from '@/lib/warehouse/label-format'

export function PackageLabelPaperSettings() {
  const { format, options, selection, select, error } = usePersonalLabelFormat('PAQUETE')
  return <section className="rounded-xl border border-slate-200 bg-white p-4">
    <label className="block text-sm font-bold text-[#002855]">Mi papel para etiquetas de bulto
      <select className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" value={selection} disabled={!format.ready} onChange={e => void select(e.target.value)}>
        <option value="">Usar configuración del almacén</option>
        {options.map(f => <option key={f.id} value={f.id}>{f.name} · {f.width_mm} × {f.height_mm} mm{f.output === 'BROWSER' ? ' · Impresora / PDF' : ` · ${f.dpi} dpi`}</option>)}
      </select>
    </label>
    <p className="mt-2 text-xs text-slate-600">Se guarda solo para tu cuenta en este navegador. Se aplica a la vista previa, impresión y reimpresión, sin cambiar el papel de otros usuarios.</p>
    {format.ready && <p role="status" className="mt-1 text-xs text-slate-600">Papel actual: {format.name} · {format.width_mm} × {format.height_mm} mm. Una etiqueta por hoja. Imprime a tamaño real / 100 %, sin márgenes ni encabezados.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </section>
}
