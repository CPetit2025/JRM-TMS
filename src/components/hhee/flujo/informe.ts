import { LEGAL_BASIS, fmtDate, fmtDateTime, fmtHours, fmtMoney, fmtTime, plateLabel, type Line, type Snapshot } from '@/lib/hhee/flujo'
import type { jsPDF as JsPDF } from 'jspdf'

// Informes de autorización de HHEE: se generan siempre desde la versión aprobada guardada (snapshot), así el PDF y el
// correo no cambian aunque después cambie la ficha del trabajador. No incluyen conceptos remunerativos.
// • Informe individual: una solicitud (folio HE-00000, versión).
// • Informe consolidado: varias autorizaciones en un solo documento, con el detalle y el resumen por trabajador.

const REF: Record<string, string> = { SIN_REFERENCIA: 'Sin referencia', OT: 'OT', OC: 'OC', OS: 'OS', RQ: 'RQ', MANTENIMIENTO: 'Mantenimiento' }
export const folio = (s: Snapshot) => `HE-${String(s.request.sequence).padStart(5, '0')}`
const hoursOf = (m: number | null | undefined) => ((m ?? 0) / 60).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const NAVY: [number, number, number] = [0, 40, 85], RED: [number, number, number] = [207, 21, 45]
const dayType = (s: Snapshot) => (s.holiday ? `Feriado: ${s.holiday} (100 %)` : 'Día laborable')
const workerSub = (l: Line) => [l.document_number ? `DNI ${l.document_number}` : null, l.position, plateLabel(l) || null, l.rest_day ? 'Día de descanso (100 %)' : null, l.work_plan ? `HHEE por tramos: ${l.work_plan.parts.map(p=>`${fmtDate(p.date)} ${fmtTime(p.start)}–${fmtTime(p.end)}`).join(' / ')}; ordinarias excluidas ${hoursOf(l.work_plan.ordinary_minutes)} h` : null].filter(Boolean).join(' · ')

async function logo(): Promise<string | null> {
  try {
    const blob = await (await fetch('/logo-jrm.png')).blob()
    return await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => resolve(null); r.readAsDataURL(blob) })
  } catch { return null }
}

type Col = { t: string; w: number; a?: 'left' | 'right' }
type Row = { cells: string[]; sub?: string; bold?: boolean }

// Base común: cabecera con logo, bloques de texto, tablas con salto de página y pie con base legal
class Doc {
  y = 14
  constructor(public doc: JsPDF, public W: number, public H: number, public M: number) {}
  static async create(orientation: 'portrait' | 'landscape', title: string, subtitle: string) {
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation })
    const d = new Doc(doc, orientation === 'portrait' ? 210 : 297, orientation === 'portrait' ? 297 : 210, orientation === 'portrait' ? 14 : 12)
    const img = await logo()
    if (img) { try { doc.addImage(img, 'PNG', d.M, d.y - 2, 28, 11) } catch { /* sin logo */ } }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...NAVY)
    doc.text(title, d.W - d.M, d.y + 2, { align: 'right' })
    doc.setFontSize(10); doc.setTextColor(60); doc.text(subtitle, d.W - d.M, d.y + 8, { align: 'right' })
    d.y += 14; doc.setDrawColor(...RED); doc.setLineWidth(0.8); doc.line(d.M, d.y, d.W - d.M, d.y); d.y += 7
    return d
  }
  get width() { return this.W - 2 * this.M }
  space(h: number) { if (this.y + h > this.H - 14) { this.doc.addPage(); this.y = 16 } }
  kv(pairs: Array<[string, string]>, perRow = 2) {
    const doc = this.doc, colW = this.width / perRow
    doc.setFontSize(9)
    pairs.forEach(([k, v], i) => {
      const x = this.M + (i % perRow) * colW
      doc.setFont('helvetica', 'bold'); doc.setTextColor(100); doc.text(k.toUpperCase(), x, this.y)
      doc.setFont('helvetica', 'normal'); doc.setTextColor(20); doc.text(doc.splitTextToSize(v || '—', colW - 4)[0], x, this.y + 4.5)
      if (i % perRow === perRow - 1 || i === pairs.length - 1) this.y += 11
    })
  }
  block(title: string, text: string) {
    const doc = this.doc, lines = doc.splitTextToSize(text || '—', this.width)
    this.space(8 + lines.length * 4.5)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...NAVY); doc.text(title.toUpperCase(), this.M, this.y); this.y += 4.5
    doc.setFont('helvetica', 'normal'); doc.setTextColor(30); doc.text(lines, this.M, this.y); this.y += lines.length * 4.5 + 3
  }
  heading(t: string) { this.space(18); this.doc.setFont('helvetica', 'bold'); this.doc.setFontSize(9.5); this.doc.setTextColor(...NAVY); this.doc.text(t.toUpperCase(), this.M, this.y); this.y += 6 }
  // El ancho 0 toma el espacio que sobra
  table(cols: Col[], rows: Row[]) {
    const doc = this.doc, flex = this.width - cols.reduce((t, c) => t + c.w, 0)
    const cs = cols.map(c => ({ ...c, w: c.w || flex }))
    const header = () => {
      doc.setFillColor(...NAVY); doc.rect(this.M, this.y - 4, this.width, 7, 'F'); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(255)
      let x = this.M + 1.5; cs.forEach(c => { doc.text(c.t, c.a === 'right' ? x + c.w - 3 : x, this.y, { align: c.a ?? 'left' }); x += c.w }); this.y += 6
    }
    this.space(16); header()
    rows.forEach((r, i) => {
      const h = r.sub ? 8.5 : 6
      if (this.y + h > this.H - 14) { doc.addPage(); this.y = 16; header() }
      if (r.bold) { doc.setFillColor(230, 236, 245); doc.rect(this.M, this.y - 4, this.width, h, 'F') } else if (i % 2) { doc.setFillColor(244, 246, 249); doc.rect(this.M, this.y - 4, this.width, h, 'F') }
      doc.setFont('helvetica', r.bold ? 'bold' : 'normal'); doc.setFontSize(7.5); doc.setTextColor(20)
      let x = this.M + 1.5
      r.cells.forEach((v, j) => {
        const c = cs[j]
        doc.text(doc.splitTextToSize(String(v ?? ''), c.w - 2)[0] ?? '', c.a === 'right' ? x + c.w - 3 : x, this.y, { align: c.a ?? 'left' })
        if (j === 1 && r.sub) { doc.setTextColor(110); doc.setFontSize(6.5); doc.text(doc.splitTextToSize(r.sub, c.w - 2)[0], x, this.y + 3.3); doc.setTextColor(20); doc.setFontSize(7.5) }
        x += c.w
      })
      this.y += h
    })
    this.y += 3
  }
  signatures(left: string, right: string) {
    this.space(26); this.y += 12
    const doc = this.doc
    doc.setDrawColor(120); doc.setLineWidth(0.2); doc.line(this.M, this.y, this.M + 70, this.y); doc.line(this.W - this.M - 70, this.y, this.W - this.M, this.y)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80)
    doc.text(left, this.M, this.y + 4); doc.text(right, this.W - this.M - 70, this.y + 4)
  }
  save(name: string) {
    const doc = this.doc, pages = doc.getNumberOfPages()
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFontSize(6.5); doc.setTextColor(130)
      const legal: string[] = doc.splitTextToSize(`Cálculo: ${LEGAL_BASIS}`, this.width - 12)
      doc.text(legal, this.M, this.H - 5 - 2.8 * legal.length)
      doc.text('Horas y costo aproximado AUTORIZADOS antes de la ejecución; no constituyen horas trabajadas ni liquidación de planilla. Generado por JRM TMS.', this.M, this.H - 5)
      doc.text(`${i}/${pages}`, this.W - this.M, this.H - 5, { align: 'right' })
    }
    doc.save(name)
  }
}

export async function downloadPdf(s: Snapshot, withCost: boolean) {
  const d = await Doc.create('portrait', 'AUTORIZACIÓN DE HORAS EXTRAS', `${folio(s)} · versión ${s.revision}`)
  d.kv([['Fecha de trabajo', fmtDate(s.request.work_date)], ['Tipo de día', dayType(s)], ['Área', `${s.area}${s.site ? ` · ${s.site}` : ''}`], ['Causa', s.cause],
    ['Referencia', s.request.reference_type === 'SIN_REFERENCIA' ? 'Sin referencia' : `${REF[s.request.reference_type] ?? s.request.reference_type} ${s.request.reference_code ?? ''}`],
    ['Trabajadores · horas', `${s.totals.workers} · ${fmtHours(s.totals.minutes)}`],
    ['Solicitado por', `${s.requester} · ${fmtDateTime(s.request.submitted_at ?? s.request.created_at)}`], ['Aprobado por', `${s.approver} · ${fmtDateTime(s.request.approved_at)}`]])
  d.block('Actividad', s.request.activity)
  d.block('¿Por qué se necesitan las horas extras?', s.request.justification)
  d.block('Alternativa evaluada', s.request.alternatives)
  d.block('Resultado esperado', s.request.expected_result)

  d.heading('Datos del trabajador y horas autorizadas')
  const t = s.totals
  d.table([{ t: 'Código', w: 16 }, { t: 'Trabajador · DNI · cargo', w: 0 }, { t: 'Horario', w: 22 }, { t: 'Desc.', w: 11, a: 'right' },
    { t: 'H 25 %', w: 14, a: 'right' }, { t: 'H 35 %', w: 14, a: 'right' }, { t: 'H 100 %', w: 15, a: 'right' }, { t: 'Total h', w: 15, a: 'right' },
    ...(withCost ? [{ t: 'Costo aprox.', w: 22, a: 'right' as const }] : [])], [
    ...s.lines.map(l => ({ cells: [l.code, l.name, `${fmtTime(l.start)}–${fmtTime(l.end)}`, `${l.break_minutes || 0} min`, hoursOf(l.minutes_25), hoursOf(l.minutes_35), hoursOf(l.minutes_100), hoursOf(l.minutes),
      ...(withCost ? [l.cost == null ? 'Pendiente' : fmtMoney(l.cost)] : [])], sub: workerSub(l) })),
    { bold: true, cells: ['', `TOTAL · ${t.workers} trabajador(es)`, '', '', hoursOf(t.minutes_25), hoursOf(t.minutes_35), hoursOf(t.minutes_100), hoursOf(t.minutes),
      ...(withCost ? [t.cost == null ? '—' : fmtMoney(t.cost)] : [])] },
  ])
  if (withCost && t.pending_cost) d.block('Costo pendiente', `${t.pending_cost} trabajador(es) sin ficha remunerativa completa: su costo no está incluido.`)
  d.block('Sustento de la aprobación', s.request.approval_reason)
  d.signatures(`Solicitante: ${s.requester}`, `Aprobador: ${s.approver}`)
  d.save(`autorizacion-hhee-${folio(s)}-v${s.revision}.pdf`)
}

export function emailDraft(s: Snapshot, withCost: boolean) {
  const t = s.totals
  const lines = s.lines.map(l => `• ${l.code} · ${l.name}${l.document_number ? ` · DNI ${l.document_number}` : ''}${l.position ? ` (${l.position})` : ''}: ${fmtTime(l.start)}–${fmtTime(l.end)}${l.break_minutes ? ` − ${l.break_minutes} min` : ''} · ${hoursOf(l.minutes)} h (25 %: ${hoursOf(l.minutes_25)} · 35 %: ${hoursOf(l.minutes_35)} · 100 %: ${hoursOf(l.minutes_100)})${l.plate_source ? ` · ${plateLabel(l)}` : ''}${l.rest_day ? ' · día de descanso' : ''}${l.work_plan ? ` · ${workerSub(l)}` : ''}${withCost ? ` · ${l.cost == null ? 'costo pendiente' : fmtMoney(l.cost)}` : ''}`).join('\n')
  return {
    subject: `Autorización de horas extras ${folio(s)} v${s.revision} · ${s.area} · ${fmtDate(s.request.work_date)}`,
    body: `AUTORIZACIÓN DE HORAS EXTRAS ${folio(s)} (versión ${s.revision})\n\nFecha de trabajo: ${fmtDate(s.request.work_date)} · ${dayType(s)}\nÁrea: ${s.area}${s.site ? ` · ${s.site}` : ''}\nCausa: ${s.cause}\nActividad: ${s.request.activity}\n\n¿POR QUÉ SE NECESITAN?\n${s.request.justification}\n\nAlternativa evaluada: ${s.request.alternatives}\nResultado esperado: ${s.request.expected_result}\n\nPERSONAL Y HORAS AUTORIZADAS\n${lines}\n\nTotal: ${t.workers} trabajador(es) · ${fmtHours(t.minutes)} (25 %: ${hoursOf(t.minutes_25)} h · 35 %: ${hoursOf(t.minutes_35)} h · 100 %: ${hoursOf(t.minutes_100)} h)${withCost ? `\nCosto aproximado: ${fmtMoney(t.cost ?? 0)}` : ''}\n\nSolicitado por: ${s.requester}\nAprobado por: ${s.approver} el ${fmtDateTime(s.request.approved_at)}\nSustento: ${s.request.approval_reason}\n\nCálculo: ${LEGAL_BASIS}\nSe adjunta el PDF de la autorización. Horas y costo aproximado autorizados antes de la ejecución; no constituyen horas trabajadas ni liquidación de planilla.\n\nAtentamente,`,
  }
}

// ---------- Informe consolidado ----------
type Worker = { code: string; name: string; doc: string; position: string; days: Set<string>; folios: Set<string>; m25: number; m35: number; m100: number; m: number; cost: number; pending: number }
export function consolidate(snaps: Snapshot[]) {
  const sorted = [...snaps].sort((a, b) => a.request.work_date.localeCompare(b.request.work_date) || a.request.sequence - b.request.sequence)
  const workers = new Map<string, Worker>()
  const causes = new Map<string, { requests: number; m: number; cost: number }>()
  const tot = { m25: 0, m35: 0, m100: 0, m: 0, cost: 0, pending: 0 }
  for (const s of sorted) {
    const c = causes.get(s.cause) ?? { requests: 0, m: 0, cost: 0 }; c.requests++; causes.set(s.cause, c)
    for (const l of s.lines) {
      const w = workers.get(l.code) ?? { code: l.code, name: l.name, doc: l.document_number ?? '', position: l.position ?? '', days: new Set(), folios: new Set(), m25: 0, m35: 0, m100: 0, m: 0, cost: 0, pending: 0 }
      w.days.add(s.request.work_date); w.folios.add(folio(s))
      w.m25 += l.minutes_25 ?? 0; w.m35 += l.minutes_35 ?? 0; w.m100 += l.minutes_100 ?? 0; w.m += l.minutes ?? 0
      if (l.cost == null) w.pending++; else w.cost += l.cost
      workers.set(l.code, w)
      c.m += l.minutes ?? 0; c.cost += l.cost ?? 0
      tot.m25 += l.minutes_25 ?? 0; tot.m35 += l.minutes_35 ?? 0; tot.m100 += l.minutes_100 ?? 0; tot.m += l.minutes ?? 0
      if (l.cost == null) tot.pending++; else tot.cost += l.cost
    }
  }
  const from = sorted[0]?.request.work_date, to = sorted[sorted.length - 1]?.request.work_date
  return { sorted, from, to, tot, workers: [...workers.values()].sort((a, b) => b.m - a.m || a.name.localeCompare(b.name, 'es')),
    causes: [...causes.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.m - a.m) }
}
const period = (from?: string, to?: string) => (from === to ? fmtDate(from) : `${fmtDate(from)} al ${fmtDate(to)}`)

export async function downloadConsolidatedPdf(snaps: Snapshot[], withCost: boolean) {
  const c = consolidate(snaps)
  const d = await Doc.create('landscape', 'INFORME CONSOLIDADO DE HORAS EXTRAS', `${c.sorted.length} autorización(es) · ${period(c.from, c.to)}`)
  d.kv([['Período', period(c.from, c.to)], ['Autorizaciones', String(c.sorted.length)], ['Trabajadores', String(c.workers.length)],
    ['Horas autorizadas', `${fmtHours(c.tot.m)} (25 %: ${hoursOf(c.tot.m25)} · 35 %: ${hoursOf(c.tot.m35)} · 100 %: ${hoursOf(c.tot.m100)})`],
    ...(withCost ? [['Costo aproximado', `${fmtMoney(Math.round(c.tot.cost * 100) / 100)}${c.tot.pending ? ` (+${c.tot.pending} línea(s) con costo pendiente)` : ''}`] as [string, string]] : []),
    ['Generado', fmtDateTime(new Date().toISOString())]], 3)

  d.heading('1. Autorizaciones incluidas')
  d.table([{ t: 'Folio', w: 24 }, { t: 'Fecha', w: 19 }, { t: 'Tipo de día', w: 30 }, { t: 'Área', w: 32 }, { t: 'Causa', w: 38 }, { t: 'Actividad', w: 0 },
    { t: 'Aprobado por', w: 36 }, { t: 'Trab.', w: 11, a: 'right' }, { t: 'Horas', w: 15, a: 'right' }],
    c.sorted.map(s => ({ cells: [`${folio(s)} v${s.revision}`, fmtDate(s.request.work_date), s.holiday ? `Feriado: ${s.holiday}` : 'Laborable', s.area, s.cause, s.request.activity,
      s.approver, String(s.totals.workers), hoursOf(s.totals.minutes)] })))

  d.heading('2. Detalle por trabajador y día')
  d.table([{ t: 'Fecha', w: 19 }, { t: 'Trabajador · DNI · cargo', w: 0 }, { t: 'Código', w: 18 }, { t: 'Folio', w: 20 }, { t: 'Horario', w: 22 }, { t: 'Desc.', w: 13, a: 'right' },
    { t: 'H 25 %', w: 15, a: 'right' }, { t: 'H 35 %', w: 15, a: 'right' }, { t: 'H 100 %', w: 16, a: 'right' }, { t: 'Total h', w: 16, a: 'right' },
    ...(withCost ? [{ t: 'Costo aprox.', w: 24, a: 'right' as const }] : [])],
    c.sorted.flatMap(s => s.lines.map(l => ({ sub: workerSub(l), cells: [fmtDate(s.request.work_date), l.name, l.code, folio(s), `${fmtTime(l.start)}–${fmtTime(l.end)}`, `${l.break_minutes || 0} min`,
      hoursOf(l.minutes_25), hoursOf(l.minutes_35), hoursOf(l.minutes_100), hoursOf(l.minutes), ...(withCost ? [l.cost == null ? 'Pendiente' : fmtMoney(l.cost)] : [])] }))))

  d.heading('3. Resumen por trabajador')
  d.table([{ t: 'Código', w: 18 }, { t: 'Trabajador', w: 0 }, { t: 'DNI', w: 22 }, { t: 'Cargo', w: 44 }, { t: 'Días', w: 12, a: 'right' }, { t: 'Solic.', w: 13, a: 'right' },
    { t: 'H 25 %', w: 16, a: 'right' }, { t: 'H 35 %', w: 16, a: 'right' }, { t: 'H 100 %', w: 17, a: 'right' }, { t: 'Total h', w: 17, a: 'right' },
    ...(withCost ? [{ t: 'Costo aprox.', w: 26, a: 'right' as const }] : [])], [
    ...c.workers.map(w => ({ cells: [w.code, w.name, w.doc || '—', w.position || '—', String(w.days.size), String(w.folios.size), hoursOf(w.m25), hoursOf(w.m35), hoursOf(w.m100), hoursOf(w.m),
      ...(withCost ? [w.pending ? `${fmtMoney(w.cost)} *` : fmtMoney(w.cost)] : [])] })),
    { bold: true, cells: ['', `TOTAL · ${c.workers.length} trabajador(es)`, '', '', '', String(c.sorted.length), hoursOf(c.tot.m25), hoursOf(c.tot.m35), hoursOf(c.tot.m100), hoursOf(c.tot.m),
      ...(withCost ? [fmtMoney(Math.round(c.tot.cost * 100) / 100)] : [])] },
  ])
  if (withCost && c.tot.pending) d.block('Costo pendiente', '* Incluye líneas sin ficha remunerativa completa, cuyo costo no está sumado.')

  d.heading('4. Resumen por causa')
  d.table([{ t: 'Causa', w: 0 }, { t: 'Solicitudes', w: 24, a: 'right' }, { t: 'Horas', w: 24, a: 'right' }, { t: '% de horas', w: 24, a: 'right' },
    ...(withCost ? [{ t: 'Costo aprox.', w: 30, a: 'right' as const }] : [])],
    c.causes.map(x => ({ cells: [x.name, String(x.requests), hoursOf(x.m), c.tot.m ? `${Math.round((x.m / c.tot.m) * 1000) / 10} %` : '—', ...(withCost ? [fmtMoney(Math.round(x.cost * 100) / 100)] : [])] })))
  d.signatures('Elaborado por', 'Jefe de Distribución')
  d.save(`hhee-consolidado-${c.from ?? ''}${c.to && c.to !== c.from ? `_${c.to}` : ''}.pdf`)
}

export function consolidatedEmailDraft(snaps: Snapshot[], withCost: boolean) {
  const c = consolidate(snaps)
  const auths = c.sorted.map(s => `• ${folio(s)} v${s.revision} · ${fmtDate(s.request.work_date)}${s.holiday ? ` (feriado)` : ''} · ${s.cause} · ${s.request.activity} · ${s.totals.workers} trab. · ${hoursOf(s.totals.minutes)} h`).join('\n')
  const workers = c.workers.map(w => `• ${w.code} · ${w.name}${w.doc ? ` · DNI ${w.doc}` : ''}${w.position ? ` (${w.position})` : ''}: ${hoursOf(w.m)} h en ${w.days.size} día(s) (25 %: ${hoursOf(w.m25)} · 35 %: ${hoursOf(w.m35)} · 100 %: ${hoursOf(w.m100)})${withCost ? ` · ${fmtMoney(w.cost)}${w.pending ? ' + pendiente' : ''}` : ''}`).join('\n')
  return {
    subject: `Informe consolidado de horas extras · ${period(c.from, c.to)} · ${c.sorted.length} autorización(es)`,
    body: `INFORME CONSOLIDADO DE HORAS EXTRAS\nPeríodo: ${period(c.from, c.to)}\n\nAUTORIZACIONES INCLUIDAS (${c.sorted.length})\n${auths}\n\nRESUMEN POR TRABAJADOR (${c.workers.length})\n${workers}\n\nTotal: ${fmtHours(c.tot.m)} (25 %: ${hoursOf(c.tot.m25)} h · 35 %: ${hoursOf(c.tot.m35)} h · 100 %: ${hoursOf(c.tot.m100)} h)${withCost ? `\nCosto aproximado: ${fmtMoney(Math.round(c.tot.cost * 100) / 100)}${c.tot.pending ? ` (+${c.tot.pending} línea(s) con costo pendiente)` : ''}` : ''}\n\nCálculo: ${LEGAL_BASIS}\nSe adjunta el PDF consolidado. Horas y costo aproximado autorizados antes de la ejecución; no constituyen horas trabajadas ni liquidación de planilla.\n\nAtentamente,`,
  }
}
