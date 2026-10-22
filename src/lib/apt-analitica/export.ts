import * as XLSX from 'xlsx'
import type { Filters, Movement, Settings } from './types'
import { AREA_LABEL, CLASS_LABEL } from './types'
import { comercialRef, ordenRef } from './catalog'

// Exportación de la selección filtrada: datos + hoja de filtros y fecha de corte + hoja de metodología.

export const METHODOLOGY = [
  ['Fuente', 'Movimientos ACEPTADOS de cargas vigentes. Las filas rechazadas, en revisión o descartadas no se usan en los cálculos.'],
  ['Unidades', 'Nunca se suman unidades distintas (UND, CIEN, KG…). Las conversiones solo se aplican con equivalencias verificadas.'],
  ['Identificadores', 'Lote, OT/OP, contrato y pedido se conservan como texto y no se igualan automáticamente.'],
  ['Entradas y salidas', 'Por el signo de Cantidad. Los traspasos internos no son producción ni ventas. Un despacho no es una entrega.'],
  ['Variación neta', 'Entradas − salidas del período. El inventario final requiere saldo inicial; sin él no está disponible.'],
  ['FIFO', 'Por bodega + producto + lote + unidad, con cantidades parciales y sin reutilizar entradas. Lotes vacíos excluidos. Sin saldo inicial la asignación es parcial.'],
  ['Mismo día', 'Hipótesis configurable: entradas antes que salidas (por defecto) o al revés. Dentro de un lado, orden del archivo.'],
  ['Permanencia', 'Días calendario (fecha de salida − fecha de entrada), media y percentiles ponderados por cantidad. Cero días = misma fecha, no atención inmediata.'],
  ['Ciclo entre etapas', 'Solo sobre cantidades trazables por todas las etapas (traspaso conciliado y sin cambio de lote). No suma medias de etapas.'],
  ['Avance', 'Relación de flujos (salidas ÷ entradas), salida de cohorte (entradas asignadas ÷ elegibles) y cumplimiento comercial (despacho válido ÷ compromiso vigente, por pedido, línea y unidad) se informan por separado.'],
  ['RefFecha', 'El valor predeterminado (22/03/2020) no se usa para permanencia. FechaEntrega solo como diagnóstico hasta confirmar su significado.'],
  ['Duplicados', 'Las líneas idénticas de un archivo se conservan. Una línea igual a otra carga vigente queda en revisión hasta aceptarla o descartarla.'],
]

export function movementRow(m: Movement, files?: Map<string, string>) {
  return {
    Archivo: files?.get(m.importId) ?? m.importId, Hoja: m.sheet, Fila: m.row, Estado: m.status, Lado: m.side === 'E' ? 'Entrada' : 'Salida', TipoDocto: m.tipo, Clase: CLASS_LABEL[m.clase],
    Bodega: m.bodegaRaw, 'Bodega (normalizada)': m.bodega, Área: m.area ? AREA_LABEL[m.area] : '', Numero: m.numero ?? '', Fecha: m.fecha, CodLegal: m.codLegal ?? '',
    RazonSocial: m.razonSocial ?? '', Producto: m.producto, GLOSA: m.glosa ?? '', Cantidad: m.cantidad, UNIDAD: m.unidad, DocRel: m.docRel ?? '', NumRel: m.numRel ?? '',
    'OT/OP': ordenRef(m) ?? '', 'Ref. comercial': comercialRef(m) ?? '', FechaEntrega: m.fechaEntrega ?? '', Contrato: m.contrato ?? '', RefFecha: m.refFecha ?? '',
    Lote: m.lote ?? '', Comentario: m.comentario ?? '', PesoUnitario: m.pesoUnitario ?? '', PesoTotalProduccido: m.pesoProducido ?? '', Observaciones: m.reasons.join(' | '),
  }
}

export function exportWorkbook(fileName: string, sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>, ctx: { filters: Filters; cutoff: string | null; settings: Settings; lastUpdate: string | null; label?: string }) {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ Aviso: 'Sin registros para los filtros aplicados' }]), s.name.slice(0, 31))
  const f = ctx.filters
  const filt: Array<[string, string]> = [
    ['Selección', ctx.label ?? 'Filtros globales'], ['Fecha de corte', ctx.cutoff ?? '—'], ['Última actualización', ctx.lastUpdate ?? '—'],
    ['Desde', f.from ?? 'inicio de los datos'], ['Hasta', f.to ?? 'fin de los datos'], ['Unidad', f.unidad ?? 'todas, por separado'],
    ['Áreas', f.areas.map(a => AREA_LABEL[a]).join(', ') || 'todas'], ['Bodegas', f.bodegas.join(', ') || 'todas'], ['Clientes', f.clientes.join(', ') || 'todos'],
    ['Productos', f.productos.join(', ') || 'todos'], ['Lotes', f.lotes.join(', ') || 'todos'], ['OT/OP', f.otop.join(', ') || 'todas'],
    ['Contratos / pedidos', f.contratos.join(', ') || 'todos'], ['Documentos', f.documentos.join(', ') || 'todos'], ['Búsqueda', f.text || '—'],
    ['Hipótesis del mismo día', ctx.settings.sameDayOrder === 'ENTRADAS_PRIMERO' ? 'Entradas antes que salidas' : 'Salidas antes que entradas'],
    ['Rangos de antigüedad (días)', ctx.settings.ageBuckets.join(', ')],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Filtro', 'Valor'], ...filt]), 'Filtros y corte')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Regla', 'Descripción'], ...METHODOLOGY]), 'Metodología')
  XLSX.writeFile(wb, fileName)
}
