/** Reports consume the same authorized operational snapshot as the dashboard.
 * No inference of physical reconciliation, availability or delivery conformity. */
import type { AptOperationalFilters, AptOperationalSummary } from './types'
export type OperationalReportSource = AptOperationalSummary

export type OperationalReportKind = 'executive' | 'operational'
export interface OperationalReportMetric { label: string; value: number | null; unit: string; formula: string }
export interface OperationalReportFinding { title: string; evidence: string; action: string }
export interface OperationalReport {
  kind: OperationalReportKind; title: string; generatedAt: string; cutoff: string | null
  source: string; basis: string; filters: string; coverage: string; freshness: string; version: string; period: string; ageBasis: string
  metrics: OperationalReportMetric[]; findings: OperationalReportFinding[]; limitations: string[]
  detailScope: string; rows: Array<Omit<OperationalReportSource['rows'][number], 'stock_tn'> & { stock_tn: number | null }>; series: Array<{ fecha: string; stock_tn: number | null; production_tn: number | null; dispatch_tn: number | null }>
  warehouses: Array<{ almacen: string; stock_tn: number | null; inferred_opening_tn: number | null }>; coverageRows: OperationalReportSource['coverage']; total: number; offset: number
}

const text = (value: unknown) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 2000)
const finite = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? n : null

/** Sequential authorized pages with a pinned cutoff/window and an invariant snapshot.
 * Metrics remain server totals; never sum rounded detail rows into new indicators. */
export async function loadCompleteOperationalReportSource(
  original: OperationalReportSource,
  fetchPage: (filters: AptOperationalFilters, limit: number, offset: number) => Promise<OperationalReportSource>,
  onProgress?: (loaded: number, total: number) => void,
  maxRows = 10000,
): Promise<OperationalReportSource> {
  if (!original.meta.model_fresh) throw new Error('Actualice el modelo antes de cargar el reporte completo.')
  if (!Number.isSafeInteger(original.total) || original.total < 0) throw new Error('El total del reporte es inválido.')
  if (original.total > maxRows) throw new Error(`El reporte completo admite hasta ${maxRows} registros. Acote los filtros; el detalle parcial disponible se mantiene identificado.`)
  if (!original.meta.cutoff || !original.meta.version) throw new Error('No se puede fijar la versión y el corte del reporte.')
  const filters: AptOperationalFilters = { ...original.filters, cutoff: original.meta.cutoff, ...(original.meta.desde ? { desde: original.meta.desde } : {}), ...(original.meta.hasta ? { hasta: original.meta.hasta } : {}) }
  const rows: OperationalReportSource['rows'] = [], seen = new Set<string>()
  onProgress?.(0, original.total)
  while (rows.length < original.total) {
    const page = await fetchPage(filters, 100, rows.length)
    if (page.schema_version !== original.schema_version || !page.meta.model_fresh || page.meta.version !== original.meta.version || page.meta.cutoff !== original.meta.cutoff || page.meta.desde !== original.meta.desde || page.meta.hasta !== original.meta.hasta || page.total !== original.total || JSON.stringify(page.kpis) !== JSON.stringify(original.kpis)) throw new Error('La información cambió durante la carga. Actualice el análisis y vuelva a preparar el reporte.')
    if (page.offset !== rows.length || !page.rows.length || page.rows.length > 100 || rows.length + page.rows.length > original.total) throw new Error('La paginación del reporte no es consistente. Actualice el análisis.')
    for (const row of page.rows) {
      const key = JSON.stringify([row.almacen, row.lote])
      if (seen.has(key)) throw new Error('Se detectó un lote/ubicación repetido durante la carga. Actualice el análisis.')
      seen.add(key); rows.push({ ...row })
    }
    onProgress?.(rows.length, original.total)
  }
  return { ...original, filters, rows, offset: 0, limit: rows.length }
}
export function operationalReportValue(n: number | null | undefined, unit = '') {
  const value = finite(n)
  return value === null ? 'No evaluable' : `${new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ''}`
}

export function buildOperationalReport(source: OperationalReportSource, filters: object = {}, kind: OperationalReportKind = 'executive', now = new Date()): OperationalReport {
  if (source.schema_version !== 1) throw new Error('Versión de datos incompatible con el reporte.')
  if (!Number.isSafeInteger(source.total) || source.total < 0 || !Number.isSafeInteger(source.offset) || source.offset < 0) throw new Error('Alcance de detalle inválido.')
  const k = source.kpis
  const metrics: OperationalReportMetric[] = [
    { label: 'Saldo documental reconstruido', value: finite(k.stock_tn), unit: 'TN', formula: 'Saldo del modelo de flujo por almacén al corte; no certifica existencia física.' },
    { label: 'Saldo procedente de apertura inferida', value: finite(k.inferred_opening_tn), unit: 'TN', formula: 'Parte del saldo actual procedente de un origen inicial inferido; no representa toda la apertura histórica y requiere conciliación con ERP.' },
    { label: 'Antigüedad ponderada con origen conocido', value: finite(k.weighted_age_days), unit: 'días', formula: 'Σ(TN con origen conocido × edad) / Σ(TN con origen conocido).' },
    { label: 'Saldo con origen desconocido', value: finite(k.unknown_origin_stock_tn), unit: 'TN', formula: 'Saldo cuya fecha de origen no se puede verificar; excluido de antigüedad de origen.' },
    { label: 'Saldo con origen conocido', value: finite(k.known_origin_stock_tn), unit: 'TN', formula: 'Saldo con fecha de origen disponible para calcular la antigüedad.' },
    { label: 'Carga de permanencia del saldo conocido', value: finite(k.stock_tn_days), unit: 'TN × días', formula: 'Σ(TN con origen conocido × edad) al corte; no es costo ni ocupación histórica acumulada.' },
    { label: 'Producción del período', value: finite(k.production_tn), unit: 'TN', formula: 'Entradas de producción documental en el período seleccionado; excluye traspasos.' },
    { label: 'Despacho documental del período', value: finite(k.dispatch_tn), unit: 'TN', formula: 'Salidas documentales por despacho en el período; no equivale a entrega conforme.' },
    { label: 'Consumo del período', value: finite(k.consumption_tn), unit: 'TN', formula: 'Salidas por consumo del período, separadas de despachos externos.' },
    { label: 'Devoluciones del período', value: finite(k.returns_tn), unit: 'TN', formula: 'Entradas identificadas como devolución en el período.' },
    { label: 'Inventario promedio del período', value: finite(k.average_stock_tn), unit: 'TN', formula: 'Promedio de saldos diarios reconstruidos del período seleccionado.' },
    { label: 'Rotación documental del período', value: finite(k.turnover), unit: 'veces', formula: 'Despachos documentales del período / inventario promedio del mismo período.' },
    { label: 'Días observados del período', value: finite(k.observed_days), unit: 'días', formula: 'Días incluidos en la reconstrucción; no garantiza cobertura completa del ERP.' },
  ]
  const findings: OperationalReportFinding[] = []
  if (!source.meta.model_fresh) findings.push({ title: 'Modelo pendiente de actualización', evidence: `Última carga aplicada: ${text(source.meta.latest_applied_at) || 'Sin dato'}. Recálculo: ${text(source.meta.flow_rebuilt_at) || 'Sin dato'}.`, action: 'Completar el recálculo antes de tomar decisiones basadas en estos saldos.' })
  if ((finite(k.inferred_opening_tn) ?? 0) > 0) findings.push({ title: 'Apertura pendiente de conciliación', evidence: `${operationalReportValue(k.inferred_opening_tn, 'TN')} de saldo procedente de apertura inferida.`, action: 'Comparar con la existencia inicial del ERP y documentar las diferencias.' })
  if ((finite(k.unknown_origin_stock_tn) ?? 0) > 0) findings.push({ title: 'Antigüedad parcialmente evaluable', evidence: `${operationalReportValue(k.unknown_origin_stock_tn, 'TN')} sin fecha de origen verificable.`, action: 'Investigar ingresos y documentos históricos; conservar este peso fuera de la antigüedad conocida.' })
  if ((finite(source.quality.missing_weight_rows) ?? 0) > 0) findings.push({ title: 'Movimientos con peso pendiente', evidence: `${operationalReportValue(source.quality.missing_weight_rows)} registros sin peso utilizable.`, action: 'Completar el peso desde una fuente verificable; no interpretar ausencia de peso como cero transportado.' })
  if ((finite(source.quality.temporal_anomaly_rows) ?? 0) > 0) findings.push({ title: 'Secuencia temporal por revisar', evidence: `${operationalReportValue(source.quality.temporal_anomaly_rows)} anomalías temporales reportadas.`, action: 'Verificar fechas, apertura y relación entre movimientos antes de aceptar su trazabilidad.' })
  if (!source.meta.composition_available) findings.push({ title: 'Composición histórica no disponible', evidence: 'La apertura inferida y la antigüedad de origen no son evaluables para este corte.', action: 'Conservar estos indicadores como no evaluables; no sustituirlos por cero ni por edad de almacén.' })
  if (source.quality.negative_balance_rows > 0) findings.push({ title: 'Saldos negativos por investigar', evidence: `${operationalReportValue(source.quality.negative_balance_rows)} saldos negativos reportados.`, action: 'Revisar cobertura, documentos, fechas y apertura; no compensar automáticamente con producción ficticia.' })
  if (!findings.length) findings.push({ title: 'Sin alertas en las comprobaciones disponibles', evidence: 'El snapshot no reporta las excepciones evaluadas de peso, origen, secuencia y actualización.', action: 'Mantener la conciliación con ERP y controles físicos; ausencia de alertas no equivale a certificación de inventario.' })
  const allRows = source.rows.map(r => ({ ...r, almacen: text(r.almacen), lote: text(r.lote), cliente: r.cliente === null ? null : text(r.cliente), stock_tn: finite(r.stock_tn), inferred_opening_tn: finite(r.inferred_opening_tn), age_days: finite(r.age_days), stock_tn_days: finite(r.stock_tn_days) }))
  const rows = kind === 'executive' ? allRows.slice(0, 10) : allRows
  const complete = source.offset === 0 && rows.length === source.total
  return {
    kind, title: kind === 'executive' ? 'Informe ejecutivo de APT' : 'Informe operativo de APT',
    generatedAt: now.toLocaleString('es-PE', { timeZone: 'America/Lima' }), cutoff: source.meta.cutoff,
    source: 'JRM TMS · apt_operational_summary · movimientos ERP y modelo de flujo', basis: text(source.meta.calculation_basis),
    version: text(source.meta.version), period: `${source.meta.desde || 'Sin dato'} a ${source.meta.hasta || 'Sin dato'}`, ageBasis: source.meta.age_basis,
    filters: Object.entries({ ...filters, ...source.filters }).filter(([key, v]) => !['limit', 'offset'].includes(key) && v != null && v !== '' && (!Array.isArray(v) || v.length)).map(([key, v]) => `${key}: ${text(Array.isArray(v) ? v.join(', ') : v)}`).join(' · ') || 'Sin filtros adicionales',
    coverage: `${text(source.meta.data_min) || 'Sin dato'} a ${text(source.meta.data_max) || 'Sin dato'} · Fechas de movimientos cargados; no acredita continuidad.`,
    freshness: source.meta.model_fresh ? 'Modelo actualizado respecto de las cargas aplicadas.' : 'Modelo pendiente de actualización; revisar antes de decidir.',
    metrics, findings,
    limitations: ['Inventario documental reconstruido: no sustituye la conciliación física ni una apertura confirmada.', 'Despacho documental no acredita llegada, conformidad de entrega ni cierre documental.', 'No se infiere disponibilidad, bloqueo o responsable cuando el dato operativo no existe.', 'Los indicadores abarcan el alcance filtrado del servidor; el detalle puede representar solo una página.'],
    detailScope: complete ? `Detalle completo del alcance filtrado: ${rows.length} registros.` : `Detalle parcial: ${rows.length} de ${source.total} registros; ${rows.length ? `posiciones ${source.offset + 1} a ${source.offset + rows.length}` : 'sin filas incluidas'}. Los indicadores y las series no se recalculan a partir de esta selección.`,
    rows, series: source.series.map(r => ({ fecha: text(r.fecha), stock_tn: finite(r.stock_tn), production_tn: finite(r.production_tn), dispatch_tn: finite(r.dispatch_tn) })),
    warehouses: source.warehouses.map(r => ({ almacen: text(r.almacen), stock_tn: finite(r.stock_tn), inferred_opening_tn: finite(r.inferred_opening_tn) })), coverageRows: source.coverage.map(r => ({ ...r })), total: source.total, offset: source.offset,
  }
}

export function operationalReportEmail(report: OperationalReport) {
  return {
    subject: `JRM | ${report.title} | Corte ${report.cutoff || 'sin fecha'}`,
    body: ['GERENCIA DE LOGÍSTICA', report.title, '', 'Estimados:', '',
      `Compartimos el análisis de APT con corte al ${report.cutoff || 'corte no disponible'}, preparado con la información documental registrada en JRM TMS.`,
      `Alcance: ${report.filters}`, `Actualización: ${report.freshness}`, '',
      ...report.metrics.slice(0, 6).map(m => `${m.label}: ${operationalReportValue(m.value, m.unit)}`), '',
      'Hallazgos y acciones:', ...report.findings.map(f => `• ${f.title}. ${f.evidence} Acción: ${f.action}`), '',
      report.detailScope, 'Los saldos son una reconstrucción documental y requieren conciliación con ERP e inventario físico.',
      '', 'El reporte PDF o Excel puede adjuntarse después de su revisión.', '', 'Atentamente,'].join('\n'),
  }
}

export function operationalReportSheets(report: OperationalReport) {
  return {
    Contexto: Object.entries({ Reporte: report.title, 'Generado (Lima)': report.generatedAt, Corte: report.cutoff, Período: report.period, Versión: report.version, 'Base de antigüedad': report.ageBasis, Fuente: report.source, Base: report.basis, Filtros: report.filters, Cobertura: report.coverage, Actualización: report.freshness, Detalle: report.detailScope }).map(([Campo, Valor]) => ({ Campo, Valor })),
    Indicadores: report.metrics.map(m => ({ Indicador: m.label, Valor: m.value, Unidad: m.unit, Fórmula: m.formula })),
    Hallazgos: report.findings.map(f => ({ Hallazgo: f.title, Evidencia: f.evidence, Acción: f.action })),
    Limitaciones: report.limitations.map(l => ({ Limitación: l })),
    Cobertura: report.coverageRows.map(r => ({ Movimiento: r.kind, Desde: r.desde, Hasta: r.hasta, Registros: r.rows, 'Sin peso': r.missing_weight_rows })),
    Almacenes: report.warehouses.map(r => ({ Almacén: r.almacen, 'Saldo TN': r.stock_tn, 'Saldo de origen inferido TN': r.inferred_opening_tn })),
    Serie: report.series.map(r => ({ Fecha: r.fecha, 'Saldo TN': r.stock_tn, 'Producción TN': r.production_tn, 'Despacho documental TN': r.dispatch_tn })),
    Detalle: report.rows.map(r => ({ Almacén: r.almacen, Lote: r.lote, Cliente: r.cliente, 'Saldo TN': r.stock_tn, 'Saldo de origen inferido TN': r.inferred_opening_tn, 'Edad días': r.age_days, 'TN × días': r.stock_tn_days })),
  }
}

export async function exportOperationalReport(report: OperationalReport, format: 'pdf' | 'excel') {
  const filename = `JRM_APT_${report.kind}_${(report.cutoff || 'sin_corte').replace(/[^\w-]/g, '')}`
  if (format === 'excel') {
    const { Workbook } = await import('exceljs')
    const workbook = new Workbook(); workbook.creator = 'JRM TMS'; workbook.created = new Date()
    for (const [name, records] of Object.entries(operationalReportSheets(report))) {
      const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
      const headers = records.length ? Object.keys(records[0]) : ['Información']
      sheet.columns = headers.map(h => ({ header: h, key: h, width: ['Fórmula', 'Evidencia', 'Acción', 'Limitación', 'Valor'].includes(h) ? 65 : 28 }))
      for (const record of records) sheet.addRow(record)
      if (!records.length) sheet.addRow({ Información: 'Sin registros incluidos; consultar alcance en Contexto.' })
      sheet.getRow(1).height = 26
      sheet.getRow(1).eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002855' } }; cell.font = { color: { argb: 'FFFFFFFF' }, bold: true } })
      sheet.eachRow((row, n) => { if (n > 1) row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; if (typeof cell.value === 'number') cell.numFmt = '#,##0.00'; if (n % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } } }) })
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(sheet.rowCount, 1), column: headers.length } }
    }
    const buffer = await workbook.xlsx.writeBuffer()
    const url = URL.createObjectURL(new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${filename}.xlsx`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return
  }
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ format: 'a4' }); let y = 40
  const header = () => {
    pdf.setFillColor(0, 40, 85); pdf.rect(0, 0, 210, 28, 'F'); pdf.setTextColor(255, 255, 255)
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text('JRM TMS | GERENCIA DE LOGISTICA', 15, 12)
    pdf.setFontSize(10); pdf.text(report.title, 15, 21); pdf.setTextColor(30, 41, 59)
  }
  header()
  const line = (value: string, bold = false) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(bold ? 10 : 9)
    const lines: string[] = pdf.splitTextToSize(value.replaceAll('Σ', 'Sum').replaceAll('×', 'x').replaceAll('→', '->').replaceAll('•', '-'), 180)
    for (const part of lines) { if (y > 275) { pdf.addPage(); header(); y = 38 } pdf.text(part, 15, y); y += 5 }
    y += bold ? 2 : 1
  }
  line(`Generado: ${report.generatedAt} (Lima) | Corte: ${report.cutoff || 'Sin dato'}`)
  line(`Fuente: ${report.source}`); line(`Base: ${report.basis} | Antigüedad: ${report.ageBasis}`); line(`Período: ${report.period} | Versión: ${report.version}`); line(`Filtros: ${report.filters}`)
  line(`Cobertura: ${report.coverage}`); line(report.freshness, true)
  if (report.series.length) {
    line('Evolución documental del período (TN)', true)
    if (y > 190) { pdf.addPage(); header(); y = 38 }
    const left = 25, top = y + 3, width = 170, height = 45
    const numbers = report.series.flatMap(r => [r.stock_tn, r.production_tn, r.dispatch_tn]).filter((n): n is number => n !== null)
    const min = Math.min(0, ...numbers), max = Math.max(1, ...numbers), span = max - min
    pdf.setDrawColor(203, 213, 225); pdf.setLineWidth(0.2)
    pdf.line(left, top, left, top + height); pdf.line(left, top + height, left + width, top + height)
    pdf.setFontSize(7); pdf.text(operationalReportValue(max), 15, top + 2); pdf.text(operationalReportValue(min), 15, top + height)
    const seriesKeys = [ ['stock_tn', [0, 40, 85], 'Saldo'], ['production_tn', [5, 150, 105], 'Producción'], ['dispatch_tn', [217, 119, 6], 'Despacho ERP'] ] as const
    for (const [key, color, label] of seriesKeys) {
      pdf.setDrawColor(color[0], color[1], color[2]); pdf.setLineWidth(0.6)
      report.series.forEach((r, i) => {
        const value = r[key], prior = report.series[i - 1]?.[key]
        if (value === null) return
        const x = left + (i / Math.max(report.series.length - 1, 1)) * width, pointY = top + height - ((value - min) / span) * height
        if (i && prior !== null && prior !== undefined) pdf.line(left + ((i - 1) / Math.max(report.series.length - 1, 1)) * width, top + height - ((prior - min) / span) * height, x, pointY)
        else pdf.circle(x, pointY, 0.5, 'S')
      })
      pdf.setTextColor(color[0], color[1], color[2]); pdf.text(label, left + seriesKeys.findIndex(s => s[0] === key) * 55, top + height + 12)
    }
    pdf.setTextColor(30, 41, 59); pdf.text(report.series[0].fecha, left, top + height + 5); pdf.text(report.series[report.series.length - 1].fecha, left + width - 20, top + height + 5)
    y = top + height + 22
  }
  line('Indicadores del alcance seleccionado', true)
  for (const m of report.metrics) { line(`${m.label}: ${operationalReportValue(m.value, m.unit)}`, true); line(m.formula) }
  line('Hallazgos y acciones', true)
  for (const f of report.findings) { line(f.title, true); line(f.evidence); line(`Acción: ${f.action}`) }
  line('Saldos por almacén', true)
  for (const r of report.warehouses) line(`${r.almacen}: ${operationalReportValue(r.stock_tn, 'TN')} | Saldo de origen inferido: ${operationalReportValue(r.inferred_opening_tn, 'TN')}`)
  line('Detalle documental incluido', true); line(report.detailScope)
  for (const r of report.rows) line(`${r.almacen} | ${r.lote} | ${r.cliente || 'Cliente sin dato'} | Saldo ${operationalReportValue(r.stock_tn, 'TN')} | Edad ${operationalReportValue(r.age_days, 'días')}`)
  line('Limitaciones de lectura', true); report.limitations.forEach(l => line(l))
  const pages = pdf.getNumberOfPages()
  for (let page = 1; page <= pages; page++) { pdf.setPage(page); pdf.setFontSize(8); pdf.setTextColor(100, 116, 139); pdf.text(`JRM TMS · Documento de análisis · ${page} / ${pages}`, 15, 288) }
  pdf.save(`${filename}.pdf`)
}
