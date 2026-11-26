import type ExcelJSType from 'exceljs'
import { BODEGAS, tn, totalAvance, type AvanceFila, type AvanceTotal } from './avance-contrato'

// Hoja «Avance del contrato por ítem»: el mismo modelo alimenta la vista previa y el Excel, así lo que se ve es lo que se descarga
export type AvanceMeta = { ot: string; cliente: string | null; corte: string | null; filtros: string[]; generado: Date }
export type HojaFila =
  | { tipo: 'lote'; lote: string; n: number; t: AvanceTotal }
  | { tipo: 'item'; f: AvanceFila }
export type HojaLote = { lote: string; n: number; sinPeso: number; enTn: boolean; contrato: number; despachado: number; apt: number; porProducir: number; pct: number | null }
export type HojaAvance = { meta: AvanceMeta; total: AvanceTotal; general: AvanceTotal; filas: HojaFila[]; lotes: HojaLote[] }

export const GRUPOS_XLS = ['Contrato', 'Despachado', 'Saldo', 'APT 647', 'APT 540', 'APT ST', 'Por producir'] as const
export const ITEM_COLS = 5 // Lote, Ítem, ID, Glosa, Unidad
export const fecha = (d: string | Date | null) => (d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

/** Cantidades de los 7 grupos de una fila: contrato, despachado, saldo, APT 647/540/ST y por producir */
export const cantidades = (f: AvanceFila) => [f.contratado, f.despachado, f.saldo, f.apt[0], f.apt[1], f.apt[2], f.porProducir]
export const cantidadesTotal = (t: AvanceTotal) => [t.contratado, t.despachado, t.saldo, t.apt[0], t.apt[1], t.apt[2], t.porProducir]
export const toneladasTotal = (t: AvanceTotal) => [t.tContratado, t.tDespachado, t.tSaldo, t.tApt[0], t.tApt[1], t.tApt[2], t.tPorProducir]

export function buildHoja(filas: AvanceFila[], todas: AvanceFila[], meta: AvanceMeta): HojaAvance {
  const lotes = [...new Set(filas.map(f => f.lote))]
  const out: HojaFila[] = []
  for (const l of lotes) {
    const g = filas.filter(f => f.lote === l)
    out.push({ tipo: 'lote', lote: l, n: g.length, t: totalAvance(g) })
    for (const f of g) out.push({ tipo: 'item', f })
  }
  // Cumplimiento: cada lote completo (no solo lo filtrado); en unidades si ningún ítem tiene peso
  const resumen = lotes.map(l => {
    const t = totalAvance(todas.filter(f => f.lote === l)), enTn = t.tContratado > 0
    const contrato = enTn ? t.tContratado : t.mixta ? 0 : t.contratado
    const despachado = enTn ? t.tDespachado : t.despachado
    return { lote: l, n: t.n, sinPeso: t.sinPeso, enTn, contrato, despachado, apt: enTn ? t.tApt[0] + t.tApt[1] + t.tApt[2] : t.apt[0] + t.apt[1] + t.apt[2],
      porProducir: enTn ? t.tPorProducir : t.porProducir, pct: contrato > 0 ? Math.min(1, despachado / contrato) : null }
  })
  return { meta, total: totalAvance(filas), general: totalAvance(todas), filas: out, lotes: resumen }
}

const NAVY = 'FF002855', RED = 'FFD71920', WHITE = 'FFFFFFFF', INK = 'FF0F172A', MUTED = 'FF64748B', LINE = 'FFE2E8F0'
const GRUPO_FILL = ['FFE8EEF7', 'FFE6F4EE', 'FFF1F5F9', 'FFFDF2E2', 'FFFDF2E2', 'FFFDF2E2', 'FFFEF3C7']
const ESTADO = { COMPLETO: ['FFD1FAE5', 'FF065F46'], PARCIAL: ['FFFEF3C7', 'FF92400E'], PENDIENTE: ['FFFEE2E2', 'FF991B1B'] } as const
const QTY = '#,##0;-#,##0;"—"', QTY3 = '#,##0.000;-#,##0.000;"—"', TN = '#,##0.000;-#,##0.000;"—"', TN2 = '#,##0.00;-#,##0.00;"—"'
const solid = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } })
const hair = { style: 'thin' as const, color: { argb: LINE } }

/** Libro con dos hojas horizontales (A3, ajustado al ancho): avance por ítem agrupado por lote y cumplimiento por lote */
export async function buildAvanceWorkbook(ExcelJS: typeof ExcelJSType, hoja: HojaAvance, logo?: Uint8Array) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'JRM TMS'; wb.created = hoja.meta.generado
  const { meta } = hoja
  const logoId = logo ? wb.addImage({ buffer: logo.buffer as ArrayBuffer, extension: 'png' }) : null
  const setup = (ws: ExcelJSType.Worksheet, titles: string) => {
    ws.pageSetup = { orientation: 'landscape', paperSize: 8, fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, printTitlesRow: titles,
      margins: { left: 0.3, right: 0.3, top: 0.45, bottom: 0.5, header: 0.2, footer: 0.25 } } as unknown as Partial<ExcelJSType.PageSetup>
    ws.headerFooter = { oddFooter: `&L&8JRM · Avance del contrato OT ${meta.ot}&C&8Página &P de &N&R&8Generado ${fecha(meta.generado)}` }
    ws.properties.defaultRowHeight = 16
  }
  // Encabezado corporativo: logo, título, OT/cliente y datos del corte a la derecha; franja azul y línea roja
  const header = (ws: ExcelJSType.Worksheet, ncol: number, titulo: string) => {
    for (let r = 1; r <= 3; r++) ws.getRow(r).height = 22
    ws.mergeCells(1, 1, 3, 2)
    if (logoId !== null) {
      ws.addImage(logoId, { tl: { col: 0.15, row: 0.2 }, ext: { width: 150, height: 70 }, editAs: 'oneCell' })
    }
    // Hoja ancha: datos del corte en las 5 últimas columnas; hoja angosta: solo en la última
    const right = ncol > 12 ? ncol - 4 : ncol
    ws.mergeCells(1, 3, 2, right - 1); ws.mergeCells(3, 3, 3, right - 1)
    const t = ws.getCell(1, 3); t.value = titulo; t.font = { name: 'Calibri', size: 18, bold: true, color: { argb: NAVY } }; t.alignment = { vertical: 'middle' }
    const s = ws.getCell(3, 3); s.value = `OT ${meta.ot}${meta.cliente ? ` · ${meta.cliente}` : ''}`; s.font = { size: 11, bold: true, color: { argb: RED } }; s.alignment = { vertical: 'middle' }
    ;[['Corte ERP', fecha(meta.corte)], ['Generado', fecha(meta.generado)], ['Filtros', meta.filtros.join(' · ') || 'Ninguno']].forEach(([k, v], i) => {
      if (right < ncol) ws.mergeCells(i + 1, right, i + 1, ncol)
      const c = ws.getCell(i + 1, right); c.value = { richText: [{ text: `${k}: `, font: { size: 9, bold: true, color: { argb: MUTED } } }, { text: v, font: { size: 9, color: { argb: INK } } }] }
      c.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true }
    })
    ws.getRow(4).height = 5; ws.getRow(5).height = 3
    for (let c = 1; c <= ncol; c++) { ws.getCell(4, c).fill = solid(NAVY); ws.getCell(5, c).fill = solid(RED) }
  }

  // ---- Hoja 1: avance por ítem ----
  const ncol = ITEM_COLS + GRUPOS_XLS.length * 2 + 4 // + avance, estado, peso, fuente
  const ws = wb.addWorksheet('Avance por ítem', { views: [{ state: 'frozen', xSplit: ITEM_COLS, ySplit: 11, showGridLines: false }] })
  // shortcut: sin outlineProperties (summaryBelow); ExcelJS lo escribe en orden inválido junto con fitToPage y Excel no abre el archivo
  setup(ws, '10:11')
  // shortcut: sin notas de celda (con el logo en la hoja ExcelJS genera un archivo que Excel no abre); la unidad va en su columna
  ;[12, 15, 20, 46, 8].forEach((w, i) => { ws.getColumn(i + 1).width = w })
  for (let i = 0; i < GRUPOS_XLS.length * 2; i++) ws.getColumn(ITEM_COLS + 1 + i).width = i % 2 ? 10 : 11
  ;[11, 12, 11, 9].forEach((w, i) => { ws.getColumn(ITEM_COLS + GRUPOS_XLS.length * 2 + 1 + i).width = w })
  header(ws, ncol, 'AVANCE DEL CONTRATO POR ÍTEM')

  // Indicadores del contrato completo
  const G = hoja.general, pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '—')
  const kpis: Array<[string, string, string, string]> = [
    ['CONTRATADO', `${G.tContratado.toLocaleString('es-PE', { maximumFractionDigits: 2 })} TN`, `${G.n} ítems${G.sinPeso ? ` · ${G.sinPeso} sin peso` : ''}`, NAVY],
    ['DESPACHADO', `${G.tDespachado.toLocaleString('es-PE', { maximumFractionDigits: 2 })} TN`, `${pct(G.tDespachado, G.tContratado)} del contrato`, NAVY],
    ['SALDO POR DESPACHAR', `${G.tSaldo.toLocaleString('es-PE', { maximumFractionDigits: 2 })} TN`, `${hoja.filas.filter(f => f.tipo === 'item' && f.f.saldo > 0).length} ítems con saldo en la vista`, 'FFB91C1C'],
    ['EN APT (LISTO)', `${(G.tApt[0] + G.tApt[1] + G.tApt[2]).toLocaleString('es-PE', { maximumFractionDigits: 2 })} TN`, BODEGAS.map((b, i) => `${b}: ${G.tApt[i].toLocaleString('es-PE', { maximumFractionDigits: 2 })}`).join(' · '), 'FFD97706'],
    ['POR PRODUCIR', `${G.tPorProducir.toLocaleString('es-PE', { maximumFractionDigits: 2 })} TN`, `${pct(G.tPorProducir, G.tContratado)} del contrato`, 'FF475569'],
  ]
  const spans = [[1, 3], [4, 7], [8, 12], [13, 16], [17, ncol]]
  ws.getRow(6).height = 16; ws.getRow(7).height = 26; ws.getRow(8).height = 16; ws.getRow(9).height = 8
  kpis.forEach(([l, v, h, color], i) => {
    const [a, b] = spans[i]
    ;[[6, l, { size: 8, bold: true, color: { argb: MUTED } }], [7, v, { size: 16, bold: true, color: { argb: color } }], [8, h, { size: 8, color: { argb: MUTED } }]].forEach(([r, text, font]) => {
      ws.mergeCells(r as number, a, r as number, b); const c = ws.getCell(r as number, a); c.value = text as string; c.font = font as ExcelJSType.Font
      c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
    })
    for (let r = 6; r <= 8; r++) for (let c = a; c <= b; c++) {
      ws.getCell(r, c).fill = solid('FFF8FAFC')
      ws.getCell(r, c).border = { top: r === 6 ? { style: 'thick', color: { argb: color } } : undefined, bottom: r === 8 ? hair : undefined, left: c === a ? hair : undefined, right: c === b ? hair : undefined }
    }
  })

  // Títulos de columna en dos niveles
  const h1 = ws.getRow(10), h2 = ws.getRow(11); h1.height = 20; h2.height = 18
  const head = (r: number, c: number, text: string, fill: string, color = INK) => {
    const cell = ws.getCell(r, c); cell.value = text; cell.font = { size: 9, bold: true, color: { argb: color } }; cell.fill = solid(fill)
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; cell.border = { top: hair, bottom: { style: 'medium', color: { argb: NAVY } }, left: hair, right: hair }
  }
  ;['LOTE', 'ÍTEM', 'ID', 'GLOSA', 'UNIDAD'].forEach((t, i) => { ws.mergeCells(10, i + 1, 11, i + 1); head(10, i + 1, t, NAVY, WHITE) })
  GRUPOS_XLS.forEach((g, i) => {
    const c = ITEM_COLS + 1 + i * 2
    ws.mergeCells(10, c, 10, c + 1); head(10, c, g.toUpperCase(), GRUPO_FILL[i]); head(11, c, 'CANT.', GRUPO_FILL[i], MUTED); head(11, c + 1, 'TN', GRUPO_FILL[i], MUTED)
  })
  ;['AVANCE', 'ESTADO', 'PESO UNIT. (KG)', 'FUENTE PESO'].forEach((t, i) => { const c = ITEM_COLS + GRUPOS_XLS.length * 2 + 1 + i; ws.mergeCells(10, c, 11, c); head(10, c, t, NAVY, WHITE) })
  ws.autoFilter = { from: { row: 11, column: 1 }, to: { row: 11, column: ncol } }

  const cAv = ITEM_COLS + GRUPOS_XLS.length * 2 + 1
  const numCells = (r: number, q: number[], t: Array<number | null>, mixta: boolean, bold: boolean, color: string) => {
    q.forEach((v, i) => {
      const cq = ws.getCell(r, ITEM_COLS + 1 + i * 2), ct = ws.getCell(r, ITEM_COLS + 2 + i * 2)
      cq.value = mixta ? '—' : v; cq.numFmt = Number.isInteger(v) ? QTY : QTY3; cq.alignment = { horizontal: 'right', vertical: 'middle' }
      cq.font = { size: 9, bold, color: { argb: color } }
      const tv = t[i]
      if (tv === null && v) { ct.value = 's/p'; ct.font = { size: 9, bold: true, color: { argb: 'FFB45309' } }; ct.alignment = { horizontal: 'right', vertical: 'middle' } }
      else { ct.value = tv ?? 0; ct.numFmt = bold ? TN2 : TN; ct.font = { size: 9, bold, color: { argb: bold ? color : MUTED } }; ct.alignment = { horizontal: 'right', vertical: 'middle' } }
    })
  }
  // Lote solo numérico (16101) como número: evita el aviso de «número almacenado como texto»
  const num = (v: string, i: number) => (i === 0 && /^\d{1,9}$/.test(v) ? Number(v) : v)
  let r = 12
  for (const f of hoja.filas) {
    const row = ws.getRow(r)
    if (f.tipo === 'lote') {
      row.height = 18
      ws.getCell(r, 1).value = num(f.lote, 0); ws.mergeCells(r, 2, r, ITEM_COLS); ws.getCell(r, 2).value = `${f.n} ítems`
      ;[1, 2].forEach(c => { ws.getCell(r, c).font = { size: 10, bold: true, color: { argb: NAVY } }; ws.getCell(r, c).alignment = { horizontal: 'left', vertical: 'middle' } })
      numCells(r, cantidadesTotal(f.t), toneladasTotal(f.t), f.t.mixta, true, NAVY)
      ws.getCell(r, cAv).value = f.t.tContratado > 0 ? Math.min(1, f.t.tDespachado / f.t.tContratado) : null
      for (let c = 1; c <= ncol; c++) { const cell = ws.getCell(r, c); cell.fill = solid('FFE8EEF7'); cell.border = { top: { style: 'thin', color: { argb: 'FFB6C4DA' } }, bottom: { style: 'thin', color: { argb: 'FFB6C4DA' } } } }
    } else {
      const x = f.f
      row.outlineLevel = 1
      ;[x.lote, x.item, x.producto, x.glosa ?? '', x.unidad ?? ''].forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = num(v, i)
        c.font = { size: 9, bold: i === 1 || (i === 4 && v.toUpperCase() !== 'UND'), color: { argb: i === 1 ? NAVY : i === 2 ? MUTED : i === 4 && v.toUpperCase() !== 'UND' ? 'FFB45309' : INK } }
        c.alignment = { vertical: 'middle', wrapText: i === 3, horizontal: i === 4 ? 'center' : 'left' } })
      numCells(r, cantidades(x), cantidades(x).map(q => (x.peso ? tn(q, x.peso) : null)), false, false, INK)
      ws.getCell(r, cAv).value = x.avance
      const [bg, fg] = ESTADO[x.estado]; const e = ws.getCell(r, cAv + 1); e.value = x.estado; e.font = { size: 8, bold: true, color: { argb: fg } }; e.fill = solid(bg); e.alignment = { horizontal: 'center', vertical: 'middle' }
      const p = ws.getCell(r, cAv + 2); p.value = x.peso ?? '—'; p.numFmt = '#,##0.000'; p.font = { size: 9, color: { argb: MUTED } }; p.alignment = { horizontal: 'right', vertical: 'middle' }
      const s = ws.getCell(r, cAv + 3); s.value = x.pesoFuente ?? 'Sin peso'; s.font = { size: 8, color: { argb: x.pesoFuente ? MUTED : 'FFB45309' } }; s.alignment = { horizontal: 'center', vertical: 'middle' }
      for (let c = 1; c <= ncol; c++) { const cell = ws.getCell(r, c); cell.border = { bottom: hair }; if (c !== cAv + 1 && r % 2 === 0) cell.fill = solid('FFFBFCFE') }
    }
    const av = ws.getCell(r, cAv); av.numFmt = '0%'; av.font = { size: 9, bold: f.tipo === 'lote', color: { argb: INK } }; av.alignment = { horizontal: 'right', vertical: 'middle' }
    r++
  }
  // Total de la vista
  const T = hoja.total
  ws.getRow(r).height = 20
  ws.mergeCells(r, 1, r, ITEM_COLS); ws.getCell(r, 1).value = `TOTAL · ${T.n} ítems${meta.filtros.length ? ' (filtrados)' : ''}`
  numCells(r, cantidadesTotal(T), toneladasTotal(T), T.mixta, true, WHITE)
  ws.getCell(r, cAv).value = T.tContratado > 0 ? Math.min(1, T.tDespachado / T.tContratado) : null; ws.getCell(r, cAv).numFmt = '0%'
  for (let c = 1; c <= ncol; c++) { const cell = ws.getCell(r, c); cell.fill = solid(NAVY); cell.font = { ...(cell.font ?? {}), size: 10, bold: true, color: { argb: WHITE } } }
  if (r > 12) ws.addConditionalFormatting({ ref: `${ws.getColumn(cAv).letter}12:${ws.getColumn(cAv).letter}${r - 1}`,
    rules: [{ type: 'dataBar', priority: 1, minLength: 0, maxLength: 100, gradient: false, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FFA9BEDD' } } as unknown as ExcelJSType.ConditionalFormattingRule] })
  ws.getCell(r + 2, 1).value = 'Notas: cantidades en la unidad del contrato (columna Unidad). TN con el peso unitario del ERP o, si falta, el promedio del ID en el APT; «s/p» = sin peso. El stock de un ID compartido se asigna a los ítems con saldo en orden 647 → 540 → ST. Por producir = saldo − stock asignado. Use los botones + / − del margen para plegar los lotes.'
  ws.mergeCells(r + 2, 1, r + 3, ncol); ws.getCell(r + 2, 1).font = { size: 8, italic: true, color: { argb: MUTED } }; ws.getCell(r + 2, 1).alignment = { wrapText: true, vertical: 'top' }

  // ---- Hoja 2: cumplimiento por lote ----
  const w2 = wb.addWorksheet('Cumplimiento por lote', { views: [{ state: 'frozen', ySplit: 7, showGridLines: false }] })
  setup(w2, '7:7')
  const cols2: Array<[string, number]> = [['LOTE', 16], ['ÍTEMS', 8], ['SIN PESO', 9], ['MEDIDA', 9], ['CONTRATO', 13], ['DESPACHADO', 13], ['EN APT (LISTO)', 13], ['POR PRODUCIR', 13], ['CUMPLIMIENTO', 34]]
  cols2.forEach(([, w], i) => { w2.getColumn(i + 1).width = w })
  header(w2, cols2.length, 'CUMPLIMIENTO POR LOTE')
  w2.getRow(6).height = 8; w2.getRow(7).height = 22
  cols2.forEach(([t], i) => { const c = w2.getCell(7, i + 1); c.value = t; c.font = { size: 9, bold: true, color: { argb: WHITE } }; c.fill = solid(NAVY); c.alignment = { horizontal: 'center', vertical: 'middle' } })
  hoja.lotes.forEach((l, i) => {
    const rr = 8 + i, row = w2.getRow(rr); row.height = 18
    ;[l.lote, l.n, l.sinPeso || '—', l.enTn ? 'TN' : 'Und', l.contrato, l.despachado, l.apt, l.porProducir, l.pct].forEach((v, j) => {
      const c = row.getCell(j + 1); c.value = v as ExcelJSType.CellValue; c.font = { size: 10, bold: j === 0 || j === 8, color: { argb: j === 0 ? NAVY : INK } }
      c.alignment = { horizontal: j === 0 ? 'left' : j === 3 ? 'center' : 'right', vertical: 'middle' }
      if (j >= 4 && j <= 7) c.numFmt = l.enTn ? TN2 : QTY
      if (j === 8) c.numFmt = '0.0%'
      c.border = { bottom: hair }; if (i % 2) c.fill = solid('FFF8FAFC')
    })
  })
  const last = 7 + hoja.lotes.length
  if (hoja.lotes.length) w2.addConditionalFormatting({ ref: `I8:I${last}`,
    rules: [{ type: 'dataBar', priority: 1, minLength: 0, maxLength: 100, gradient: false, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FFA9BEDD' } } as unknown as ExcelJSType.ConditionalFormattingRule] })
  w2.getCell(last + 2, 1).value = 'Cumplimiento = despachado ÷ contrato del lote completo, en TN (en unidades si ningún ítem del lote tiene peso).'
  w2.mergeCells(last + 2, 1, last + 2, cols2.length); w2.getCell(last + 2, 1).font = { size: 8, italic: true, color: { argb: MUTED } }
  return wb
}

export async function descargarAvanceExcel(hoja: HojaAvance) {
  const ExcelJS = (await import('exceljs')).default
  const logo = await fetch('/logo-jrm-sia.png').then(r => (r.ok ? r.arrayBuffer() : null)).then(b => (b ? new Uint8Array(b) : undefined), () => undefined)
  const wb = await buildAvanceWorkbook(ExcelJS, hoja, logo)
  const url = URL.createObjectURL(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a'); a.href = url; a.download = `Avance-contrato-OT-${hoja.meta.ot}.xlsx`; a.click(); URL.revokeObjectURL(url)
}
