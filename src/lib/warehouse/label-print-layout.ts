export type LabelOrientation = 'FORMAT' | 'LANDSCAPE' | 'PORTRAIT'
export type LabelPosition = 'CENTER' | 'TOP_LEFT'
export type PrinterPaper = 'LABEL' | 'A4_PORTRAIT' | 'A4_LANDSCAPE' | 'A5_PORTRAIT' | 'A5_LANDSCAPE' | 'A5_PORTRAIT_ROTATED' | 'CUSTOM'
export type PrintPreferences = {
  formatId: string
  orientation: LabelOrientation
  paper: PrinterPaper
  paperWidth: number
  paperHeight: number
  margin: number
  position: LabelPosition
}
export type SheetSize = { width_mm: number; height_mm: number; margin_mm: number; position?: LabelPosition; rotate?: boolean }
// Por defecto: etiqueta A5 vertical (148 × 210 mm). La hoja A5 entra a la impresora así y la etiqueta sale completa.
// Por defecto: etiqueta A5 acostada (210 × 148 mm) en una página del mismo tamaño, sin girar: la hoja A5 entra a la
// impresora con su lado de 210 mm adelante (igual que el A4), así que la etiqueta se lee de lado a lado y ocupa toda la hoja.
export const DEFAULT_PRINT_PREFERENCES: PrintPreferences = { formatId: 'paper-a5-landscape', orientation: 'FORMAT', paper: 'LABEL', paperWidth: 210, paperHeight: 297, margin: 0, position: 'CENTER' }
export const PRINTER_PAPERS: { value: PrinterPaper; label: string; width?: number; height?: number }[] = [
  { value: 'LABEL', label: 'Rollo / papel del tamaño de la etiqueta' },
  { value: 'A4_PORTRAIT', label: 'Hoja A4 vertical · 210 × 297 mm', width: 210, height: 297 },
  { value: 'A4_LANDSCAPE', label: 'Hoja A4 horizontal · 297 × 210 mm', width: 297, height: 210 },
  { value: 'A5_PORTRAIT', label: 'Hoja A5 vertical · 148 × 210 mm', width: 148, height: 210 },
  { value: 'A5_LANDSCAPE', label: 'Hoja A5 horizontal · 210 × 148 mm', width: 210, height: 148 },
  { value: 'A5_PORTRAIT_ROTATED', label: 'Hoja A5 que entra vertical · etiqueta acostada (girada 90°)', width: 148, height: 210 },
  { value: 'CUSTOM', label: 'Hoja con medidas personalizadas' },
]

/** Tolera cachés antiguos/dañados sin aceptar números o enumeraciones arbitrarias. */
export function readPrintPreferences(raw: string | null, legacyId = ''): PrintPreferences {
  let value: Partial<PrintPreferences> = {}
  try { value = raw ? JSON.parse(raw) || {} : {} } catch { /* usar valores seguros */ }
  const bounded = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback
  return {
    // Sin nada guardado: A5 vertical. Un formatId vacío guardado significa «formato del almacén» y se respeta.
    formatId: typeof value.formatId === 'string' ? value.formatId : legacyId || (raw ? '' : DEFAULT_PRINT_PREFERENCES.formatId),
    orientation: ['FORMAT', 'LANDSCAPE', 'PORTRAIT'].includes(value.orientation || '') ? value.orientation! : 'FORMAT',
    paper: PRINTER_PAPERS.some(p => p.value === value.paper) ? value.paper! : raw ? 'LABEL' : DEFAULT_PRINT_PREFERENCES.paper,
    paperWidth: bounded(value.paperWidth, 210, 15, 650),
    paperHeight: bounded(value.paperHeight, 297, 10, 650),
    margin: bounded(value.margin, raw ? 5 : DEFAULT_PRINT_PREFERENCES.margin, 0, 30),
    position: value.position === 'TOP_LEFT' ? 'TOP_LEFT' : 'CENTER',
  }
}
export function orientLabel<T extends { width_mm: number; height_mm: number }>(format: T, orientation: LabelOrientation): T {
  if (orientation === 'FORMAT') return { ...format }
  const short = Math.min(format.width_mm, format.height_mm), long = Math.max(format.width_mm, format.height_mm)
  return { ...format, width_mm: orientation === 'LANDSCAPE' ? long : short, height_mm: orientation === 'LANDSCAPE' ? short : long }
}
export function printerSheet(prefs: PrintPreferences): SheetSize | undefined {
  if (prefs.paper === 'LABEL') return undefined
  const preset = PRINTER_PAPERS.find(p => p.value === prefs.paper)
  return { width_mm: preset?.width ?? prefs.paperWidth, height_mm: preset?.height ?? prefs.paperHeight, margin_mm: prefs.margin, position: prefs.position, ...(prefs.paper === 'A5_PORTRAIT_ROTATED' && { rotate: true }) }
}

/** La hoja nunca escala ni recorta la etiqueta; solo la gira 90° si la hoja lo pide (rotate). Si no cabe, se rechaza. */
export function labelPrintPage(label: { width_mm: number; height_mm: number; paper?: SheetSize }) {
  const sheet = label.paper || { width_mm: label.width_mm, height_mm: label.height_mm, margin_mm: 0 }
  if (![label.width_mm, label.height_mm, sheet.width_mm, sheet.height_mm, sheet.margin_mm].every(Number.isFinite) || label.width_mm <= 0 || label.height_mm <= 0 || sheet.width_mm <= 0 || sheet.height_mm <= 0 || sheet.margin_mm < 0)
    throw new Error('Las medidas de etiqueta, hoja y margen no son válidas.')
  const [w, h] = 'rotate' in sheet && sheet.rotate ? [label.height_mm, label.width_mm] : [label.width_mm, label.height_mm]
  if (w + 2 * sheet.margin_mm > sheet.width_mm + 0.001 || h + 2 * sheet.margin_mm > sheet.height_mm + 0.001)
    throw new Error(`La etiqueta de ${label.width_mm} × ${label.height_mm} mm no cabe en la hoja de ${sheet.width_mm} × ${sheet.height_mm} mm con margen de ${sheet.margin_mm} mm. Cambia la hoja, su orientación o el margen. La etiqueta no se reducirá.`)
  return sheet
}
