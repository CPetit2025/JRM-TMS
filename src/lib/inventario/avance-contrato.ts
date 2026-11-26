import type { InvContratoLineas, InvContratoProducto } from './types'

// Avance del contrato por ítem: contrato, despachado, saldo, stock del APT por bodega y lo que falta producir
export type AvanceFila = {
  lote: string; item: string; producto: string; glosa: string | null; unidad: string | null
  peso: number | null; pesoFuente: 'ERP' | 'APT' | null; unidadDistinta: boolean
  contratado: number; despachado: number; saldo: number; apt: [number, number, number]; enApt: number; porProducir: number
  avance: number; estado: 'COMPLETO' | 'PARCIAL' | 'PENDIENTE'
}
export const BODEGAS = ['647', '540', 'ST'] as const

const same = (a: string | null, b: string | null) => (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase()

/** El stock de un ID compartido por varios ítems se asigna a los ítems con saldo en su orden (647, luego 540 y ST),
 *  así no se cuenta dos veces. Si el APT lleva el ID en otra unidad (CIEN vs UND) no se asigna y se avisa. */
export function buildAvance(lineas: InvContratoLineas['lineas'], productos: InvContratoProducto[]): AvanceFila[] {
  const left = new Map(productos.map(p => [p.producto, { p, b: [p.stock_647, p.stock_540, p.stock_st] }]))
  return lineas.map(l => {
    const s = left.get(l.producto)
    const unidadDistinta = !!s && !!s.p.unidad && !!l.unidad && !same(s.p.unidad, l.unidad)
    const saldo = Math.max(0, l.pendiente)
    const apt: [number, number, number] = [0, 0, 0]
    if (s && !unidadDistinta) {
      let need = saldo
      for (let i = 0; i < 3 && need > 0; i++) { const t = Math.min(need, s.b[i]); apt[i] = t; s.b[i] -= t; need -= t }
    }
    const enApt = apt[0] + apt[1] + apt[2]
    // Peso: unitario del ERP; si falta, el promedio del ID en el APT (misma unidad)
    const pApt = s && !unidadDistinta ? (s.p.ingresado > 0 ? s.p.ingresado_kg / s.p.ingresado : s.p.stock > 0 ? s.p.stock_kg / s.p.stock : 0) : 0
    const peso = l.peso_unit && l.peso_unit > 0 ? Number(l.peso_unit) : pApt > 0 ? pApt : null
    return {
      lote: l.documento, item: l.item, producto: l.producto, glosa: l.glosa, unidad: l.unidad,
      peso, pesoFuente: l.peso_unit && l.peso_unit > 0 ? 'ERP' : pApt > 0 ? 'APT' : null, unidadDistinta,
      contratado: l.contratado, despachado: l.despachado, saldo, apt, enApt, porProducir: Math.max(0, saldo - enApt),
      avance: l.contratado > 0 ? Math.min(1, l.despachado / l.contratado) : 0,
      estado: saldo <= 0 ? 'COMPLETO' : l.despachado > 0 ? 'PARCIAL' : 'PENDIENTE',
    }
  })
}

export const tn = (q: number, peso: number | null) => (peso ? (q * peso) / 1000 : 0)

export type AvanceTotal = { n: number; sinPeso: number; contratado: number; despachado: number; saldo: number; apt: number[]; porProducir: number
  tContratado: number; tDespachado: number; tSaldo: number; tApt: number[]; tPorProducir: number }
export function totalAvance(rows: AvanceFila[]): AvanceTotal {
  const t: AvanceTotal = { n: rows.length, sinPeso: 0, contratado: 0, despachado: 0, saldo: 0, apt: [0, 0, 0], porProducir: 0, tContratado: 0, tDespachado: 0, tSaldo: 0, tApt: [0, 0, 0], tPorProducir: 0 }
  for (const r of rows) {
    if (!r.peso) t.sinPeso++
    t.contratado += r.contratado; t.despachado += r.despachado; t.saldo += r.saldo; t.porProducir += r.porProducir
    t.tContratado += tn(r.contratado, r.peso); t.tDespachado += tn(r.despachado, r.peso); t.tSaldo += tn(r.saldo, r.peso); t.tPorProducir += tn(r.porProducir, r.peso)
    for (let i = 0; i < 3; i++) { t.apt[i] += r.apt[i]; t.tApt[i] += tn(r.apt[i], r.peso) }
  }
  return t
}

export type AvanceFiltro = { q: string; soloSaldo: boolean; lotes: string[]; estado: string; bodega: string; situacion: string; min: string; max: string }
export const FILTRO_INICIAL: AvanceFiltro = { q: '', soloSaldo: true, lotes: [], estado: '', bodega: '', situacion: '', min: '', max: '' }
export function filtrarAvance(rows: AvanceFila[], f: AvanceFiltro): AvanceFila[] {
  const q = f.q.trim().toLowerCase()
  return rows.filter(r => (!f.soloSaldo || r.saldo > 0)
    && (!q || `${r.item} ${r.producto} ${r.glosa ?? ''}`.toLowerCase().includes(q))
    && (!f.lotes.length || f.lotes.includes(r.lote))
    && (!f.estado || r.estado === f.estado)
    && (!f.bodega || (f.bodega === 'NINGUNA' ? r.enApt === 0 : r.apt[BODEGAS.indexOf(f.bodega as typeof BODEGAS[number])] > 0))
    && (!f.situacion || (f.situacion === 'LISTO' ? r.saldo > 0 && r.porProducir === 0 : f.situacion === 'PRODUCIR' ? r.porProducir > 0 : !r.peso))
    && (f.min === '' || r.avance * 100 >= Number(f.min)) && (f.max === '' || r.avance * 100 <= Number(f.max)))
}
