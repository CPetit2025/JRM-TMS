import type { Movement } from './types'
import { comercialRef, hasErrorContrato } from './catalog'
import type { FifoResult, TransferKey } from './engine'

// Controles de calidad. Cada incidencia lleva su prioridad, la cantidad afectada por unidad, los indicadores a los que
// afecta y los movimientos de origen (para abrir la fila original). Nada se corrige solo: se informa.

export type Severity = 'ALTA' | 'MEDIA' | 'BAJA' | 'INFO'
export interface Issue {
  code: string
  title: string
  severity: Severity
  description: string
  /** Qué indicadores se ven afectados */
  affects: string[]
  count: number
  qtyByUnit: Record<string, number>
  ids: number[]
  /** Decisión de negocio pendiente, si corresponde */
  pending?: string
}

const SEV_ORDER: Record<Severity, number> = { ALTA: 0, MEDIA: 1, BAJA: 2, INFO: 3 }

export interface QualityInput {
  all: Movement[]
  accepted: Movement[]
  transfers: TransferKey[]
  fifo: FifoResult
  defaultRefDate: string
  unconfirmedAreas: string[]
  today: string
  hasOpenings: boolean
}

export function qualityIssues(q: QualityInput): Issue[] {
  const issues: Issue[] = []
  const add = (code: string, title: string, severity: Severity, description: string, affects: string[], rows: Movement[], pending?: string, qty?: (m: Movement) => number) => {
    if (!rows.length) return
    const qtyByUnit: Record<string, number> = {}
    for (const m of rows) if (m.unidad) qtyByUnit[m.unidad] = (qtyByUnit[m.unidad] ?? 0) + (qty ? qty(m) : m.qty)
    issues.push({ code, title, severity, description, affects, count: rows.length, qtyByUnit, ids: rows.map(m => m.id), pending })
  }
  const acc = q.accepted
  const byId = new Map(q.all.map(m => [m.id, m]))

  add('RECHAZADAS', 'Filas rechazadas en la importación', 'ALTA',
    'Faltan campos obligatorios, la fecha o la cantidad no son válidas o la fecha está fuera de rango. No entran en ningún cálculo.',
    ['Todos los flujos'], q.all.filter(m => m.status === 'RECHAZADO'))
  add('EN_REVISION', 'Filas pendientes de revisión', 'ALTA',
    'Posibles movimientos repetidos entre cargas, cantidad cero o signo contrario al tipo de archivo. Quedan fuera de los cálculos hasta que se acepten o descarten.',
    ['Todos los flujos'], q.all.filter(m => m.status === 'REVISION'), 'Aceptar o descartar en «Cargas»')

  const accIds = new Set(acc.map(m => m.id))
  const unmatched = q.fifo.unmatched.filter(u => accIds.has(u.exitId)).map(u => byId.get(u.exitId)).filter((m): m is Movement => !!m)
  add('SALIDA_SIN_ENTRADA', 'Salidas sin entrada observable', 'ALTA',
    'La salida supera lo que entró antes en la misma bodega, producto, lote y unidad dentro de la historia cargada. Sin saldo inicial no se puede asignar su origen.',
    ['Permanencia', 'Salidas enlazadas', 'Déficit acumulado'], unmatched, q.hasOpenings ? undefined : 'Cargar saldo inicial o más historia',
    m => q.fifo.unmatchedByExit.get(m.id) ?? 0)

  const tDiff = q.transfers.filter(t => t.status !== 'CONCILIADA')
  add('TRASPASO_SIN_CONCILIAR', 'Traspasos sin conciliar', 'ALTA',
    'Claves (tipo, número, fecha, producto, unidad) cuya salida y entrada no coinciden o falta uno de los lados en los archivos cargados.',
    ['Transferencias', 'Ciclo entre etapas'], tDiff.flatMap(t => t.ids.map(id => byId.get(id)!).filter(Boolean)))

  add('ERROR_CONTRATO', 'Documentos con «ERROR DE CONTRATO»', 'ALTA',
    'La referencia comercial del movimiento está marcada como error en el ERP. Se excluye de la referencia comercial y del cumplimiento.',
    ['Despachos por pedido', 'Cumplimiento comercial'], acc.filter(hasErrorContrato))

  const tLot = q.transfers.filter(t => t.lotChange)
  add('CAMBIO_LOTE_TRASPASO', 'Cambios de lote en traspasos', 'MEDIA',
    'El conjunto de lotes de la salida es distinto al de la entrada del mismo traspaso. La permanencia FIFO de destino arranca con el lote nuevo; el ciclo entre etapas excluye estas claves hasta registrar la equivalencia.',
    ['Ciclo entre etapas', 'Trazabilidad'], tLot.flatMap(t => t.ids.map(id => byId.get(id)!).filter(Boolean)), 'Registrar la equivalencia lote origen → destino')

  add('LOTE_VACIO', 'Movimientos sin lote', 'MEDIA',
    'Sin lote no se asigna FIFO: se excluyen de la permanencia y de la antigüedad, pero sí cuentan en entradas y salidas.',
    ['Permanencia', 'Antigüedad'], acc.filter(m => !m.lote))

  const variants = new Map<string, Set<string>>()
  for (const m of acc) if (m.lote) { const k = m.lote.toUpperCase(); const s = variants.get(k) ?? new Set(); s.add(m.lote); variants.set(k, s) }
  const caseLots = new Set([...variants.values()].filter(s => s.size > 1).flatMap(s => [...s]))
  add('LOTE_VARIANTES', 'Lotes que solo difieren en mayúsculas', 'MEDIA',
    'Se tratan como lotes distintos (los identificadores no se igualan automáticamente). Si son el mismo lote, registre la equivalencia.',
    ['Permanencia', 'Trazabilidad'], acc.filter(m => m.lote && caseLots.has(m.lote)), 'Confirmar si son el mismo lote')

  add('REF_COMERCIAL_AUSENTE', 'Despachos sin referencia comercial', 'MEDIA',
    'Despachos de ventas sin contrato, subcontrato ni pedido en DocRel/NumRel/Contrato. No se pueden asignar a un compromiso.',
    ['Despachos por pedido', 'Cumplimiento comercial'], acc.filter(m => m.clase === 'DESPACHO_VENTA' && !comercialRef(m) && !m.contrato && !hasErrorContrato(m)))

  add('LINEAS_IDENTICAS', 'Líneas idénticas dentro de un archivo', 'MEDIA',
    'Se conservan todas: no hay un identificador de origen que confirme que son duplicados. Si una regla de negocio lo confirma, descártelas en «Cargas».',
    ['Todos los flujos'], acc.filter(m => m.dup > 1), 'Definir regla de duplicación')

  const units = new Map<string, Set<string>>()
  for (const m of acc) { const s = units.get(m.producto) ?? new Set(); s.add(m.unidad); units.set(m.producto, s) }
  const multi = new Set([...units].filter(([, s]) => s.size > 1).map(([p]) => p))
  add('UNIDADES_INCONSISTENTES', 'Productos con más de una unidad', 'MEDIA',
    'El mismo producto aparece con unidades distintas. Las cantidades se muestran por separado; solo se convierten con una equivalencia verificada.',
    ['Flujos por producto', 'Pareto'], acc.filter(m => multi.has(m.producto)), 'Registrar equivalencia verificada')

  add('TIPO_SIN_CLASIFICAR', 'Tipos de documento sin clasificar', 'MEDIA',
    'No se sabe si son producción, traspaso, despacho u otro movimiento. Cuentan en entradas y salidas, no en indicadores por clase.',
    ['Producción', 'Despachos', 'Transferencias'], acc.filter(m => m.clase === 'SIN_CLASIFICAR'), 'Clasificar en «Configuración»')

  add('PESO_CERO', 'Pesos cero o ausentes', 'BAJA',
    'PesoUnitario y peso producido en cero o vacíos. No se usan para convertir a kilos.',
    ['Cobertura de pesos'], acc.filter(m => !(m.pesoUnitario && m.pesoUnitario > 0)))
  add('PESO_INCONSISTENTE', 'Pesos inconsistentes', 'MEDIA',
    'El peso producido difiere más de 1 % de cantidad × peso unitario.',
    ['Cobertura de pesos'], acc.filter(m => m.pesoUnitario && m.pesoUnitario > 0 && m.pesoProducido && Math.abs(m.pesoProducido) > 0
      && Math.abs(Math.abs(m.pesoProducido) - m.qty * m.pesoUnitario) > 0.01 * m.qty * m.pesoUnitario))

  add('REFFECHA_PREDETERMINADA', `RefFecha con valor predeterminado (${fmtIso(q.defaultRefDate)})`, 'BAJA',
    'La fecha aparece en la mayoría de las filas y no se usa para permanencia ni para compromisos hasta validarla.',
    ['Permanencia (no se usa)'], acc.filter(m => m.refFecha === q.defaultRefDate), 'Confirmar significado de RefFecha')
  const far = (d: string | null) => !!d && (d < '2015-01-01' || d > addYears(q.today, 2))
  add('FECHAS_FUERA_RANGO', 'Fechas de referencia o entrega fuera de rango', 'BAJA',
    'FechaEntrega o RefFecha muy antiguas o futuras. Solo se usan como diagnóstico.',
    ['Diagnóstico de FechaEntrega'], acc.filter(m => (far(m.fechaEntrega) || (far(m.refFecha) && m.refFecha !== q.defaultRefDate))))

  const raw = new Map<string, Set<string>>()
  for (const m of acc) { const s = raw.get(m.bodega) ?? new Set(); s.add(m.bodegaRaw); raw.set(m.bodega, s) }
  const inconsistent = new Set([...raw].filter(([k, s]) => s.size > 1 || [...s].some(v => v !== k)).map(([k]) => k))
  add('BODEGA_NOMBRES', 'Nombres de bodega con variantes', 'BAJA',
    'El nombre trae espacios dobles o variantes de escritura (p. ej. «647-04  ALM PT»). Se agrupan por el nombre en mayúsculas y con espacios simples; el original se conserva.',
    ['Mapeo de áreas'], acc.filter(m => inconsistent.has(m.bodega)))

  if (q.unconfirmedAreas.length) issues.push({ code: 'AREA_PENDIENTE', title: 'Asociación de áreas pendiente de confirmación', severity: 'INFO',
    description: `Pendiente de confirmación del negocio: ${q.unconfirmedAreas.join(', ')}.`, affects: ['Distribución'], count: q.unconfirmedAreas.length,
    qtyByUnit: {}, ids: [], pending: 'Confirmar en «Configuración»' })
  if (!q.hasOpenings) issues.push({ code: 'SIN_SALDO_INICIAL', title: 'Sin saldo inicial', severity: 'INFO',
    description: 'No hay saldos iniciales: el inventario final no está disponible y la asignación FIFO es parcial (puede cambiar al incorporar historia).',
    affects: ['Inventario final', 'Permanencia', 'Antigüedad'], count: 0, qtyByUnit: {}, ids: [], pending: 'Cargar saldo inicial' })

  return issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count)
}

const fmtIso = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
const addYears = (d: string, y: number) => `${Number(d.slice(0, 4)) + y}${d.slice(4)}`

/** Completitud: % de movimientos aceptados con cada campo informado */
export function completeness(acc: Movement[]) {
  const fields: Array<[string, (m: Movement) => unknown]> = [
    ['Lote', m => m.lote], ['Número', m => m.numero], ['Cliente (RazonSocial)', m => m.razonSocial], ['Referencia comercial', m => comercialRef(m) ?? m.contrato],
    ['Peso unitario', m => m.pesoUnitario && m.pesoUnitario > 0 ? 1 : null], ['FechaEntrega', m => m.fechaEntrega], ['GLOSA', m => m.glosa],
  ]
  return fields.map(([label, f]) => {
    const n = acc.filter(m => f(m) !== null && f(m) !== undefined && f(m) !== '').length
    return { label, filled: n, total: acc.length, share: acc.length ? n / acc.length : null }
  })
}
