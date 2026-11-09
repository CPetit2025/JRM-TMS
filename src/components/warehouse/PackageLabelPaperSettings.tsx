'use client'
import { useState } from 'react'
import { PaperFormatSelect } from './PaperFormatSelect'
import { usePersonalLabelFormat } from '@/lib/warehouse/label-format'
import { labelPrintPage, PRINTER_PAPERS, type LabelOrientation, type PrinterPaper, type PrintPreferences, type LabelPosition } from '@/lib/warehouse/label-print-layout'

function Measure({ label, value, min, max, disabled, onChange }: { label: string; value: string; min: number; max: number; disabled: boolean; onChange: (value: string) => void }) {
  return <label className="block text-sm font-semibold text-[#002855]">{label}
    <input type="number" min={min} max={max} step="0.1" required value={value} disabled={disabled} onChange={e => onChange(e.target.value)}
      className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
  </label>
}
function SheetMeasures({ preferences, disabled, onSave }: { preferences: PrintPreferences; disabled: boolean; onSave: (patch: Partial<PrintPreferences>) => void }) {
  const [width, setWidth] = useState(String(preferences.paperWidth))
  const [height, setHeight] = useState(String(preferences.paperHeight))
  const [margin, setMargin] = useState(String(preferences.margin))
  return <form className="grid gap-3 sm:grid-cols-3" onSubmit={e => {
    e.preventDefault()
    onSave(preferences.paper === 'CUSTOM' ? { paperWidth: Number(width), paperHeight: Number(height), margin: Number(margin) } : { margin: Number(margin) })
  }}>
    {preferences.paper === 'CUSTOM' && <>
      <Measure label="Ancho de la hoja (mm)" value={width} min={15} max={650} disabled={disabled} onChange={setWidth} />
      <Measure label="Alto de la hoja (mm)" value={height} min={10} max={650} disabled={disabled} onChange={setHeight} />
    </>}
    <Measure label="Margen de la hoja (mm)" value={margin} min={0} max={30} disabled={disabled} onChange={setMargin} />
    <div className="flex items-end"><button disabled={disabled} className="rounded-lg bg-[#002855] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Aplicar medidas</button></div>
  </form>
}
export function PackageLabelPaperSettings() {
  const { format, options, selection, select, preferences, configure, error } = usePersonalLabelFormat('PAQUETE')
  let fitError = ''
  if (format.ready) { try { labelPrintPage(format) } catch (e) { fitError = e instanceof Error ? e.message : 'La etiqueta no cabe en la hoja.' } }
  const disabled = !format.ready
  return <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="font-bold text-[#002855]">Mi configuración de impresión</h2>
    <PaperFormatSelect label="Formato de la etiqueta de bulto" value={selection} disabled={disabled} onChange={value => void select(value)} options={[
      { value: '', label: 'Usar configuración del almacén' },
      ...options.map(f => ({ value: f.id, label: `${f.name} · ${f.width_mm} × ${f.height_mm} mm` })),
    ]} />
    <div className="grid gap-3 md:grid-cols-2">
      <PaperFormatSelect label="Orientación de la etiqueta" value={preferences.orientation} disabled={disabled} onChange={value => void configure({ orientation: value as LabelOrientation })} options={[
        { value: 'FORMAT', label: 'Original del formato' }, { value: 'LANDSCAPE', label: 'Horizontal' }, { value: 'PORTRAIT', label: 'Vertical' },
      ]} />
      <PaperFormatSelect label="Papel cargado en la impresora" value={preferences.paper} disabled={disabled} onChange={value => void configure({ paper: value as PrinterPaper })} options={PRINTER_PAPERS} />
    </div>
    {preferences.paper !== 'LABEL' && <PaperFormatSelect label="Posición de la etiqueta en la hoja" value={preferences.position} disabled={disabled} onChange={value => void configure({ position: value as LabelPosition })} options={[
      { value: 'CENTER', label: 'Centrada en la hoja (horizontal y vertical)' }, { value: 'TOP_LEFT', label: 'Esquina superior izquierda' },
    ]} />}
    {preferences.paper !== 'LABEL' && <SheetMeasures key={`${preferences.paper}:${preferences.paperWidth}:${preferences.paperHeight}:${preferences.margin}`} preferences={preferences} disabled={disabled} onSave={patch => void configure(patch)} />}
    <p className="text-xs text-slate-600">Etiqueta y hoja son independientes. La hoja A4 no agranda ni reduce la etiqueta. Se imprime una etiqueta por hoja, centrada por defecto, respetando el margen mínimo y sus medidas reales. Puedes cambiar la posición.</p>
    <p className="text-xs text-slate-600">Se guarda solo para tu cuenta en este navegador y se aplica a vista previa, impresión y reimpresión. Imprime a tamaño real / 100 %, sin ajustar a página, sin márgenes adicionales ni encabezados.</p>
    {format.ready && <div role="status" className="text-xs text-slate-600">
      <p>Etiqueta actual: {format.name} · {format.width_mm} × {format.height_mm} mm.</p>
      <p>Hoja de impresión: {format.paper ? `${format.paper.width_mm} × ${format.paper.height_mm} mm · margen ${format.paper.margin_mm} mm · Impresora / PDF` : `del tamaño de la etiqueta · ${format.output === 'BROWSER' ? 'Impresora / PDF' : `${format.dpi} dpi para Zebra`}`}.</p>
    </div>}
    {(error || fitError) && <p role="alert" className="text-sm text-red-700">{error || fitError}</p>}
  </section>
}
