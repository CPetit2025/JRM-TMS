// Informe PDF de la programación de transporte (Seguimiento): los servicios elegidos en el registro de solicitudes,
// agrupados por fecha programada (salida de la ruta o, sin ruta, atención solicitada). A4 horizontal, horario de Lima.

export type ProgRow = {
  id: string
  day: string                // AAAA-MM-DD (fecha programada)
  scheduled: boolean         // true: ya tiene ruta; false: por programar (se usa la atención solicitada)
  request_number: string
  reference: string          // OT 16516 · OC … · OS …
  family: string             // S(1) · E(0)
  party: string              // cliente o proveedor
  service: string            // Entrega, Recojo, Punto a punto…
  origin: string
  destination: string
  district: string
  attention: string          // atención solicitada (fecha y hora)
  departure: string          // salida de la ruta (hora) o vacío
  route: string              // número de ruta
  unit: string               // placa · conductor
  status: string
}

export const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
const weekday = (day: string) => new Date(`${day}T12:00:00-05:00`).toLocaleDateString('es-PE', { weekday: 'long', timeZone: 'America/Lima' })
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function programacionRange(rows: ProgRow[]) {
  const days = rows.map(r => r.day).filter(Boolean).sort()
  return { from: days[0] || '', to: days[days.length - 1] || '' }
}

export async function programacionPdf(rows: ProgRow[], opts: { title?: string; note?: string } = {}): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const W = 297, M = 10
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day) || a.departure.localeCompare(b.departure) || a.request_number.localeCompare(b.request_number))
  const { from, to } = programacionRange(sorted)
  const generated = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' })
  const cols: { h: string; w: number; v: (r: ProgRow) => string }[] = [
    { h: 'Solicitud', w: 22, v: r => r.request_number },
    { h: 'OT / Referencia', w: 30, v: r => [r.reference, r.family].filter(Boolean).join('\n') },
    { h: 'Cliente / Proveedor', w: 42, v: r => r.party || '—' },
    { h: 'Servicio', w: 19, v: r => r.service },
    { h: 'Origen / Destino', w: 62, v: r => `Origen: ${r.origin || '—'}\nDestino: ${r.destination || '—'}${r.district ? ` (${r.district})` : ''}` },
    { h: 'Atención solicitada', w: 29, v: r => r.attention },
    { h: 'Ruta / Unidad', w: 50, v: r => r.scheduled ? [r.route + (r.departure ? ` · salida ${r.departure}` : ''), r.unit].filter(Boolean).join('\n') : 'Pendiente de programación' },
    { h: 'Estado', w: 23, v: r => r.status },
  ]
  const fs = 7.5, lh = 3.3
  let y = 0, page = 0

  const header = () => {
    page++
    doc.setFillColor('#002855'); doc.rect(0, 0, W, 22, 'F')
    doc.setTextColor('#ffffff'); doc.setFont('helvetica', 'bold'); doc.setFontSize(15)
    doc.text(opts.title || 'Programación de transporte', M, 10)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
    doc.text(`JRM · ${from ? (from === to ? dayLabel(from) : `Del ${dayLabel(from)} al ${dayLabel(to)}`) : ''} · ${sorted.length} servicio${sorted.length === 1 ? '' : 's'} · horario de Lima`, M, 17)
    doc.text(`Generado: ${generated}`, W - M, 17, { align: 'right' })
    doc.setTextColor('#172b4d')
    y = 28
    if (page === 1 && opts.note) {
      doc.setFontSize(8.5)
      const lines = doc.splitTextToSize(opts.note, W - 2 * M) as string[]
      doc.text(lines, M, y); y += lines.length * 3.8 + 2
    }
    // Encabezado de la tabla
    doc.setFillColor('#e2e8f0'); doc.rect(M, y, W - 2 * M, 6, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5)
    let x = M
    for (const c of cols) { doc.text(c.h, x + 1.2, y + 4); x += c.w }
    doc.setFont('helvetica', 'normal')
    y += 7
  }
  const footer = () => {
    doc.setFontSize(7); doc.setTextColor('#64748b')
    doc.text('Fecha programada: salida de la ruta; sin ruta asignada, la atención solicitada.', M, 205)
    doc.text(`Página ${page}`, W - M, 205, { align: 'right' })
    doc.setTextColor('#172b4d')
  }

  header()
  let current = ''
  for (const r of sorted) {
    doc.setFontSize(fs)
    const cells = cols.map(c => doc.splitTextToSize(c.v(r), c.w - 2.4) as string[])
    const h = Math.max(...cells.map(l => l.length)) * lh + 2
    const groupH = r.day !== current ? 7 : 0
    if (y + h + groupH > 200) { footer(); doc.addPage(); header(); current = '' }
    if (r.day !== current) {
      current = r.day
      const n = sorted.filter(x => x.day === r.day).length
      doc.setFillColor('#f1f5f9'); doc.rect(M, y, W - 2 * M, 6, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor('#002855')
      doc.text(`${cap(weekday(r.day))} ${dayLabel(r.day)} · ${n} servicio${n === 1 ? '' : 's'}`, M + 1.2, y + 4.2)
      doc.setFont('helvetica', 'normal'); doc.setTextColor('#172b4d'); doc.setFontSize(fs)
      y += 7
    }
    let x = M
    cells.forEach((lines, i) => { doc.text(lines, x + 1.2, y + 3); x += cols[i].w })
    y += h
    doc.setDrawColor('#e2e8f0'); doc.line(M, y - 0.6, W - M, y - 0.6)
  }
  footer()
  return doc.output('blob')
}
