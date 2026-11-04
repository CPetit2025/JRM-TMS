export type MaintenanceReportKind = 'PREVIO' | 'CIERRE'

export interface MaintenanceReportOrder {
  id: string
  ot_code: string
  status: string
  order_type: string
  priority: string
  description: string
  diagnostic: string | null
  activities_performed: string | null
  vehicle_plate: string
  vehicle_type?: string | null
  vehicle_status?: string | null
  plan_name?: string | null
  provider_name?: string | null
  responsible_name?: string | null
  mechanic_name?: string | null
  start_date?: string | null
  estimated_end_date?: string | null
  downtime_hours?: number | null
  total_cost?: number | null
  release_result?: { eligibility?: { status?: string; motives?: string[] } } | null
  created_at?: string
  closed_at?: string | null
  warranty_decision?: string | null
  warranty_notes?: string | null
}

export interface MaintenanceReportCost {
  cost_type: string
  amount: number
  quantity?: number | null
  description?: string | null
  document_number?: string | null
}

export async function buildMaintenanceWorkOrderReport(
  order: MaintenanceReportOrder,
  costs: MaintenanceReportCost[],
  kind: MaintenanceReportKind,
) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const now = new Date()
  const snapshot = {
    report_type: kind,
    issued_at: now.toISOString(),
    work_order: order,
    costs,
  }
  let y = 18
  const left = 16
  const width = 178
  const dateText = now.toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })

  const line = (title: string, value: unknown, strong = false) => {
    const text = `${title}: ${value == null || value === '' ? 'No registrado' : String(value)}`
    pdf.setFont('helvetica', strong ? 'bold' : 'normal')
    pdf.setFontSize(9)
    const wrapped = pdf.splitTextToSize(text, width)
    if (y + wrapped.length * 5 > 278) { pdf.addPage(); y = 18 }
    pdf.text(wrapped, left, y)
    y += wrapped.length * 5 + 1.5
  }
  const heading = (title: string) => {
    if (y > 270) { pdf.addPage(); y = 18 }
    y += 3
    pdf.setFillColor(0, 40, 85)
    pdf.roundedRect(left, y - 4, width, 8, 1.5, 1.5, 'F')
    pdf.setTextColor(255, 255, 255)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(10)
    pdf.text(title, left + 3, y + 1.5)
    pdf.setTextColor(20, 35, 55)
    y += 11
  }

  pdf.setFillColor(0, 40, 85)
  pdf.rect(0, 0, 210, 36, 'F')
  pdf.setTextColor(255, 255, 255)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(15)
  pdf.text(kind === 'PREVIO' ? 'INFORME TÉCNICO PREVIO' : 'INFORME TÉCNICO DE CIERRE', left, 17)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(9)
  pdf.text(`${order.ot_code}  ·  Unidad ${order.vehicle_plate}  ·  Versión emitida ${dateText}`, left, 26)
  pdf.setTextColor(20, 35, 55)
  y = 46

  heading('1. Identificación de la intervención')
  line('Orden de trabajo', order.ot_code, true)
  line('Fecha de emisión', dateText)
  line('Tipo / prioridad', `${order.order_type} / ${order.priority}`)
  line('Unidad', `${order.vehicle_plate}${order.vehicle_type ? ` · ${order.vehicle_type}` : ''}`)
  line('Estado de OT', order.status)
  line('Origen', order.plan_name ? `Preventivo · ${order.plan_name}` : 'Correctivo / manual')
  line('Responsable', order.responsible_name)
  line('Taller o proveedor', order.provider_name)
  line('Mecánico asignado', order.mechanic_name)
  line('Programación', `${order.start_date || 'Sin fecha'} a ${order.estimated_end_date || 'sin fecha fin estimada'}`)

  heading(kind === 'PREVIO' ? '2. Evaluación y alcance propuesto' : '2. Diagnóstico y trabajos ejecutados')
  line('Descripción del requerimiento', order.description)
  line(kind === 'PREVIO' ? 'Evaluación técnica preliminar' : 'Diagnóstico técnico', order.diagnostic)
  if (kind === 'CIERRE') line('Actividades realizadas', order.activities_performed)
  line('Condición operativa al emitir', order.vehicle_status)
  if (kind === 'CIERRE') {
    line('Horas fuera de servicio', order.downtime_hours == null ? null : `${Number(order.downtime_hours).toFixed(2)} h`)
    line('Resultado de elegibilidad', order.release_result?.eligibility?.status)
    line('Observaciones de elegibilidad', order.release_result?.eligibility?.motives?.join('; '))
    line('Revisión de garantía', order.warranty_decision)
    line('Sustento de garantía', order.warranty_notes)
  }

  heading(kind === 'PREVIO' ? '3. Costos registrados para la intervención' : '3. Costos reales de la intervención')
  if (costs.length) {
    costs.forEach((cost, index) => {
      const amount = `S/ ${Number(cost.amount || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      line(`${index + 1}. ${cost.cost_type.replace(/_/g, ' ')}`, `${amount}${cost.quantity ? ` · cantidad ${cost.quantity}` : ''}${cost.description ? ` · ${cost.description}` : ''}${cost.document_number ? ` · documento ${cost.document_number}` : ''}`)
    })
  } else line('Detalle', 'No hay líneas de costo registradas')
  line('Costo acumulado de OT', `S/ ${Number(order.total_cost || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, true)

  heading('4. Trazabilidad y validación')
  line('Fecha de apertura', order.created_at ? new Date(order.created_at).toLocaleString('es-PE') : null)
  if (kind === 'CIERRE') line('Fecha de cierre', order.closed_at ? new Date(order.closed_at).toLocaleString('es-PE') : null)
  line('Estado del informe', kind === 'PREVIO' ? 'Documento emitido con los datos disponibles a la fecha' : 'Documento emitido después del cierre técnico de la OT')
  pdf.setFontSize(8)
  pdf.setTextColor(90, 100, 115)
  pdf.text('Documento generado por JRM-TMS. La versión y su evidencia PDF quedan registradas en el expediente de la OT.', left, Math.min(y + 5, 286))

  return { blob: pdf.output('blob') as Blob, snapshot }
}
