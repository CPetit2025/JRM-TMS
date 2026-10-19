import * as XLSX from 'xlsx';
import type { AttendanceRow, Area, RemunerationConcept } from './types';
const required = ['SOLICITUD', 'CODIGO_TRABAJADOR', 'INICIO', 'FIN', 'DESCANSO_MIN', 'HORAS_RECONOCIDAS', 'RESULTADO', 'SUSTENTO', 'CONSENTIMIENTO'];
const categoryCols = ['HORAS_25', 'HORAS_35', 'HORAS_100'];
const cols = [...required.slice(0, 6), 'HORAS_NORMALES', ...categoryCols, ...required.slice(6)];
export function hourMinutes(value: unknown, optional = true): number | null {
    const n = decimal(value, optional);
    if (n === null) return null;
    if (n > 16 || Math.abs(n * 60 - Math.round(n * 60)) > 0.001) throw Error('Use horas de 0 a 16 con precisión de minutos.');
    return Math.round(n * 60);
}
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
    if (!grid.length || !required.every(c => grid[0].includes(c)))
        throw Error('Use la plantilla de asistencia: faltan columnas obligatorias.');
    const categorized = categoryCols.some(c => grid[0].includes(c));
    if (categorized && !categoryCols.every(c => grid[0].includes(c))) throw Error('Incluya las tres columnas HORAS_25, HORAS_35 y HORAS_100.');
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
            const cat = categorized ? categoryCols.map(c => { const m = hourMinutes(r[c]); if (m === null) throw Error('Complete cada categoría; use 0 si no aplica.'); return m; }) : null;
            const recognized = hourMinutes(r.HORAS_RECONOCIDAS) ?? (cat ? cat.reduce((a, b) => a + b, 0) : null);
            if (cat && cat.reduce((a, b) => a + b, 0) !== recognized) throw Error('25% + 35% + 100% debe sumar las horas extras reconocidas.');
            if (categorized && decimal(r.COSTO_PEN, true) !== null) throw Error('Quite COSTO_PEN: el costo se calcula desde la ficha del trabajador.');
            const rest = decimal(r.DESCANSO_MIN) ?? 0;
            if (!Number.isInteger(rest))
                throw Error('El descanso se registra en minutos enteros.');
            return { request_code: request, person_code: String(r.CODIGO_TRABAJADOR).trim().toUpperCase(), start: localExcelTime(r.INICIO, !!wb.Workbook?.WBProps?.date1904), end: localExcelTime(r.FIN, !!wb.Workbook?.WBProps?.date1904), break_minutes: rest, recognized_minutes: recognized, normal_minutes: hourMinutes(r.HORAS_NORMALES), minutes_25: cat?.[0] ?? null, minutes_35: cat?.[1] ?? null, minutes_100: cat?.[2] ?? null, cost: decimal(r.COSTO_PEN, true), consent: consent === 'SI', result: String(r.RESULTADO).trim(), evidence: String(r.SUSTENTO).trim() };
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
        ['Si no trabajó HHEE: INICIO igual a FIN, descanso 0, horas reconocidas y las tres categorías en 0.'],
        ['HORAS_25 / HORAS_35 / HORAS_100: complete las tres; use 0 si no aplica. No se distribuyen automáticamente por ley.'],
        ['La suma debe coincidir con HORAS_RECONOCIDAS. Si esta última queda vacía se usa la suma de las tres categorías.'],
        ['HORAS_NORMALES: opcional, solo referencia. Registrar una sola vez por trabajador y fecha; no suma como HHEE.'],
        ['Costo APROXIMADO: tarifa base de la ficha x (H25 x 1.25 + H35 x 1.35 + H100 x 2). No ingrese costos en asistencia.'],
        ['La tarifa se obtiene de los conceptos mensuales computables / horas mensuales de referencia de la ficha.'],
        ['CONSENTIMIENTO: SI, NO o SIN_DATO. SIN_DATO exige revisión; no se presume consentimiento.'],
        ['SOLICITUD: HE-000001. CODIGO_TRABAJADOR: código del directorio HHEE.'],
        ['RESULTADO y SUSTENTO: no incluya remuneraciones ni datos sensibles ajenos a este proceso.'],
    ]), 'Instrucciones');
    XLSX.writeFile(wb, 'JRM_HHEE_Plantilla_RRHH.xlsx');
}

export async function parseDirectory(file: File, areas: Pick<Area, 'id' | 'name' | 'module_enabled'>[]) {
    if (!/\.xlsx?$/i.test(file.name) || file.size > 5 * 1024 * 1024) throw Error('Excel de hasta 5 MB.');
    const wb = XLSX.read(await file.arrayBuffer()), sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (!rows.length || rows.length > 1500) throw Error('Importe entre 1 y 1500 filas de conceptos, máximo 300 trabajadores.');
    const groups = new Map<string, { code: string; name: string; area_id: string; monthly_hours: number; remuneration_concepts: RemunerationConcept[] }>();
    for (const [i, r] of rows.entries()) {
        const fail = (s: string): never => { throw Error('Fila ' + (i + 2) + ': ' + s); };
        const code = String(r.CODIGO ?? '').trim().toUpperCase(), name = String(r.NOMBRE ?? '').trim(), area = String(r.AREA_ID ?? '').trim();
        const monthly = decimal(r.HORAS_MES, true), concept = String(r.CONCEPTO ?? '').trim(), amount = decimal(r.MONTO_MENSUAL, true), computable = String(r.COMPUTABLE ?? '').trim().toUpperCase();
        if (!code || code.length > 50 || name.length < 3 || name.length > 160 || !areas.some(a => a.id === area && a.module_enabled)) fail('Revise código, nombre y área habilitada.');
        if (monthly === null || monthly <= 0 || monthly > 744 || Math.abs(Math.round(monthly * 100) - monthly * 100) > 0.00001) fail('HORAS_MES debe ser mayor a 0 y hasta 744 (dos decimales).');
        if (concept.length < 2 || concept.length > 100 || amount === null || amount > 9999999 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001 || !['SI', 'NO'].includes(computable)) fail('Complete concepto, importe mensual (dos decimales) y COMPUTABLE SI/NO.');
        let person = groups.get(code);
        if (!person) { person = { code, name, area_id: area, monthly_hours: monthly!, remuneration_concepts: [] }; groups.set(code, person); }
        if (person.name !== name || person.area_id !== area || person.monthly_hours !== monthly) fail('Los datos del trabajador deben coincidir en todas sus filas.');
        if (person.remuneration_concepts.some(c => c.name.toLowerCase() === concept.toLowerCase()) || person.remuneration_concepts.length >= 20) fail('Concepto duplicado o más de 20 conceptos para el trabajador.');
        person.remuneration_concepts.push({ name: concept, amount: amount!, computable: computable === 'SI' });
    }
    if (groups.size > 300) throw Error('Máximo 300 trabajadores por archivo.');
    return Array.from(groups.values());
}
