import type { Data } from './types';
import { dateLabel, hours, money, code } from './core';
export async function exportReport(d: Data, format: 'pdf' | 'excel') {
    const name = `JRM_HHEE_${d.from}_${d.to}`;
    if (format === 'excel') {
        const { Workbook } = await import('exceljs');
        const wb = new Workbook();
        wb.creator = 'JRM TMS';
        const add = (title: string, headers: string[], rows: (string | number | null)[][]) => {
            const ws = wb.addWorksheet(title);
            ws.addRow(headers);
            rows.forEach(r => ws.addRow(r));
            ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002855' } };
            ws.views = [{ state: 'frozen', ySplit: 1 }];
            ws.columns.forEach((c, i) => c.width = i === 0 ? 22 : 28);
            ws.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } };
        };
        add('Resumen', ['Indicador', 'Valor'], [['Desde', d.from], ['Hasta', d.to], ['Corte Lima', dateLabel(d.generated_at)], ['Horas validadas', d.metrics.validated_minutes / 60], ['Horas pendientes de validación', d.metrics.pending_minutes / 60], ['Horas justificadas', (d.metrics.justified_minutes ?? 0) / 60], ['Horas mejorables', (d.metrics.improvable_minutes ?? 0) / 60], ['Horas por determinar', (d.metrics.unassessed_minutes ?? 0) / 60], ...(d.cost_visible ? [['Costo conocido PEN', d.metrics.validated_cost], ['Filas sin valorizar', d.metrics.pending_cost]] as (string | number | null)[][] : [])]);
        add('Áreas', ['Área', 'Horas validadas', ...(d.cost_visible ? ['Costo conocido PEN', 'Sin valorizar'] : []), 'Metas logradas', 'Metas definidas'], d.areas.map(a => [a.name, a.hours, ...(d.cost_visible ? [a.cost, a.pending_cost ?? 0] : []), a.targets_met ?? 0, a.targets_defined ?? 0]));
        add('Solicitudes', ['Código', 'Fecha', 'Área ejecutora', 'Área origen de la necesidad', 'Estado', 'Aprobación', 'Actividad', 'Referencia', 'Horas solicitadas', 'Horas aprobadas', 'Horas trabajadas', 'Horas validadas', 'Resultado', 'Evaluación', ...(d.cost_visible ? ['Costo validado conocido PEN', 'Filas sin valorizar'] : [])], d.rows.map(r => [code(r.sequence), r.work_date, r.area_name, r.origin_area_name || 'Por determinar', r.state, r.approval, r.activity, r.reference_code, r.planned_minutes / 60, r.approved_minutes / 60, r.actual_minutes / 60, r.validated_minutes == null ? null : r.validated_minutes / 60, r.result_text, r.assessment, ...(d.cost_visible ? [r.validated_cost, r.pending_cost] : [])]));
        add('Acciones', ['Área', 'Acción', 'Responsable', 'Vencimiento', 'Estado', 'Conclusión', 'Efectividad'], d.actions.map(a => [a.area_name, a.title, a.assigned_name, a.due_date, a.state, a.conclusion, a.effective == null ? 'Pendiente' : a.effective ? 'Efectiva' : 'No efectiva']));
        const buf = await wb.xlsx.writeBuffer();
        download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name + '.xlsx');
        return;
    }
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF();
    let y = 0;
    const header = () => { doc.setFillColor('#002855'); doc.rect(0, 0, 210, 30, 'F'); doc.setTextColor('#ffffff'); doc.setFontSize(17); doc.text('JRM TMS | Control de horas extras', 14, 13); doc.setFontSize(10); doc.text('GERENCIA DE LOGÍSTICA · INFORME GERENCIAL', 14, 22); doc.setTextColor('#172b4d'); y = 41; };
    const text = (v: string, size = 10) => { doc.setFontSize(size); const lines = doc.splitTextToSize(v, 180) as string[]; for (const line of lines) {
        if (y > 276) {
            doc.addPage();
            header();
        }
        doc.text(line, 14, y);
        y += size * 0.45 + 2;
    } y += 2; };
    header();
    text(`Período: ${dateLabel(d.from)} al ${dateLabel(d.to)} | Corte: ${dateLabel(d.generated_at)}`);
    text('Áreas: ' + (d.areas.map(a => a.name).join(', ') || 'Sin ejecuciones validadas'));
    text('Resultados validados', 13);
    text('Horas: ' + hours(d.metrics.validated_minutes));
    if (d.cost_visible) {
        text('Costo validado conocido: ' + money(d.metrics.validated_cost));
        text('Filas pendientes de valorización: ' + d.metrics.pending_cost);
    }
    text('Horas ejecutadas pendientes de validación: ' + hours(d.metrics.pending_minutes));
    text('Aprobación previa: ' + (d.metrics.executed_requests ? Math.round(100 * d.metrics.prior_requests / d.metrics.executed_requests) + '%' : 'Sin ejecuciones'));
    text('Excepciones pendientes de revisión: ' + d.metrics.pending_exceptions);
    text('Evaluación de necesidad: justificadas ' + hours(d.metrics.justified_minutes) + ' · mejorables ' + hours(d.metrics.improvable_minutes) + ' · por determinar ' + hours(d.metrics.unassessed_minutes));
    text('Causas operativas', 13);
    d.causes.forEach(c => text(c.name + ': ' + hours(c.hours * 60) + (d.cost_visible ? ' · ' + money(c.cost) : '')));
    text('Resultados por área', 13);
    d.areas.forEach(a => text(a.name + ': ' + hours(a.hours * 60) + ` · Metas logradas: ${a.targets_met}/${a.targets_defined}`));
    text('Acciones y decisiones requeridas', 13);
    if (d.actions_total > d.actions.length)
        text('Se muestran ' + d.actions.length + ' de ' + d.actions_total + ' acciones del alcance. Acote los filtros para el detalle completo.');
    if (!d.actions.length)
        text('No hay acciones registradas en el alcance consultado.');
    d.actions.forEach(a => text(`${a.area_name} | ${a.title}. Responsable: ${a.assigned_name}. Vence: ${dateLabel(a.due_date)}. Estado: ${a.state}.${a.conclusion ? ' Resultado: ' + a.conclusion : ''}`));
    text('Criterios de lectura', 13);
    text('El costo corresponde únicamente a importes conocidos y validados por RR. HH. No incluye importes pendientes. Las horas sin aprobación previa permanecen registradas y requieren evaluación independiente. La recurrencia no determina por sí sola la necesidad de las HHEE. Este reporte no sustituye el proceso de planillas ni determina descuentos o pagos.');
    for (let i = 1; i <= doc.getNumberOfPages(); i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.text('JRM TMS · Información de gestión · ' + i + '/' + doc.getNumberOfPages(), 14, 290);
    }
    doc.save(name + '.pdf');
}
function download(blob: Blob, name: string) { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
