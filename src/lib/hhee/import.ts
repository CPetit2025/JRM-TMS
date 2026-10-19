import * as XLSX from 'xlsx';
import type { AttendanceRow } from './types';
const cols = ['SOLICITUD', 'CODIGO_TRABAJADOR', 'INICIO', 'FIN', 'DESCANSO_MIN', 'HORAS_RECONOCIDAS', 'COSTO_PEN', 'RESULTADO', 'SUSTENTO', 'CONSENTIMIENTO'];
export function decimal(v: unknown, optional = false): number | null {
    if (v == null || String(v).trim() === '') {
        if (optional)
            return null;
        return 0;
    }
    const raw = String(v).trim().replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(raw))
        throw Error('Número inválido: ' + String(v));
    const n = Number(raw);
    if (!Number.isFinite(n))
        throw Error('Número inválido');
    return n;
}
export function localExcelTime(v: unknown, date1904 = false): string {
    if (typeof v === 'number') {
        const p = XLSX.SSF.parse_date_code(v, { date1904 });
        if (!p)
            throw Error('Fecha Excel inválida');
        return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.H).padStart(2, '0')}:${String(p.M).padStart(2, '0')}`;
    }
    const s = String(v ?? '').trim().replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s))
        throw Error('Use fechas Excel o AAAA-MM-DD HH:mm (hora de Lima)');
    const date = new Date(s + ':00-05:00');
    if (!Number.isFinite(date.getTime()) || new Date(date.getTime() - 5 * 3600000).toISOString().slice(0, 16) !== s)
        throw Error('Fecha inexistente');
    return s;
}
export async function parseAttendance(file: File): Promise<{
    rows: AttendanceRow[];
    file_name: string;
    file_hash: string;
}> {
    if (!/\.xlsx?$/i.test(file.name) || file.size > 10 * 1024 * 1024)
        throw Error('Seleccione un archivo Excel de hasta 10 MB.');
    const buf = await file.arrayBuffer(), wb = XLSX.read(buf, { type: 'array', cellDates: false }), sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    if (!grid.length || !cols.every(c => grid[0].includes(c)))
        throw Error('Use la plantilla de asistencia: faltan columnas obligatorias.');
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (raw.length < 1 || raw.length > 500)
        throw Error('Importe entre 1 y 500 filas.');
    const rows = raw.map((r, i) => {
        try {
            const consent = String(r.CONSENTIMIENTO).trim().toUpperCase();
            if (!['SI', 'NO', 'SIN_DATO', ''].includes(consent))
                throw Error('Consentimiento: SI, NO o SIN_DATO.');
            const request = String(r.SOLICITUD).trim().toUpperCase();
            if (!/^HE-\d+$/.test(request))
                throw Error('Solicitud: use HE-000001.');
            const recognized = decimal(r.HORAS_RECONOCIDAS, true);
            if (recognized !== null && Math.abs(recognized * 60 - Math.round(recognized * 60)) > 0.001)
                throw Error('Las horas reconocidas deben expresarse con precisión de minutos.');
            const rest = decimal(r.DESCANSO_MIN) ?? 0;
            if (!Number.isInteger(rest))
                throw Error('El descanso se registra en minutos enteros.');
            return { request_code: request, person_code: String(r.CODIGO_TRABAJADOR).trim().toUpperCase(), start: localExcelTime(r.INICIO, !!wb.Workbook?.WBProps?.date1904), end: localExcelTime(r.FIN, !!wb.Workbook?.WBProps?.date1904), break_minutes: rest, recognized_minutes: recognized == null ? null : Math.round(recognized * 60), cost: decimal(r.COSTO_PEN, true), consent: consent === 'SI', result: String(r.RESULTADO).trim(), evidence: String(r.SUSTENTO).trim() };
        }
        catch (e) {
            throw Error('Fila ' + (i + 2) + ': ' + (e instanceof Error ? e.message : 'Datos inválidos'));
        }
    });
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return { rows, file_name: file.name, file_hash: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') };
}
export function attendanceTemplate() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols]), 'Asistencia');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['INSTRUCCIONES'], ['Una fila por solicitud y trabajador. Solo intervalos de HHEE; no la jornada completa.'],
        ['INICIO / FIN: fecha Excel con hora o AAAA-MM-DD HH:mm, hora de Lima.'],
        ['Si no trabajó HHEE: INICIO igual a FIN, descanso 0, horas reconocidas 0 y costo 0 o vacío.'],
        ['HORAS_RECONOCIDAS y COSTO_PEN: dejar vacíos si están pendientes. El costo es total de esa fila, no una tarifa.'],
        ['CONSENTIMIENTO: SI, NO o SIN_DATO. SIN_DATO exige revisión; no se presume consentimiento.'],
        ['SOLICITUD: HE-000001. CODIGO_TRABAJADOR: código del directorio HHEE.'],
        ['RESULTADO y SUSTENTO: no incluya remuneraciones ni datos sensibles ajenos a este proceso.'],
    ]), 'Instrucciones');
    XLSX.writeFile(wb, 'JRM_HHEE_Plantilla_RRHH.xlsx');
}
