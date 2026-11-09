'use client'
import { PaperFormatSelect } from './PaperFormatSelect'
import { usePersonalLabelFormat } from '@/lib/warehouse/label-format'

export function PackageLabelPaperSettings() {
  const { format, options, selection, select, error } = usePersonalLabelFormat('PAQUETE')
  return <section className="rounded-xl border border-slate-200 bg-white p-4">
    <PaperFormatSelect label="Mi papel para etiquetas de bulto" value={selection} disabled={!format.ready} onChange={value => void select(value)} options={[
      { value: '', label: 'Usar configuración del almacén' },
      ...options.map(f => ({ value: f.id, label: `${f.name} · ${f.width_mm} × ${f.height_mm} mm${f.output === 'BROWSER' ? ' · Impresora / PDF' : ` · ${f.dpi} dpi`}` })),
    ]} />
    <p className="mt-2 text-xs text-slate-600">Se guarda solo para tu cuenta en este navegador. Se aplica a la vista previa, impresión y reimpresión, sin cambiar el papel de otros usuarios.</p>
    {format.ready && <p role="status" className="mt-1 text-xs text-slate-600">Papel actual: {format.name} · {format.width_mm} × {format.height_mm} mm. Una etiqueta por hoja. Imprime a tamaño real / 100 %, sin márgenes ni encabezados.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </section>
}
