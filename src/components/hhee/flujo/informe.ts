import { fmtDate, fmtDateTime, fmtHours, fmtMoney, fmtTime, type Snapshot } from '@/lib/hhee/flujo'

// Informe de autorización de HHEE: se genera siempre desde la versión aprobada guardada (snapshot), así el PDF y el
// correo no cambian aunque después cambie la ficha del trabajador. No incluye conceptos remunerativos.

const REF: Record<string, string> = { SIN_REFERENCIA: 'Sin referencia', OT: 'OT', OC: 'OC', OS: 'OS', RQ: 'RQ', MANTENIMIENTO: 'Mantenimiento' }
export const folio = (s: Snapshot) => `HE-${String(s.request.sequence).padStart(5, '0')}`
const hoursOf = (m: number | null | undefined) => (m ? (m / 60).toLocaleString('es-PE', { maximumFractionDigits: 2 }) : '0')

async function logo(): Promise<string | null> {
  try {
    const blob = await (await fetch('/logo-jrm.png')).blob()
    return await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => resolve(null); r.readAsDataURL(blob) })
  } catch { return null }
}

export async function downloadPdf(s: Snapshot, withCost: boolean) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210, M = 14, navy: [number, number, number] = [0, 40, 85], red: [number, number, number] = [207, 21, 45]
  let y = 14
  const img = await logo()
  if (img) { try { doc.addImage(img, 'PNG', M, y - 2, 28, 11) } catch { /* sin logo */ } }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...navy)
  doc.text('AUTORIZACIÓN DE HORAS EXTRAS', W - M, y + 2, { align: 'right' })
  doc.setFontSize(10); doc.setTextColor(60)
  doc.text(`${folio(s)} · versión ${s.revision}`, W - M, y + 8, { align: 'right' })
  y += 14; doc.setDrawColor(...red); doc.setLineWidth(0.8); doc.line(M, y, W - M, y); y += 7

  const kv = (pairs: Array<[string, string]>) => {
    doc.setFontSize(9)
    pairs.forEach(([k, v], i) => {
      const x = i % 2 === 0 ? M : W / 2 + 2
      doc.setFont('helvetica', 'bold'); doc.setTextColor(100); doc.text(k.toUpperCase(), x, y)
      doc.setFont('helvetica', 'normal'); doc.setTextColor(20); doc.text(doc.splitTextToSize(v || '—', W / 2 - M - 4)[0], x, y + 4.5)
      if (i % 2 === 1 || i === pairs.length - 1) y += 11
    })
  }
  const block = (title: string, text: string) => {
    const lines = doc.splitTextToSize(text || '—', W - 2 * M)
    if (y + 8 + lines.length * 4.5 > 280) { doc.addPage(); y = 16 }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...navy); doc.text(title.toUpperCase(), M, y); y += 4.5
    doc.setFont('helvetica', 'normal'); doc.setTextColor(30); doc.text(lines, M, y); y += lines.length * 4.5 + 3
  }
  kv([['Fecha de trabajo', fmtDate(s.request.work_date)], ['Área', `${s.area}${s.site ? ` · ${s.site}` : ''}`],
    ['Causa', s.cause], ['Referencia', s.request.reference_type === 'SIN_REFERENCIA' ? 'Sin referencia' : `${REF[s.request.reference_type] ?? s.request.reference_type} ${s.request.reference_code ?? ''}`],
    ['Solicitado por', `${s.requester} · ${fmtDateTime(s.request.submitted_at ?? s.request.created_at)}`], ['Aprobado por', `${s.approver} · ${fmtDateTime(s.request.approved_at)}`]])
  block('Actividad', s.request.activity)
  block('¿Por qué se necesitan las horas extras?', s.request.justification)
  block('Alternativa evaluada', s.request.alternatives)
  block('Resultado esperado', s.request.expected_result)

  // Tabla de personal y horas autorizadas
  const cols: Array<[string, number, 'left' | 'right']> = [['Código', 18, 'left'], ['Trabajador / cargo', withCost ? 52 : 66, 'left'], ['Horario', 24, 'left'], ['Desc.', 11, 'right'],
    ['25 %', 12, 'right'], ['35 %', 12, 'right'], ['100 %', 12, 'right'], ['Total h', 15, 'right'], ...(withCost ? [['Costo aprox.', 26, 'right'] as [string, number, 'right']] : [])]
  const header = () => {
    doc.setFillColor(...navy); doc.rect(M, y - 4, W - 2 * M, 7, 'F'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(255)
    let x = M + 1.5; cols.forEach(([t, w, a]) => { doc.text(t, a === 'right' ? x + w - 3 : x, y, { align: a }); x += w }); y += 6
  }
  if (y > 240) { doc.addPage(); y = 16 }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...navy); doc.text('PERSONAL Y HORAS AUTORIZADAS', M, y); y += 6
  header()
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(20)
  s.lines.forEach((l, i) => {
    if (y > 275) { doc.addPage(); y = 16; header(); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(20) }
    if (i % 2) { doc.setFillColor(244, 246, 249); doc.rect(M, y - 4, W - 2 * M, 9, 'F') }
    const vals = [l.code, `${l.name}`, `${fmtTime(l.start)}–${fmtTime(l.end)}`, `${l.break_minutes || 0}m`, hoursOf(l.minutes_25), hoursOf(l.minutes_35), hoursOf(l.minutes_100), hoursOf(l.minutes),
      ...(withCost ? [l.cost == null ? 'Pendiente' : fmtMoney(l.cost)] : [])]
    let x = M + 1.5
    vals.forEach((v, j) => {
      const [, w, a] = cols[j]
      doc.text(doc.splitTextToSize(String(v), w - 2)[0], a === 'right' ? x + w - 3 : x, y, { align: a })
      if (j === 1 && l.position) { doc.setTextColor(110); doc.setFontSize(7); doc.text(doc.splitTextToSize(l.position, w - 2)[0], x, y + 3.5); doc.setTextColor(20); doc.setFontSize(8) }
      x += w
    })
    y += 9
  })
  doc.setDrawColor(200); doc.setLineWidth(0.2); doc.line(M, y - 3, W - M, y - 3)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9)
  const t = s.totals
  doc.text(`Total: ${t.workers} trabajador(es) · ${fmtHours(t.minutes)} (25 %: ${hoursOf(t.minutes_25)} h · 35 %: ${hoursOf(t.minutes_35)} h · 100 %: ${hoursOf(t.minutes_100)} h)`, M, y + 2)
  if (withCost) { doc.setTextColor(...navy); doc.text(`Costo aproximado: ${fmtMoney(t.cost ?? 0)}${t.pending_cost ? ` (+${t.pending_cost} con costo pendiente)` : ''}`, W - M, y + 8, { align: 'right' }); doc.setTextColor(20) }
  y += 16
  block('Sustento de la aprobación', s.request.approval_reason)
  if (y > 262) { doc.addPage(); y = 20 }
  y += 8; doc.setDrawColor(120); doc.line(M, y, M + 70, y); doc.line(W - M - 70, y, W - M, y)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80)
  doc.text(`Solicitante: ${s.requester}`, M, y + 4); doc.text(`Aprobador: ${s.approver}`, W - M - 70, y + 4)
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(7); doc.setTextColor(130)
    doc.text('Horas y costo aproximado AUTORIZADOS antes de la ejecución; no constituyen horas trabajadas ni liquidación de planilla. Documento generado por JRM TMS.', M, 291)
    doc.text(`${i}/${pages}`, W - M, 291, { align: 'right' })
  }
  doc.save(`autorizacion-hhee-${folio(s)}-v${s.revision}.pdf`)
}

export function emailDraft(s: Snapshot, withCost: boolean) {
  const t = s.totals
  const lines = s.lines.map(l => `• ${l.code} · ${l.name}${l.position ? ` (${l.position})` : ''}: ${fmtTime(l.start)}–${fmtTime(l.end)} · ${hoursOf(l.minutes)} h (25 %: ${hoursOf(l.minutes_25)} · 35 %: ${hoursOf(l.minutes_35)} · 100 %: ${hoursOf(l.minutes_100)})${withCost ? ` · ${l.cost == null ? 'costo pendiente' : fmtMoney(l.cost)}` : ''}`).join('\n')
  return {
    subject: `Autorización de horas extras ${folio(s)} v${s.revision} · ${s.area} · ${fmtDate(s.request.work_date)}`,
    body: `AUTORIZACIÓN DE HORAS EXTRAS ${folio(s)} (versión ${s.revision})\n\nFecha de trabajo: ${fmtDate(s.request.work_date)}\nÁrea: ${s.area}${s.site ? ` · ${s.site}` : ''}\nCausa: ${s.cause}\nActividad: ${s.request.activity}\n\n¿POR QUÉ SE NECESITAN?\n${s.request.justification}\n\nAlternativa evaluada: ${s.request.alternatives}\nResultado esperado: ${s.request.expected_result}\n\nPERSONAL Y HORAS AUTORIZADAS\n${lines}\n\nTotal: ${t.workers} trabajador(es) · ${fmtHours(t.minutes)}${withCost ? `\nCosto aproximado: ${fmtMoney(t.cost ?? 0)}` : ''}\n\nSolicitado por: ${s.requester}\nAprobado por: ${s.approver} el ${fmtDateTime(s.request.approved_at)}\nSustento: ${s.request.approval_reason}\n\nSe adjunta el PDF de la autorización. Horas y costo aproximado autorizados antes de la ejecución; no constituyen horas trabajadas ni liquidación de planilla.\n\nAtentamente,`,
  }
}
