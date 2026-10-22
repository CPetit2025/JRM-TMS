import type { Area, DocClass, Movement, RowStatus } from './types'
import { suggestClass, type AreaRule } from './catalog'
import type { NormMovement, ParsedRow } from './normalize'

// Construcción de los movimientos del motor a partir de filas normalizadas (vista previa de una carga o datos guardados).

export interface Catalogs {
  areas: AreaRule[]
  classes: Record<string, DocClass>
}

export function areaOf(bodega: string, areas: AreaRule[]): Area | null {
  return areas.find(a => a.bodega === bodega)?.area ?? null
}
export function classOf(tipo: string, classes: Record<string, DocClass>): DocClass {
  const t = tipo.replace(/\s+/g, ' ').trim().toUpperCase()
  return classes[t] ?? suggestClass(t)
}

/** Filas de una carga → movimientos (con ids locales negativos para no chocar con los guardados) */
export function rowsToMovements(rows: ParsedRow[], importId: string, cat: Catalogs, idStart = -1): Movement[] {
  const out: Movement[] = []
  let id = idStart
  for (const r of rows) {
    const n = r.norm as Partial<NormMovement> | null
    if (!n) continue
    out.push(fromNorm(n, { id: id--, importId, sheet: r.sheet, row: r.row, status: r.status, reasons: r.reasons, dup: r.dup }, cat))
  }
  return out
}

export function fromNorm(n: Partial<NormMovement>, meta: { id: number; importId: string; sheet: string; row: number; status: RowStatus; reasons: string[]; dup: number }, cat: Catalogs): Movement {
  const bodega = n.bodega ?? ''
  const tipo = n.tipo ?? ''
  const cantidad = n.cantidad ?? 0
  return {
    ...meta,
    side: n.side ?? (cantidad < 0 ? 'S' : 'E'),
    tipo, clase: tipo ? classOf(tipo, cat.classes) : 'SIN_CLASIFICAR',
    bodegaRaw: n.bodegaRaw ?? '', bodega, area: bodega ? areaOf(bodega, cat.areas) : null,
    numero: n.numero ?? null, fecha: n.fecha ?? '', codLegal: n.codLegal ?? null, razonSocial: n.razonSocial ?? null,
    producto: n.producto ?? '', glosa: n.glosa ?? null, cantidad, qty: Math.abs(cantidad), unidad: n.unidad ?? '',
    docRel: n.docRel ?? null, numRel: n.numRel ?? null, fechaEntrega: n.fechaEntrega ?? null, contrato: n.contrato ?? null,
    refTipo: n.refTipo ?? null, refCorrelativo: n.refCorrelativo ?? null, refNumero: n.refNumero ?? null, refFecha: n.refFecha ?? null,
    lote: n.lote ?? null, color: n.color ?? null, comentario: n.comentario ?? null, pesoUnitario: n.pesoUnitario ?? null,
    pesoXProducir: n.pesoXProducir ?? null, pesoProducido: n.pesoProducido ?? null, ccosto: n.ccosto ?? null,
  }
}

/** Orden de las columnas del lote compacto que devuelve la base (apa_dataset_page) */
export const DATASET_COLUMNS = ['id', 'import_id', 'sheet', 'row_number', 'status', 'reasons', 'dup', 'side', 'tipo', 'bodega_raw', 'bodega', 'numero', 'fecha',
  'cod_legal', 'razon_social', 'producto', 'glosa', 'cantidad', 'unidad', 'doc_rel', 'num_rel', 'fecha_entrega', 'contrato', 'ref_tipo',
  'ref_correlativo', 'ref_numero', 'ref_fecha', 'lote', 'color', 'comentario', 'peso_unitario', 'peso_x_producir', 'peso_producido', 'ccosto'] as const

type Cell = string | number | null | string[]
export function fromDatasetRow(r: Cell[], cat: Catalogs): Movement {
  const g = (i: number) => r[i] as string | null
  const num = (i: number) => r[i] === null || r[i] === undefined ? null : Number(r[i])
  const cantidad = Number(r[17])
  const bodega = g(10) ?? ''
  const tipo = g(8) ?? ''
  return {
    id: Number(r[0]), importId: g(1) ?? '', sheet: g(2) ?? '', row: Number(r[3]), status: (g(4) ?? 'ACEPTADO') as RowStatus,
    reasons: (r[5] as string[] | null) ?? [], dup: Number(r[6] ?? 1), side: (g(7) as 'E' | 'S') ?? (cantidad < 0 ? 'S' : 'E'),
    tipo, clase: classOf(tipo, cat.classes), bodegaRaw: g(9) ?? '', bodega, area: areaOf(bodega, cat.areas),
    numero: g(11), fecha: g(12) ?? '', codLegal: g(13), razonSocial: g(14), producto: g(15) ?? '', glosa: g(16), cantidad, qty: Math.abs(cantidad),
    unidad: g(18) ?? '', docRel: g(19), numRel: g(20), fechaEntrega: g(21), contrato: g(22), refTipo: g(23), refCorrelativo: g(24), refNumero: g(25),
    refFecha: g(26), lote: g(27), color: g(28), comentario: g(29), pesoUnitario: num(30), pesoXProducir: num(31), pesoProducido: num(32), ccosto: g(33),
  }
}
