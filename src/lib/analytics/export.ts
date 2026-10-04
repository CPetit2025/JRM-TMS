import { formatValue, type Dataset, type Filters } from './model'

export function exportRows(d: Dataset) {
  return d.rows.map(r => ({ Código: r.code, Fecha: r.date, Estado: r.status, Cliente: r.client, Contrato: r.contract,
    Unidad: r.plate, Conductor: r.driver, Ruta: r.route, Sede: r.site, ...r.detail, ...r.values }))
}
export async function exportReport(kind: 'excel' | 'pdf', title: string, f: Filters, d: Dataset, previous?: Dataset | null) {
  const generated = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })
  const meta = { Reporte: title, Desde: f.from, Hasta: f.to, Comparación: f.compare, Fuente: d.source, 'Fecha utilizada': d.basis,
    'Generado (Lima)': generated, 'Corte de fuente': d.cutoff || '', Registros: d.rows.length, Notas: d.note || '', ...Object.fromEntries(Object.entries(f).filter(([k, v]) => v && !['from', 'to', 'compare'].includes(k))) }
  const metrics = d.metrics.map(m => ({ Indicador: m.label, Valor: m.value, Unidad: m.unit, Fórmula: m.formula,
    Comparación: previous?.metrics.find(x => x.key === m.key)?.value ?? null }))
  const name = `SCM_${title}_${f.from}_${f.to}`
  if (kind === 'excel') {
    const { exportAptXlsx } = await import('@/lib/apt/export')
    exportAptXlsx(name, { Contexto: [meta], Indicadores: metrics, Detalle: exportRows(d), ...(previous ? { Comparacion: exportRows(previous) } : {}) })
    return
  }
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ orientation: 'landscape', format: 'a4' })
  let y = 18
  const write = (line: string, bold = false) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(bold ? 12 : 9)
    const lines: string[] = pdf.splitTextToSize(line.replaceAll('→', '->').replaceAll('−', '-'), 265)
    for (const text of lines) {
      if (y > 190) { pdf.addPage(); y = 18 }
      pdf.text(text, 14, y); y += 5
    }
  }
  write(`JRM | Reportes y Analítica · ${title}`, true)
  write(`${f.from} a ${f.to} · Generado: ${generated} (Lima)`)
  write(`Fuente: ${d.source} · Base: ${d.basis}`)
  write(`Filtros: ${Object.entries(f).filter(([k, v]) => v && !['from', 'to'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ')}`)
  if (d.note) write(d.note)
  for (const m of d.metrics) {
    const prev = previous?.metrics.find(x => x.key === m.key)
    write(`${m.label}: ${formatValue(m.value, m.unit)}${prev ? ` · comparación: ${formatValue(prev.value, prev.unit)}` : ''}`, true)
    write(m.formula)
  }
  write(`Detalle completo (${d.rows.length} registros)`, true)
  for (const r of exportRows(d)) write(Object.entries(r).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${v}`).join(' | '))
  if (previous) {
    write(`Detalle de comparación (${previous.rows.length} registros)`, true)
    for (const r of exportRows(previous)) write(Object.entries(r).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${v}`).join(' | '))
  }
  const pages = pdf.getNumberOfPages()
  for (let i = 1; i <= pages; i++) { pdf.setPage(i); pdf.setFontSize(8); pdf.text(`${i} / ${pages}`, 275, 203) }
  pdf.save(`${name}.pdf`)
}
