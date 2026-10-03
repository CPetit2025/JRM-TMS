import * as XLSX from 'xlsx'

// Lectura del Excel de Eficiencia de Flota. Reconoce las tres hojas por sus encabezados (no por el nombre):
//   MANT  mantenimiento (ACTIVO, FECHA, MONTO…), COMB  combustible y km mensual (Placa, Gls/Abast., Km Real…) y
//   RUTA  rutas con peso (Placa del vehiculo, PESO (KG)…). Devuelve filas normalizadas listas para fe_upload_rows.

export type FleetSheetKind = 'MANT' | 'COMB' | 'RUTA'
export const FLEET_KIND_LABEL: Record<FleetSheetKind, string> = {
  MANT: 'Mantenimiento', COMB: 'Combustible y km', RUTA: 'Rutas y peso',
}
export type FleetRow = Record<string, string | number | null> & { __row: number }
export interface FleetParsedSheet { kind: FleetSheetKind; sheet: string; rows: FleetRow[]; desde: string | null; hasta: string | null; descartadas: number }
export interface FleetParseResult { sheets: FleetParsedSheet[]; ignoradas: string[] }

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SETIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']

function isoDate(v: unknown, date1904: boolean): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000) {
    const p = XLSX.SSF.parse_date_code(v, { date1904 })
    return p ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null
  }
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const s = String(v).replace(/[^0-9.,-]/g, '')
  if (!s) return null
  const n = Number(/,\d{3}$/.test(s) || (s.includes(',') && s.includes('.')) ? s.replace(/,/g, '') : s.replace(',', '.'))
  return isFinite(n) ? n : null
}

// Tiempo en horas: fracción de día (Excel), "hh:mm" o número de horas
function hours(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return v < 1 ? Math.round(v * 24 * 100) / 100 : v
  const m = String(v).match(/^(\d{1,2}):(\d{2})/)
  return m ? Number(m[1]) + Number(m[2]) / 60 : num(v)
}

function monthOf(v: unknown): number | null {
  const s = norm(v).replace(/\(.*\)/, '').replace(/SEPTIEMBRE/, 'SETIEMBRE').trim()
  const i = MESES.findIndex(m => s.startsWith(m))
  if (i >= 0) return i + 1
  const n = num(v)
  return n && n >= 1 && n <= 12 ? n : null
}

type Col = (h: string) => boolean
const SPEC: Record<FleetSheetKind, { required: Col[]; cols: Record<string, Col> }> = {
  MANT: {
    required: [h => h === 'ACTIVO', h => h === 'MONTO', h => h === 'FECHA'],
    cols: {
      activo: h => h === 'ACTIVO', clase: h => h === 'CLASE_ACTIVO' || h === 'CLASE ACTIVO', fecha: h => h === 'FECHA', proveedor: h => h === 'PROVEEDOR',
      factura: h => h === 'FACTURA', km_hrs: h => h === 'KM_HRS' || h === 'KM HRS', monto: h => h === 'MONTO', tipo: h => h === 'TIPO_MANTTO' || h === 'TIPO MANTTO',
      categoria: h => h === 'CATEGORIA_COSTO' || h === 'CATEGORIA COSTO', mayor: h => h === 'INTERVENCION_MAYOR' || h === 'INTERVENCION MAYOR',
      dias_fuera: h => h.startsWith('DIAS_FUERA') || h.startsWith('DIAS FUERA'), area: h => h === 'AREA', detalle: h => h === 'COMENTARIOS',
      anio_fab: h => h.startsWith('ANO FABRIC') || h.startsWith('ANIO FABRIC'),
    },
  },
  COMB: {
    required: [h => h === 'PLACA', h => h.startsWith('GLS'), h => h === 'KM REAL'],
    cols: {
      anio: h => h === 'ANO' || h === 'ANIO', mes: h => h === 'MES', mes1: h => h === 'MES 1', placa: h => h === 'PLACA', vehiculo: h => h === 'VEHICULO',
      galones: h => h.startsWith('GLS'), soles: h => h.startsWith('MONTO ABAST'), km_real: h => h === 'KM REAL', valida: h => h === 'VALIDA',
      precio: h => h.startsWith('PRECIO'), fecha: h => h === 'FECHA',
    },
  },
  RUTA: {
    required: [h => h.startsWith('PLACA DEL VEHICULO'), h => h.startsWith('PESO')],
    cols: {
      fecha: h => h === 'FECHA', placa: h => h.startsWith('PLACA DEL VEHICULO'), marca: h => h.startsWith('MARCA DEL VEHICULO'),
      actividad: h => h.startsWith('TIPO DE ACTIVIDAD'), area: h => h.startsWith('AREA SOLICITANTE'), cliente: h => h.startsWith('RAZON SOCIAL'),
      provincia: h => h === 'PROVINCIA', guia: h => h.startsWith('NRO DE GUIA'), km: h => h.startsWith('KM TOTAL DE ENTREGA'),
      kg: h => h.startsWith('PESO'), m3: h => h.startsWith('METRO CUBICO'), espera: h => h.startsWith('TIEMPO DE ESPERA'), descarga: h => h.startsWith('TIPO DE DESCARGA'),
    },
  },
}

function detect(aoa: unknown[][]): { kind: FleetSheetKind; headerRow: number; map: Record<string, number> } | null {
  for (let r = 0; r < Math.min(aoa.length, 12); r++) {
    const heads = (aoa[r] || []).map(norm)
    for (const kind of Object.keys(SPEC) as FleetSheetKind[]) {
      const spec = SPEC[kind]
      if (spec.required.every(f => heads.some(f))) {
        const map: Record<string, number> = {}
        Object.entries(spec.cols).forEach(([k, f]) => { const i = heads.findIndex(f); if (i >= 0) map[k] = i })
        return { kind, headerRow: r, map }
      }
    }
  }
  return null
}

export function parseFleetWorkbook(data: ArrayBuffer | Uint8Array): FleetParseResult {
  const wb = XLSX.read(data, { type: 'array', cellDates: false })
  const date1904 = !!wb.Workbook?.WBProps?.date1904
  const sheets: FleetParsedSheet[] = []
  const ignoradas: string[] = []
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false })
    const d = detect(aoa)
    if (!d || sheets.some(s => s.kind === d.kind)) { ignoradas.push(name); continue }
    const get = (row: unknown[], k: string) => (d.map[k] === undefined ? null : row[d.map[k]])
    const rows: FleetRow[] = []
    let descartadas = 0
    for (let r = d.headerRow + 1; r < aoa.length; r++) {
      const row = aoa[r] || []
      const __row = r + 1
      if (d.kind === 'MANT') {
        const activo = String(get(row, 'activo') ?? '').trim()
        const monto = num(get(row, 'monto'))
        if (!activo || monto === null) { descartadas++; continue }
        rows.push({ __row, activo, clase: String(get(row, 'clase') ?? ''), fecha: isoDate(get(row, 'fecha'), date1904), proveedor: String(get(row, 'proveedor') ?? '') || null,
          factura: String(get(row, 'factura') ?? '') || null, km_hrs: num(get(row, 'km_hrs')), monto, tipo: String(get(row, 'tipo') ?? '') || null,
          categoria: String(get(row, 'categoria') ?? '') || null, mayor: num(get(row, 'mayor')), dias_fuera: num(get(row, 'dias_fuera')),
          area: String(get(row, 'area') ?? '') || null, detalle: String(get(row, 'detalle') ?? '').slice(0, 300) || null, anio_fab: num(get(row, 'anio_fab')) })
      } else if (d.kind === 'COMB') {
        const placa = String(get(row, 'placa') ?? '').trim()
        const anio = num(get(row, 'anio'))
        const mes = monthOf(get(row, 'mes')) ?? monthOf(get(row, 'mes1'))
        if (!placa || !anio || !mes) { descartadas++; continue }
        rows.push({ __row, placa, vehiculo: String(get(row, 'vehiculo') ?? ''), anio, mes, galones: num(get(row, 'galones')), soles: num(get(row, 'soles')),
          km_real: num(get(row, 'km_real')), valida: num(get(row, 'valida')), precio: num(get(row, 'precio')) })
      } else {
        const placa = String(get(row, 'placa') ?? '').trim()
        const fecha = isoDate(get(row, 'fecha'), date1904)
        if (!placa || !fecha) { descartadas++; continue }
        rows.push({ __row, fecha, placa, marca: String(get(row, 'marca') ?? '') || null, actividad: String(get(row, 'actividad') ?? '') || null,
          area: String(get(row, 'area') ?? '') || null, cliente: String(get(row, 'cliente') ?? '') || null, provincia: String(get(row, 'provincia') ?? '') || null,
          guia: String(get(row, 'guia') ?? '') || null, km: num(get(row, 'km')), kg: num(get(row, 'kg')), m3: num(get(row, 'm3')),
          espera_h: hours(get(row, 'espera')), descarga: String(get(row, 'descarga') ?? '') || null })
      }
    }
    const fechas = rows.map(x => (d.kind === 'COMB' ? `${x.anio}-${String(x.mes).padStart(2, '0')}-01` : (x.fecha as string | null))).filter(Boolean).sort() as string[]
    sheets.push({ kind: d.kind, sheet: name, rows, desde: fechas[0] ?? null, hasta: fechas[fechas.length - 1] ?? null, descartadas })
  }
  return { sheets, ignoradas }
}
