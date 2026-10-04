import type { Dataset } from './model'
import type { Row } from '@/components/kpi/kpiUi'
export interface KpiFilters { role: string; person: string; rating: string; report: string }
const mean = (values: Array<number | null>): number | null => {
  const known = values.filter((x): x is number => x !== null && Number.isFinite(x))
  return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null
}
const value = (x: unknown) => x == null ? null : Number(x)
const rating = (n: number | null) => n == null ? 'SIN_DATOS' : n >= 90 ? 'EXCELENTE' : n >= 75 ? 'BUENO' : n >= 60 ? 'REGULAR' : 'BAJO'
export function filterKpi(t: Row, f: KpiFilters, history: Row[]): Row {
  const scoped = f.role || f.person || f.rating
  const roles: Row[] = (t.roles || []).filter((r: Row) => !f.role || r.rol === f.role).map((r: Row) => {
    const members: Row[] = (r.miembros || []).filter((m: Row) => (!f.person || String(m.user_id || m.sujeto) === f.person) && (!f.rating || m.calificacion === f.rating))
    const indices = members.map(m => value(m.indice)).filter((x): x is number => x !== null && Number.isFinite(x))
    const promedio = mean(indices)
    const dist = Object.fromEntries(['EXCELENTE', 'BUENO', 'REGULAR', 'BAJO', 'SIN_DATOS'].map(c => [c, members.filter(m => (m.calificacion || 'SIN_DATOS') === c).length]))
    const sujetos = new Set(members.map(m => String(m.sujeto)))
    const tendencia = scoped ? (r.tendencia || []).map((p: Row) => {
      const known = history.filter(h => h.rol === r.rol && h.periodo === p.periodo && sujetos.has(String(h.sujeto))).map(h => value(h.indice))
      return { ...p, indice: p.periodo === t.periodo ? promedio : mean(known), con_indice: p.periodo === t.periodo ? indices.length : known.filter(x => x !== null && Number.isFinite(x)).length }
    }) : r.tendencia
    return { ...r, miembros: members, n: members.length, con_indice: indices.length, promedio, minimo: indices.length ? Math.min(...indices) : null,
      maximo: indices.length ? Math.max(...indices) : null, dist, tendencia,
      informes: { atrasados: members.filter(m => m.informe?.estado === 'ATRASADO').length, por_revisar: members.filter(m => m.informe?.estado === 'ENVIADO').length, revisados: members.filter(m => m.informe?.estado === 'REVISADO').length } }
  })
  const members: Row[] = roles.flatMap(r => r.miembros)
  const cohort = new Set(members.map(m => `${m.rol}|${m.user_id}`))
  const informes: Row[] = (t.informes || []).filter((i: Row) => (!f.role || i.rol === f.role) && (!f.person || String(i.user_id) === f.person)
    && (!f.rating || cohort.has(`${i.rol}|${i.user_id}`)) && (!f.report || i.estado === f.report))
  const indice = mean(roles.map(r => value(r.promedio)))
  return { ...t, filtros: f, roles, informes, alertas: (t.alertas || []).filter((a: Row) => (!f.role || a.rol === f.role) && (!f.person || members.some(m => m.rol === a.rol && m.nombre === a.nombre))
      && (!f.rating || members.some(m => m.rol === a.rol && m.nombre === a.nombre))), general: {
        indice, calificacion: rating(indice), miembros: members.length, con_indice: members.filter(m => m.indice != null).length,
        bajos: members.filter(m => m.calificacion === 'BAJO').length, informes_atrasados: members.filter(m => m.informe?.estado === 'ATRASADO').length,
        informes_por_revisar: informes.filter(i => i.estado === 'ENVIADO').length,
      } }
}

export function kpiDataset(t: Row): Dataset {
  const members: Row[] = (t.roles || []).flatMap((r: Row) => (r.miembros || []).map((m: Row) => ({ ...m, roleName: r.nombre })))
  return { source: 'kpi_tablero · kpi_historial', basis: 'Mes de desempeño',
    note: `Filtros de desempeño: ${JSON.stringify(t.filtros || {})}. Índice general: promedio de roles con datos; no representa rentabilidad ni nivel de servicio.`,
    metrics: [{ key: 'index', label: 'Índice general de la selección', value: t.general?.indice ?? null, unit: 'puntos', formula: 'Promedio no ponderado de los índices promedio de los roles visibles con datos.' }],
    rows: members.map(m => ({ id: `${m.rol}:${m.sujeto}`, code: m.nombre, date: t.periodo, status: m.calificacion, client: '', contract: '', plate: '', driver: '', route: '', site: '',
      values: { indice: m.indice ?? null, cobertura: m.cobertura ?? null }, detail: { Rol: m.roleName, Nombre: m.nombre, Informe: m.informe?.estado || 'No aplica',
        'Indicadores': (m.kpis || []).map((k: Row) => `${k.nombre}: ${k.valor ?? 'sin dato'} ${k.unidad} (meta ${k.meta}; peso ${k.peso}; puntaje ${k.puntaje ?? 'sin dato'})`).join('; '),
        'Evolución del rol': ((t.roles || []).find((r: Row) => r.rol === m.rol)?.tendencia || []).map((p: Row) => `${p.periodo}: ${p.indice ?? 'sin dato'}`).join('; ') } })) }
}
