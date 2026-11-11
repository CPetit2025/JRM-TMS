import type { jsPDF as JsPdf } from 'jspdf'
import { code128Bars } from '@/components/warehouse/Code128Barcode'

export type LpnPackage = { package_code: string; product_code: string; description: string; lot: string | null; document?: string; contract_code?: string | null; quantity: number; unit: string | null; weight_kg: number | null }
export type LpnAudit = { id: number; result: string; audit_rev: number; package_code: string | null; comment: string | null; evidence_paths: string[]; override_reason: string | null; actor_name: string | null; created_at: string }
export type TaskLpn = { id: string; lpn_code: string; status: string; package_count: number; quantity: number; weight_kg: number; print_count: number; audit_status: string; audit_rev: number; audited_by_name: string | null; audited_at: string | null; created_at: string; created_by_name: string | null; packages: LpnPackage[]; audits: LpnAudit[] }
export type PackingSnapshot = { packing_list_number: string | null; version: number | null; task_code: string; request_number: string | null; contract_code: string | null; client_name: string | null; delivery_address: string | null; lots: string | null; prepared_at: string | null; picker_name: string | null; auditor_name: string | null; released_at: string | null; lpn_count: number; package_count: number; total_weight_kg: number; lpns: TaskLpn[] }
export type PackingListVersion = { id: string; packing_list_number: string; version: number; status: string; released_at: string; released_by_name: string | null; replaced_reason: string | null; snapshot: PackingSnapshot }
export type TaskLpns = { lpns: TaskLpn[]; loose: LpnPackage[]; packing_lists: PackingListVersion[] }
export type BoardRow = { id: string; task_code: string; status: string; request_status: string; request_number: string | null; transport_request_id: string; required_date: string | null; required_at: string | null; created_at: string; contract_code: string | null; components: string | null; lots: string | null; client_name: string | null; delivery_address: string | null; assigned_picker: string | null; picker_name: string | null; assigned_at: string | null; last_activity_at?: string | null; picked: number; loose: number; lpn_total: number; lpn_approved: number; lpn_observed: number; lpn_rejected: number; lpn_pending: number; weight_kg: number; packing_list: { id: string; number: string; version: number; released_at: string } | null; display_state: string }

/** Unidad de carga de la tarea: UT1, UT2… con placa opcional y los bultos (LPN) asignados. */
export type LoadUnit = { id: string; seq: number; label: string; plate: string | null; lpn_ids: string[]; lpn_count: number; loaded_count: number; package_count: number; weight_kg: number }
export const unitLabel = (u: Pick<LoadUnit, 'label' | 'plate'>) => u.plate ? `${u.label} · ${u.plate}` : u.label

export const STATE: Record<string, { label: string; style: string }> = {
  PENDIENTE: { label: 'Pendiente', style: 'bg-slate-100 text-slate-700' },
  EN_PICKING: { label: 'En picking', style: 'bg-blue-100 text-blue-900' },
  EN_AUDITORIA: { label: 'En auditoría', style: 'bg-violet-100 text-violet-900' },
  OBSERVADO: { label: 'Observado', style: 'bg-amber-100 text-amber-900' },
  LIBERADO: { label: 'Liberado', style: 'bg-emerald-100 text-emerald-900' },
  PAUSED: { label: 'Pausada', style: 'bg-amber-50 text-amber-800' },
  PARTIAL: { label: 'Carga parcial', style: 'bg-slate-100 text-slate-700' },
  LOADED: { label: 'Cargada', style: 'bg-slate-100 text-slate-600' },
  RECONCILED: { label: 'Conciliada', style: 'bg-slate-100 text-slate-600' },
  CANCELLED: { label: 'Cancelada', style: 'bg-rose-100 text-rose-800' },
}
export const AUDIT: Record<string, { label: string; style: string }> = {
  PENDIENTE: { label: 'Por auditar', style: 'bg-slate-100 text-slate-700' },
  APROBADO: { label: 'Aprobado', style: 'bg-emerald-100 text-emerald-900' },
  OBSERVADO: { label: 'Observado', style: 'bg-amber-100 text-amber-900' },
  RECHAZADO: { label: 'Rechazado', style: 'bg-rose-100 text-rose-800' },
}
export const fmt = (n: number | null | undefined, d = 2) => Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: d })
export const fmtDate = (v: string | null | undefined) => v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'

async function logoDataUrl() {
  const response = await fetch('/logo-jrm.png')
  if (!response.ok) return null
  const blob = await response.blob()
  return new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob) })
}

function barcode(pdf: JsPdf, value: string, x: number, y: number, w: number, h: number) {
  const { bars, width } = code128Bars(value)
  const k = w / (width + 10)
  for (const b of bars) pdf.rect(x + b.x * k, y, b.w * k, h, 'F')
}

// Packing List (A4). Sin número de liberación = preliminar, marcado como tal y sin validez.
// unitOf: unidad asignada a cada LPN (por id); title: reemplaza el título, p. ej. para la guía de carga de una unidad.
export async function buildPackingListPdf(s: PackingSnapshot, opts: { unitOf?: Record<string, string>; title?: string } = {}) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const preliminary = !s.packing_list_number
  const logo = await logoDataUrl().catch(() => null)
  const title = opts.title || (preliminary ? 'PACKING LIST PRELIMINAR' : `PACKING LIST ${s.packing_list_number} · v${s.version}`)
  pdf.setProperties({ title, creator: 'JRM WMS' })
  const header = () => {
    if (logo) pdf.addImage(logo, 'PNG', 12, 9, 34, 14)
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text(title, 198, 15, { align: 'right' })
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5)
    pdf.text(`Tarea ${s.task_code} · Solicitud ${s.request_number || '—'}`, 198, 21, { align: 'right' })
    if (preliminary) {
      pdf.setTextColor(200, 30, 30); pdf.setFontSize(40); pdf.setFont('helvetica', 'bold')
      pdf.text('PRELIMINAR - SIN VALIDEZ', 105, 160, { align: 'center', angle: 30 })
      pdf.setTextColor(0, 0, 0); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5)
    }
    pdf.line(12, 26, 198, 26)
  }
  header()
  const info: Array<[string, string]> = [
    ['Cliente', s.client_name || '—'], ['OT / lote', [s.contract_code, s.lots].filter(Boolean).join(' · ') || '—'],
    ['Solicitud de origen', s.request_number || '—'], ['Entrega', s.delivery_address || '—'],
    ['Fecha de preparación', fmtDate(s.prepared_at)], ['Responsable de picking', s.picker_name || '—'],
    ['Auditor responsable', s.auditor_name || (preliminary ? 'Pendiente de aprobación' : '—')], ['Fecha de aprobación', preliminary ? 'Pendiente' : fmtDate(s.released_at)],
  ]
  let y = 32
  info.forEach(([k, v], i) => {
    const x = i % 2 ? 108 : 12
    pdf.setFont('helvetica', 'bold'); pdf.text(k, x, y); pdf.setFont('helvetica', 'normal')
    pdf.text(pdf.splitTextToSize(v, 60)[0], x + 36, y)
    if (i % 2) y += 5.5
  })
  y += 3
  for (const l of s.lpns) {
    const rows = l.packages.length
    if (y + 22 + rows * 5 > 280) { pdf.addPage(); header(); y = 32 }
    pdf.setFillColor(238, 242, 248); pdf.rect(12, y, 186, 16, 'F'); pdf.setFillColor(0, 0, 0)
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.text(l.lpn_code, 14, y + 6)
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8)
    pdf.text(`${l.package_count} paquete(s) · ${fmt(l.quantity, 3)} und · ${fmt(l.weight_kg)} kg · ${preliminary ? (AUDIT[l.audit_status]?.label || l.audit_status) : 'Aprobado'}${opts.unitOf ? ` · Unidad: ${opts.unitOf[l.id] || 'sin asignar'}` : ''}`, 14, y + 12)
    barcode(pdf, l.lpn_code, 128, y + 2, 68, 12)
    y += 20
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5)
    pdf.text('Paquete', 14, y); pdf.text('Material', 52, y); pdf.text('Lote', 132, y); pdf.text('Cantidad', 160, y); pdf.text('Peso kg', 196, y, { align: 'right' })
    pdf.setFont('helvetica', 'normal'); y += 4.5
    for (const p of l.packages) {
      if (y > 282) { pdf.addPage(); header(); y = 32 }
      pdf.text(p.package_code.slice(0, 22), 14, y)
      pdf.text(`${p.product_code} ${p.description}`.slice(0, 50), 52, y)
      pdf.text((p.lot || '—').slice(0, 16), 132, y)
      pdf.text(`${fmt(p.quantity, 3)} ${p.unit || ''}`, 160, y)
      pdf.text(p.weight_kg == null ? '—' : fmt(p.weight_kg), 196, y, { align: 'right' })
      y += 4.5
    }
    y += 3
  }
  if (y > 270) { pdf.addPage(); header(); y = 32 }
  pdf.line(12, y, 198, y)
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5)
  pdf.text(`Total: ${s.lpn_count} bulto(s) físico(s) (LPN) · ${s.package_count} paquetes · ${fmt(s.total_weight_kg)} kg`, 12, y + 6)
  // Reparto por unidad de carga: bultos, paquetes y kg de cada una.
  if (opts.unitOf) {
    const by = new Map<string, { n: number; p: number; kg: number }>()
    for (const l of s.lpns) { const k = opts.unitOf[l.id] || 'Sin unidad asignada', v = by.get(k) || { n: 0, p: 0, kg: 0 }; by.set(k, { n: v.n + 1, p: v.p + l.package_count, kg: v.kg + Number(l.weight_kg) }) }
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); y += 12
    for (const [k, v] of [...by].sort()) { if (y > 285) { pdf.addPage(); header(); y = 32 } pdf.text(`${k}: ${v.n} bulto(s) · ${v.p} paquetes · ${fmt(v.kg)} kg`, 12, y); y += 5 }
  }
  return pdf
}

/** Líneas (producto + lote) que muestra la etiqueta del bulto agrupado; con más de LABEL_LINES va hoja de contenido. */
export const LABEL_LINES = 4
export const itemLines = (packages: Pick<LpnPackage, 'product_code' | 'lot'>[]) => new Set(packages.map(p => `${p.product_code}|${p.lot || ''}`)).size
export const needsContentSheet = (packages: Pick<LpnPackage, 'product_code' | 'lot'>[]) => itemLines(packages) > LABEL_LINES
/** A5 alcanza para una hoja de hasta A5_ROWS paquetes; con más se usa A4 (continúa en varias hojas si hace falta). */
export const A5_ROWS = 18
export const contentSheetFormat = (rows: number) => (rows <= A5_ROWS ? 'a5' : 'a4') as 'a5' | 'a4'

// Hoja de contenido del bulto agrupado: lista completa de paquetes, pegada al bulto junto con su etiqueta térmica.
// reception: LPN de recepción, una fila por línea del IPT (IPT, código y descripción, lote, cantidad, peso).
export async function buildBultoContentPdf(l: Pick<TaskLpn, 'lpn_code' | 'package_count' | 'quantity' | 'weight_kg' | 'packages'>, t: { client_name: string | null; contract_code: string | null; request_number: string | null }, opts: { reception?: boolean } = {}) {
  const { jsPDF } = await import('jspdf')
  const format = contentSheetFormat(l.packages.length)
  const pdf = new jsPDF({ unit: 'mm', format, compress: true })
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight(), m = 10, right = W - m
  const logo = await logoDataUrl().catch(() => null)
  const bulto = /-(B-\d{4,})$/.exec(l.lpn_code)?.[1] || l.lpn_code
  pdf.setProperties({ title: `Contenido del bulto ${l.lpn_code}`, creator: 'JRM WMS' })
  // Columnas proporcionales al ancho: paquete, SKU y descripción, lote; cantidad y peso alineados a la derecha.
  const w = W - 2 * m, size = format === 'a5' ? 6.8 : 7.5
  const col = { pkg: m + 1, mat: m + w * 0.24, lot: m + w * 0.66, qty: m + w * 0.86, kg: right - 1 }
  const header = () => {
    if (logo) pdf.addImage(logo, 'PNG', m, 8, 30, 12)
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.text(`CONTENIDO DEL ${opts.reception ? 'LPN' : 'BULTO'} ${bulto}`, right, 13, { align: 'right' })
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8)
    pdf.text(`Cliente ${t.client_name || '—'} · OT ${t.contract_code || '—'} · ${opts.reception ? 'IPT ' + ([...new Set(l.packages.map(p => p.document).filter(Boolean))].join(', ') || '—') : 'Solicitud ' + (t.request_number || '—')}`, right, 18, { align: 'right' })
    barcode(pdf, l.lpn_code, m, 23, Math.min(70, W - 2 * m), 11)
    pdf.setFont('courier', 'bold'); pdf.setFontSize(10); pdf.text(l.lpn_code, right, 31, { align: 'right' })
    pdf.setLineWidth(0.6); pdf.line(m, 37, right, 37); pdf.setLineWidth(0.2)
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(size)
    pdf.text(opts.reception ? 'IPT' : 'Paquete', col.pkg, 42); pdf.text('Material', col.mat, 42); pdf.text('Lote', col.lot, 42); pdf.text('Cantidad', col.qty, 42, { align: 'right' }); pdf.text('Peso kg', col.kg, 42, { align: 'right' })
    pdf.setFont('helvetica', 'normal')
    return 46.5
  }
  let y = header()
  for (const p of l.packages) {
    // Material en hasta 2 líneas para no perder la descripción.
    const lines = (pdf.splitTextToSize(`${p.product_code} ${p.description}`, col.lot - col.mat - 2) as string[]).slice(0, 2), rowH = 4.6 + (lines.length - 1) * 3.2
    if (y + rowH > H - 16) { pdf.addPage(format); y = header() }
    pdf.text((opts.reception ? p.document || '—' : p.package_code).slice(0, 22), col.pkg, y)
    pdf.text(lines, col.mat, y)
    pdf.text((p.lot || '—').slice(0, 16), col.lot, y)
    pdf.text(`${fmt(p.quantity, 3)} ${p.unit || ''}`, col.qty, y, { align: 'right' })
    pdf.text(p.weight_kg == null ? '—' : fmt(p.weight_kg), col.kg, y, { align: 'right' })
    pdf.setDrawColor(210); pdf.line(m, y + rowH - 3, right, y + rowH - 3); pdf.setDrawColor(0)
    y += rowH
  }
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9)
  pdf.text(`Total: ${l.package_count} paquete(s) · ${itemLines(l.packages)} ítem(s) · ${fmt(l.quantity, 3)} und · ${fmt(l.weight_kg)} kg`, m, Math.min(y + 4, H - 12))
  const pages = pdf.getNumberOfPages()
  for (let i = 1; i <= pages; i++) { pdf.setPage(i); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.text(`Hoja ${i} de ${pages}`, right, H - 6, { align: 'right' }) }
  return { pdf, format }
}
