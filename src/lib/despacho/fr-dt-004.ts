// Formato FR-DT.004 v02 «Programa de despacho»: columnas, encabezado y exportación a Excel y PDF con el logo JRM.
// Encabezado cuadrado al ancho de la tabla: logo (A:B) · títulos al centro · código/versión/fecha/página al borde derecho.

export type FrRow = { area: string | null; fecha: string; tipo_actividad: string; guia: string | null; ot_oc_os: string | null; razon_social: string | null; provincia: string | null
  distrito: string | null; destino: string | null; vuelta: number; placa: string | null; marca: string | null; conductor: string | null; modalidad: string
  hora_salida: string | null; hora_llegada_cliente: string | null; espera_min: number | null; descarga_min: number | null; hora_salida_cliente: string | null
  hora_llegada_planta: string | null; total_min: number | null; km_inicial: number | null; km_cliente: number | null; km_cliente_fuente: string | null
  km_recorridos: number | null; km_planta: number | null; km_total: number | null; ocupacion_pct: number | null; ocupacion_fuente: string | null
  peso_kg: number | null; peso_fuente: string | null; tipo_descarga: string; viaje: string | null; solicitud: string | null; estado_viaje: string }
export type FrMeta = { from: string; to: string; filters: string }

export const hora = (v: string | null) => v ? new Date(v).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
export const hm = (min: number | null) => min == null ? '' : `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`
export const fecha = (v: string) => v.split('-').reverse().join('/')

// Columnas en el orden del formato; w = ancho en Excel (caracteres) y en PDF (mm, A3 horizontal)
export const COLS: { h: string; v: (r: FrRow) => string | number; w: number; pdf: number }[] = [
  { h: 'AREA SOLICITANTE', v: r => r.area || '', w: 16, pdf: 16 }, { h: 'Fecha', v: r => fecha(r.fecha), w: 11, pdf: 13 },
  { h: 'TIPO DE ACTIVIDAD', v: r => r.tipo_actividad, w: 26, pdf: 22 }, { h: 'NRO DE GUIA', v: r => r.guia || '', w: 14, pdf: 15 },
  { h: 'OT /OC/OS', v: r => r.ot_oc_os || '', w: 14, pdf: 15 }, { h: 'Razón Social', v: r => r.razon_social || '', w: 28, pdf: 24 },
  { h: 'Provincia', v: r => r.provincia || '', w: 12, pdf: 12 }, { h: 'Distrito', v: r => r.distrito || '', w: 16, pdf: 15 },
  { h: 'NUMERO DE VUELTA', v: r => r.vuelta, w: 9, pdf: 9 }, { h: 'Placa del vehiculo', v: r => r.placa || '', w: 12, pdf: 13 },
  { h: 'Marca del vehiculo', v: r => r.marca || '', w: 13, pdf: 13 }, { h: 'Nombre de Conductores', v: r => r.conductor || '', w: 28, pdf: 24 },
  { h: 'DESTINO', v: r => r.destino || '', w: 16, pdf: 15 }, { h: 'Hr/SALIDA', v: r => hora(r.hora_salida), w: 9, pdf: 10 },
  { h: 'HORA LLEGADA CLIENTE', v: r => hora(r.hora_llegada_cliente), w: 10, pdf: 11 }, { h: 'TIEMPO DE ESPERA EN HORAS', v: r => hm(r.espera_min), w: 10, pdf: 11 },
  { h: 'TIEMPO DE ENTREGA DESCARGA', v: r => hm(r.descarga_min), w: 10, pdf: 11 }, { h: 'HORA DE SALIDA DE CLIENTE', v: r => hora(r.hora_salida_cliente), w: 10, pdf: 11 },
  { h: 'HORA DE LLEGADA A PLANTA', v: r => hora(r.hora_llegada_planta), w: 10, pdf: 11 }, { h: 'TIEMPO TOTAL HORAS RECORRIDAS / PARADAS', v: r => hm(r.total_min), w: 12, pdf: 13 },
  { h: 'KM/ INICIAL', v: r => r.km_inicial ?? '', w: 10, pdf: 12 }, { h: 'KM/LLEGADA CLIENTE', v: r => r.km_cliente ?? '', w: 11, pdf: 12 },
  { h: 'KM RECORRIDOS', v: r => r.km_recorridos ?? '', w: 10, pdf: 11 }, { h: 'KM. LLEGADA PLANTA', v: r => r.km_planta ?? '', w: 11, pdf: 12 },
  { h: 'KM TOTAL DE ENTREGA', v: r => r.km_total ?? '', w: 10, pdf: 11 }, { h: 'METRO CUBICO (%)', v: r => r.ocupacion_pct == null ? '' : `${r.ocupacion_pct}%`, w: 9, pdf: 10 },
  { h: 'PESO (KG)', v: r => r.peso_kg ?? '', w: 10, pdf: 11 }, { h: 'TIPO DE DESCARGA', v: r => r.tipo_descarga, w: 15, pdf: 19 },
]
export const estimated = (r: FrRow, h: string) => (h === 'KM/LLEGADA CLIENTE' && r.km_cliente_fuente === 'GPS') || (h === 'PESO (KG)' && r.peso_fuente === 'PACKING_LIST')
  || (h === 'METRO CUBICO (%)' && r.ocupacion_fuente === 'CONDUCTOR')
const nota = (r: FrRow) => [r.km_cliente_fuente === 'GPS' && 'km en cliente estimado con GPS', r.ocupacion_fuente === 'CONDUCTOR' && 'ocupación corregida por el conductor',
  r.peso_fuente === 'PACKING_LIST' && 'peso del packing list', `viaje ${r.viaje || '—'} · ${r.solicitud || '—'}`].filter(Boolean).join(' · ')

const NAVY = '002855', AMBER = 'FEF3C7'
const extract = () => new Date().toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' })
const logoBytes = async () => new Uint8Array(await (await fetch('/logo-jrm-sia.png')).arrayBuffer())
const download = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url) }

export async function exportExcel(rows: FrRow[], meta: FrMeta) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('FR-DT.004', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } })
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.w })
  const thin = { style: 'thin' as const, color: { argb: 'FF000000' } }, box = { top: thin, left: thin, bottom: thin, right: thin }
  const put = (range: string, value: string, opts: { bold?: boolean; size?: number; align?: 'center' | 'left' } = {}) => {
    ws.mergeCells(range); const cell = ws.getCell(range.split(':')[0]); cell.value = value
    cell.font = { bold: opts.bold ?? true, size: opts.size ?? 11 }; cell.alignment = { vertical: 'middle', horizontal: opts.align ?? 'center', wrapText: true }
    const [a, b] = range.split(':'); const s = ws.getCell(a), e = ws.getCell(b || a)
    for (let r = Number(s.row); r <= Number(e.row); r++) for (let c = Number(s.col); c <= Number(e.col); c++) ws.getCell(r, c).border = box
  }
  // Encabezado cuadrado al ancho de la tabla: 4 filas de igual alto; logo A:B, títulos C:Z, control AA:AB
  for (let r = 1; r <= 4; r++) ws.getRow(r).height = 21
  put('A1:B4', '')
  put('C1:Z1', 'SISTEMA INTEGRADO DE GESTIÓN', { size: 12 })
  put('C2:Z2', 'FORMATO', { size: 10 })
  put('C3:Z4', 'PROGRAMA DE DESPACHO', { size: 16 })
  put('AA1:AB1', 'CÓDIGO: FR-DT.004', { size: 10, align: 'left' })
  put('AA2:AB2', 'VERSIÓN Nº: 02', { size: 10, align: 'left' })
  put('AA3:AB3', 'FECHA: 19.10.16', { size: 10, align: 'left' })
  put('AA4:AB4', 'PÁGINA: 1 de 1', { size: 10, align: 'left' })
  const logo = wb.addImage({ buffer: (await logoBytes()).buffer as ArrayBuffer, extension: 'png' })
  // Logo centrado en A1:B4 respetando su proporción (267 × 124 px)
  const wPx = (COLS[0].w + COLS[1].w) * 7, hPx = 4 * 21 * 4 / 3, scale = Math.min((wPx - 8) / 267, (hPx - 8) / 124)
  ws.addImage(logo, { tl: { col: ((wPx - 267 * scale) / 2) / (7 * COLS[0].w), row: ((hPx - 124 * scale) / 2) / (21 * 4 / 3) }, ext: { width: 267 * scale, height: 124 * scale }, editAs: 'oneCell' })
  ws.getCell('A5').value = `Período: ${fecha(meta.from)} a ${fecha(meta.to)}${meta.filters ? ` · ${meta.filters}` : ''} · ${rows.length} paradas · extraído ${extract()} (hora de Lima)`
  ws.getCell('A5').font = { size: 9, italic: true }
  const head = ws.getRow(7); head.height = 45
  COLS.forEach((c, i) => { const cell = head.getCell(i + 1); cell.value = c.h; cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + NAVY } }; cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; cell.border = box })
  const noteCol = COLS.length + 2
  ws.getColumn(noteCol).width = 60; ws.getCell(7, noteCol).value = 'Fuente de datos estimados'; ws.getCell(7, noteCol).font = { bold: true, size: 9 }
  rows.forEach((r, i) => {
    const row = ws.getRow(8 + i)
    COLS.forEach((c, j) => { const cell = row.getCell(j + 1); cell.value = c.v(r); cell.border = box; cell.font = { size: 9 }
      cell.alignment = { vertical: 'middle', horizontal: typeof c.v(r) === 'number' ? 'right' : 'left', wrapText: true }
      if (estimated(r, c.h)) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + AMBER } } })
    ws.getCell(8 + i, noteCol).value = nota(r); ws.getCell(8 + i, noteCol).font = { size: 8, color: { argb: 'FF555555' } }
  })
  ws.views = [{ state: 'frozen', ySplit: 7 }]
  download(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `FR-DT.004_${meta.from}_${meta.to}.xlsx`)
}

export async function exportPdf(rows: FrRow[], meta: FrMeta) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 8
  const total = COLS.reduce((s, c) => s + c.pdf, 0), k = (W - 2 * M) / total, widths = COLS.map(c => c.pdf * k)
  const bytes = await logoBytes(); let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b) })
  const logo = 'data:image/png;base64,' + btoa(bin)
  const HDR = 24, rowH = HDR / 4, logoW = widths[0] + widths[1], ctlW = 46, midW = W - 2 * M - logoW - ctlW
  const header = (page: number, pages: number) => {
    doc.setDrawColor(0); doc.setLineWidth(0.3); doc.setTextColor(0)
    doc.rect(M, M, logoW, HDR); const lw = Math.min(logoW - 4, (HDR - 4) * 267 / 124), lh = lw * 124 / 267
    doc.addImage(logo, 'PNG', M + (logoW - lw) / 2, M + (HDR - lh) / 2, lw, lh)
    const x = M + logoW
    doc.rect(x, M, midW, rowH); doc.rect(x, M + rowH, midW, rowH); doc.rect(x, M + 2 * rowH, midW, 2 * rowH)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('SISTEMA INTEGRADO DE GESTIÓN', x + midW / 2, M + rowH / 2, { align: 'center', baseline: 'middle' })
    doc.setFontSize(9); doc.text('FORMATO', x + midW / 2, M + 1.5 * rowH, { align: 'center', baseline: 'middle' })
    doc.setFontSize(15); doc.text('PROGRAMA DE DESPACHO', x + midW / 2, M + 3 * rowH, { align: 'center', baseline: 'middle' })
    const cx = x + midW; doc.setFontSize(9)
    ;['CÓDIGO: FR-DT.004', 'VERSIÓN Nº: 02', 'FECHA: 19.10.16', `PÁGINA: ${page} de ${pages}`].forEach((t, i) => { doc.rect(cx, M + i * rowH, ctlW, rowH); doc.text(t, cx + 2, M + (i + 0.5) * rowH, { baseline: 'middle' }) })
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8)
    doc.text(`Período: ${fecha(meta.from)} a ${fecha(meta.to)}${meta.filters ? ` · ${meta.filters}` : ''} · ${rows.length} paradas · extraído ${extract()} (hora de Lima) · celdas en ámbar: dato estimado o corregido`, M, M + HDR + 5)
  }
  const top = M + HDR + 8
  // Títulos de columna: se miden una vez y la misma altura se usa al paginar y al dibujar
  doc.setFont('helvetica', 'bold'); doc.setFontSize(6.2)
  const lines = COLS.map((c, i) => doc.splitTextToSize(c.h, widths[i] - 1.5) as string[]), headH = Math.max(...lines.map(l => l.length)) * 2.6 + 2
  const colHead = (y: number) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.2); const h = headH
    let x = M; COLS.forEach((_, i) => { doc.setFillColor(0, 40, 85); doc.setDrawColor(0); doc.rect(x, y, widths[i], h, 'FD'); doc.setTextColor(255); doc.text(lines[i], x + widths[i] / 2, y + 2.6, { align: 'center' }); x += widths[i] })
    doc.setTextColor(0); return y + h
  }
  // Primera pasada para paginar; segunda para dibujar con «Página X de Y»
  doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5)
  const cells = rows.map(r => COLS.map((c, i) => doc.splitTextToSize(String(c.v(r)), widths[i] - 1.5) as string[]))
  const heights = cells.map(row => Math.max(...row.map(l => l.length)) * 2.6 + 1.6)
  const pages: number[][] = [[]]; let y = top + headH
  heights.forEach((h, i) => { if (y + h > H - M && pages[pages.length - 1].length) { pages.push([]); y = top + headH } pages[pages.length - 1].push(i); y += h })
  pages.forEach((idx, p) => {
    if (p) doc.addPage(); header(p + 1, pages.length); let yy = colHead(top)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setDrawColor(150); doc.setLineWidth(0.1)
    idx.forEach(i => { let x = M; const r = rows[i]
      COLS.forEach((c, j) => { if (estimated(r, c.h)) { doc.setFillColor(254, 243, 199); doc.rect(x, yy, widths[j], heights[i], 'F') }
        doc.rect(x, yy, widths[j], heights[i]); const num = typeof c.v(r) === 'number'
        doc.text(cells[i][j], num ? x + widths[j] - 0.8 : x + 0.8, yy + 2.6, { align: num ? 'right' : 'left' }); x += widths[j] })
      yy += heights[i] })
    if (!idx.length) { doc.setFont('helvetica', 'italic'); doc.text('Sin paradas en el período.', M, yy + 5) }
  })
  doc.save(`FR-DT.004_${meta.from}_${meta.to}.pdf`)
}
