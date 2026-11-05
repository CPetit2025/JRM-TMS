import type { jsPDF } from 'jspdf'
import type { SupabaseClient } from '@supabase/supabase-js'

// Formas que devuelven audit_finding_list y audit_finding_detail (contrato de hallazgos, F1); los *_name son opcionales
export type AuditFindingListRow = {
  id: string; number: string; registered_at: string; contract_id: string; ot_code: string | null; client_name: string | null
  severity: string; status: string; categories: string[] | null; responsible_name?: string | null; auditor_name?: string | null; due_date?: string | null
}
export type AuditFindingEvidence = { id: string; finding_id?: string; correction_id: string | null; phase: 'ANTES' | 'DESPUES'; file_path: string; description: string | null; mime_type?: string | null; uploaded_at?: string; voided_at: string | null }
export type AuditFindingCorrection = {
  id: string; round: number; action_executed: string | null; executed_at: string | null; observations: string | null; submitted_at: string | null
  validated_at: string | null; result: 'CONFORME' | 'RECHAZADO' | null; validation_comment: string | null; no_photo_reason: string | null
  corrected_by_name?: string | null; validated_by_name?: string | null
}
export type AuditFindingDetail = {
  finding: Record<string, unknown> & { id: string; number: string; registered_at: string; severity: string; status: string; description: string | null
    material_code?: string | null; material_description?: string | null; quantity?: number | string | null; unit?: string | null; location?: string | null
    responsible_area?: string | null; due_date?: string | null; attended_at?: string | null; closed_at?: string | null; required_action?: string | null
    responsible_name?: string | null; auditor_name?: string | null; process_area?: string | null; destination?: string | null }
  categories: ({ name: string } | string)[]; evidence: AuditFindingEvidence[]; corrections: AuditFindingCorrection[]
}

export type ReportPhoto = { path: string; description: string }
export type ReportRound = {
  round: number; action: string; executedAt: string | null; correctedBy: string; submittedAt: string | null
  validatedBy: string; validatedAt: string | null; result: string; comment: string; noPhotoReason: string; photos: ReportPhoto[]
}
export type ReportFinding = {
  number: string; registeredAt: string; severity: string; status: string; categories: string[]; description: string; material: string
  location: string; requiredAction: string; auditor: string; responsible: string; responsibleArea: string
  dueDate: string | null; attendedAt: string | null; closedAt: string | null; result: string; before: ReportPhoto[]; after: ReportPhoto[]; rounds: ReportRound[]
}
export type AuditFindingsReport = { otCode: string; clientName: string; issuedAt: string; findings: ReportFinding[] }

export const SEVERITY_LABEL: Record<string, string> = { MENOR: 'Menor', MAYOR: 'Mayor', CRITICO: 'Crítico' }
export const STATUS_LABEL: Record<string, string> = { ABIERTO: 'Abierto', EN_CORRECCION: 'En corrección', PENDIENTE_VALIDACION: 'Pendiente de validación', CERRADO: 'Cerrado' }
const RESULT_LABEL: Record<string, string> = { CONFORME: 'Conforme', RECHAZADO: 'Rechazado' }

const photo = (e: AuditFindingEvidence): ReportPhoto => ({ path: e.file_path, description: e.description || '' })

/** Modelo del reporte (función pura): una sección por hallazgo, con fotos vigentes y rondas en orden. */
export function buildAuditFindingsReport(rows: AuditFindingListRow[], details: AuditFindingDetail[], issuedAt: string): AuditFindingsReport {
  const byId = new Map(details.map(d => [d.finding.id, d]))
  const findings = [...rows].sort((a, b) => a.registered_at.localeCompare(b.registered_at) || a.number.localeCompare(b.number)).map(row => {
    const d = byId.get(row.id), f = d?.finding, live = (d?.evidence || []).filter(e => !e.voided_at)
    const rounds = [...(d?.corrections || [])].sort((a, b) => a.round - b.round).map(c => ({
      round: c.round, action: c.action_executed || '', executedAt: c.executed_at, correctedBy: c.corrected_by_name || '', submittedAt: c.submitted_at,
      validatedBy: c.validated_by_name || '', validatedAt: c.validated_at, result: c.result ? RESULT_LABEL[c.result] : 'Pendiente',
      comment: c.validation_comment || '', noPhotoReason: c.no_photo_reason || '', photos: live.filter(e => e.phase === 'DESPUES' && e.correction_id === c.id).map(photo),
    }))
    const status = f?.status || row.status
    const material = [f?.material_code, f?.material_description, f?.quantity != null && f.quantity !== '' ? `${f.quantity} ${f.unit || ''}`.trim() : ''].filter(Boolean).join(' · ')
    return {
      number: row.number, registeredAt: f?.registered_at || row.registered_at, severity: SEVERITY_LABEL[f?.severity || row.severity] || row.severity,
      status: STATUS_LABEL[status] || status,
      categories: row.categories?.length ? row.categories : (d?.categories || []).map(c => typeof c === 'string' ? c : c.name),
      description: f?.description || '', material, location: f?.location || '', requiredAction: f?.required_action || '',
      auditor: f?.auditor_name || row.auditor_name || '', responsible: f?.responsible_name || row.responsible_name || '', responsibleArea: f?.responsible_area || '',
      dueDate: f?.due_date || row.due_date || null, attendedAt: f?.attended_at || null, closedAt: f?.closed_at || null,
      result: status === 'CERRADO' ? 'Cerrado conforme' : rounds.at(-1)?.result === 'Rechazado' ? 'Rechazado, en nueva corrección' : STATUS_LABEL[status] || status,
      before: live.filter(e => e.phase === 'ANTES').map(photo), after: live.filter(e => e.phase === 'DESPUES').map(photo), rounds,
    }
  })
  return { otCode: rows[0]?.ot_code || '', clientName: rows[0]?.client_name || '', issuedAt, findings }
}

const fmt = (v: string | null) => {
  if (!v) return '—'
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00` : v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', ...(v.length > 10 ? { hour: '2-digit', minute: '2-digit' } : {}) })
}

/** Reduce la foto a ≤ 640 px y JPEG 0.6 para que el PDF quede liviano. */
async function thumbnail(url: string): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const blob = await (await fetch(url)).blob(), bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close()
    return { data: canvas.toDataURL('image/jpeg', 0.6), w: canvas.width, h: canvas.height }
  } catch { return null }
}

function render(doc: jsPDF, report: AuditFindingsReport, images: Map<string, { data: string; w: number; h: number } | null>) {
  const L = 14, W = 182, BOTTOM = 284
  let y = 14
  const need = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = 14 } }
  const text = (s: string, size = 9, bold = false, indent = 0) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size)
    for (const line of doc.splitTextToSize(s, W - indent) as string[]) { need(size * 0.45); doc.text(line, L + indent, y + size * 0.35); y += size * 0.45 }
  }
  const field = (label: string, value: string, indent = 0) => { if (value) text(`${label}: ${value}`, 9, false, indent) }
  const photos = (title: string, list: ReportPhoto[], indent = 0) => {
    if (!list.length) return
    text(title, 9, true, indent); y += 1
    const cw = (W - indent - 6) / 2, ch = 55
    for (let i = 0; i < list.length; i += 2) {
      need(ch + 6)
      list.slice(i, i + 2).forEach((p, k) => {
        const x = L + indent + k * (cw + 6), img = images.get(p.path)
        doc.setDrawColor(200); doc.rect(x, y, cw, ch)
        if (img) { const s = Math.min(cw / img.w, ch / img.h), w = img.w * s, h = img.h * s; doc.addImage(img.data, 'JPEG', x + (cw - w) / 2, y + (ch - h) / 2, w, h) }
        else { doc.setFontSize(8); doc.text('Foto no disponible', x + cw / 2, y + ch / 2, { align: 'center' }) }
        if (p.description) { doc.setFontSize(7.5); doc.text((doc.splitTextToSize(p.description, cw) as string[])[0], x, y + ch + 3.5) }
      })
      y += ch + 6
    }
  }

  doc.setTextColor(25, 45, 70)
  text('Reporte de hallazgos de auditoría de despacho', 14, true); y += 1
  text(`OT: ${report.otCode || '—'}    Cliente: ${report.clientName || '—'}    Emitido: ${fmt(report.issuedAt)}`, 10)
  text(`Hallazgos: ${report.findings.length}`, 9); y += 2
  report.findings.forEach((f, i) => {
    need(30); doc.setDrawColor(45, 64, 88); doc.line(L, y, L + W, y); y += 3
    text(`${i + 1}. ${f.number} · ${fmt(f.registeredAt)} · Criticidad ${f.severity} · ${f.status}`, 11, true)
    field('Categorías', f.categories.join(', ') || '—')
    field('Descripción', f.description); field('Material', f.material); field('Ubicación', f.location); field('Acción requerida', f.requiredAction)
    field('Auditor', f.auditor)
    field('Responsable', [f.responsible, f.responsibleArea].filter(Boolean).join(' · ') || 'Sin asignar')
    text(`Vence: ${fmt(f.dueDate)}    Atendido: ${fmt(f.attendedAt)}    Cerrado: ${fmt(f.closedAt)}`)
    field('Resultado', f.result)
    y += 1; photos('Fotos ANTES', f.before)
    f.rounds.forEach(r => {
      need(14); y += 1
      text(`Ronda ${r.round} de corrección — ${r.result}`, 10, true)
      field('Acción ejecutada', r.action, 4); field('Corrigió', [r.correctedBy, fmt(r.executedAt)].join(' · '), 4)
      field('Validó', r.validatedAt ? [r.validatedBy, fmt(r.validatedAt)].filter(Boolean).join(' · ') : 'Pendiente', 4)
      field('Comentario de validación', r.comment, 4); field('Sin foto', r.noPhotoReason, 4)
      photos('Fotos DESPUÉS', r.photos, 4)
    })
    y += 3
  })
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) { doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.text(`JRM TMS · OT ${report.otCode} · Página ${p} de ${pages}`, L + W, 292, { align: 'right' }) }
}

/** Descarga el PDF de los hallazgos de una OT: lista + detalle de cada hallazgo + miniaturas desde URLs firmadas. */
export async function downloadAuditFindingsPdf(db: SupabaseClient, contractId: string) {
  const { data: list, error } = await db.rpc('audit_finding_list', { p_filters: { contract_id: contractId } })
  if (error || list?.success === false) throw new Error(error?.message || list?.error || 'No se pudo leer los hallazgos de la OT')
  const rows = (Array.isArray(list) ? list : list?.rows || []) as AuditFindingListRow[]
  if (!rows.length) throw new Error('La OT no tiene hallazgos registrados')
  const details = await Promise.all(rows.map(async r => {
    const { data, error: e } = await db.rpc('audit_finding_detail', { p_id: r.id })
    if (e || data?.success === false) throw new Error(e?.message || data?.error || `No se pudo leer ${r.number}`)
    return data as AuditFindingDetail
  }))
  const report = buildAuditFindingsReport(rows, details, new Date().toISOString())
  const paths = [...new Set(report.findings.flatMap(f => [...f.before, ...f.rounds.flatMap(r => r.photos)].map(p => p.path)))]
  const images = new Map<string, { data: string; w: number; h: number } | null>()
  if (paths.length) {
    const { data: signed } = await db.storage.from('audit_findings').createSignedUrls(paths, 600)
    await Promise.all((signed || []).map(async s => { images.set(s.path || '', s.signedUrl ? await thumbnail(s.signedUrl) : null) }))
  }
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  doc.setProperties({ title: `Hallazgos OT ${report.otCode}`, creator: 'JRM TMS' })
  render(doc, report, images)
  doc.save(`hallazgos-OT-${(report.otCode || contractId).replace(/[^\w-]+/g, '_')}.pdf`)
}
