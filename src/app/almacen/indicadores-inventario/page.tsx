import { DispatchKpiDashboard, type KpiBoardConfig } from '@/components/warehouse/dispatch/DispatchKpiDashboard'
import { DISPOSICIONES, MOTIVOS } from '@/components/warehouse/inventario/returns'

// Tablero de Inventario y Logística Inversa: mismas reglas y comportamiento que el de Despacho (ficha, comparación, exportación)
const INVENTORY_BOARD: KpiBoardConfig = {
  eyebrow: 'Inventario y Logística Inversa', title: 'Indicadores de Inventario y Retornos', context: 'Inventario y Logística Inversa', kpisRpc: 'wh_inventory_kpis', detailRpc: 'wh_inventory_kpi_detail',
  pages: [
    { key: 'A', label: 'Resumen de Jefatura', codes: ['E1', 'R2', 'R4', 'P1', 'R7', 'R8', 'B1', 'C1'] },
    { key: 'B', label: 'Control de inventario', codes: ['E1', 'E2', 'C1', 'C2', 'C3'] },
    { key: 'C', label: 'Retornos y saldos de obra', codes: ['R1', 'R2', 'R3', 'R5', 'R6', 'R7', 'B1'] },
    { key: 'D', label: 'Reprocesos', codes: ['P1', 'P2', 'P3'] },
    { key: 'E', label: 'Pendientes y calidad de datos', codes: ['R4', 'R9', 'R8', 'E2'] },
  ],
  filters: [{ key: 'cliente', label: 'Cliente', placeholder: 'Nombre' }, { key: 'ot', label: 'OT', placeholder: 'p. ej. 16339' }, { key: 'motivo', label: 'Motivo', options: MOTIVOS }, { key: 'disposition', label: 'Disposición', options: DISPOSICIONES }],
  category: null,
  trend: { a: { code: 'R7', label: 'Recuperación %' }, b: { code: 'R2', label: 't devueltas' }, title: 'Tendencia semanal: toneladas devueltas y recuperación', pages: ['A', 'C'] },
}
export default function Page() { return <DispatchKpiDashboard config={INVENTORY_BOARD}/> }
