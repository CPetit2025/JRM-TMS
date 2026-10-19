import type { Data, Filters } from './types';
export const code = (n: number) => 'HE-' + String(n).padStart(6, '0');
export const hours = (m: number | null | undefined) => m == null ? '—' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(m / 60) + ' h';
export const money = (v: number | null | undefined) => v == null ? 'Pendiente' : new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(v);
export const limaDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export function initialFilters(): Filters { const to = limaDate(); return { from: to.slice(0, 7) + '-01', to, area_id: '', site_id: '', cause_id: '', state: '', search: '' }; }
export function dateLabel(v: string | null | undefined) { if (!v)
    return '—'; return new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', ...(v.length > 10 ? { timeStyle: 'short' as const } : {}) }).format(new Date(v.length === 10 ? v + 'T12:00:00-05:00' : v)); }
export function reportEmail(d: Data) {
    const m = d.metrics, scope = d.areas.map(a => a.name).join(', ') || 'Sin ejecuciones validadas';
    return { subject: `JRM TMS | Informe de horas extras | ${dateLabel(d.from)} al ${dateLabel(d.to)}`,
        body: `GERENCIA DE LOGÍSTICA
Control de horas extras · Informe para Gerencia

Estimados:

Presentamos el informe de horas extras correspondiente al período del ${dateLabel(d.from)} al ${dateLabel(d.to)}.

Áreas con ejecuciones validadas: ${scope}.
• Horas validadas por RR. HH.: ${hours(m.validated_minutes)}.
${d.cost_visible ? '• Costo validado conocido: ' + money(m.validated_cost) + '.\n• Registros pendientes de valorización: ' + m.pending_cost + '.\n' : ''}• Horas ejecutadas pendientes de validación: ${hours(m.pending_minutes)}.
• Excepciones pendientes de revisión: ${m.pending_exceptions}.

El informe permite evaluar las causas operativas, la aprobación previa y las acciones correctivas. Las horas ejecutadas sin aprobación se conservan y se presentan como excepciones para evaluación.

Agradeceremos su revisión y las decisiones que correspondan sobre las causas recurrentes y las medidas propuestas.

Corte de información: ${dateLabel(d.generated_at)} (hora de Lima).
Se adjunta el reporte exportado desde JRM TMS.

Atentamente,` };
}
export function localInput(v: string) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(v)).replace(' ', 'T'); }
