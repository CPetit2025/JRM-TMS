import type { jsPDF as JsPdf } from 'jspdf'
import { code128Bars } from '@/components/warehouse/Code128Barcode'

export type LpnPackage = { package_code: string; product_code: string; description: string; lot: string | null; document?: string; contract_code?: string | null; quantity: number; unit: string | null; weight_kg: number | null }
export type LpnAudit = { id: number; result: string; audit_rev: number; package_code: string | null; comment: string | null; evidence_paths: string[]; override_reason: string | null; actor_name: string | null; created_at: string }
export type TaskLpn = { id: string; lpn_code: string; status: string; package_count: number; quantity: number; weight_kg: number; print_count: number; audit_status: string; audit_rev: number; audited_by_name: string | null; audited_at: string | null; created_at: string; created_by_name: string | null; packages: LpnPackage[]; audits: LpnAudit[] }
export type PackingSnapshot = { packing_list_number: string | null; version: number | null; task_code: string; request_number: string | null; contract_code: string | null; client_name: string | null; delivery_address: string | null; lots: string | null; prepared_at: string | null; picker_name: string | null; auditor_name: string | null; released_at: string | null; lpn_count: number; package_count: number; total_weight_kg: number; lpns: TaskLpn[] }
export type PackingListVersion = { id: string; packing_list_number: string; version: number; status: string; released_at: string; released_by_name: string | null; replaced_reason: string | null; snapshot: PackingSnapshot }
export type TaskLpns = { lpns: TaskLpn[]; loose: LpnPackage[]; packing_lists: PackingListVersion[] }
export type BoardRow = { id: string; task_code: string; status: string; request_status: string; request_number: string | null; transport_request_id: string; required_date: string | null; required_at: string | null; created_at: string; contract_code: string | null; components: string | null; lots: string | null; client_name: string | null; delivery_address: string | null; assigned_picker: string | null; picker_name: string | null; assigned_at: string | null; picked: number; loose: number; lpn_total: number; lpn_approved: number; lpn_observed: number; lpn_rejected: number; lpn_pending: number; weight_kg: number; packing_list: { id: string; number: string; version: number; released_at: string } | null; display_state: string }

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
export async function buildPackingListPdf(s: PackingSnapshot) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const preliminary = !s.packing_list_number
  const logo = await logoDataUrl().catch(() => null)
  const title = preliminary ? 'PACKING LIST PRELIMINAR' : `PACKING LIST ${s.packing_list_number} · v${s.version}`
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
    pdf.text(`${l.package_count} paquete(s) · ${fmt(l.quantity, 3)} und · ${fmt(l.weight_kg)} kg · ${preliminary ? (AUDIT[l.audit_status]?.label || l.audit_status) : 'Aprobado'}`, 14, y + 12)
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
  return pdf
}
