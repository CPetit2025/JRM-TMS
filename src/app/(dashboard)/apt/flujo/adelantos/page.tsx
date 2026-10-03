'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Archive, CalendarClock, FileSignature, Repeat, Warehouse, Wrench } from 'lucide-react'
import { flowApi } from '@/lib/apt/api'
import { fmtDate, fmtDias, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { traceHref, useFlowFilters } from '@/lib/apt/useFlowFilters'
import type { FlowAdelantos } from '@/lib/apt/flowTypes'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { diffDays, useAptQuery } from '@/components/apt/TfcShared'
import { AsignacionMensual, ConsumoResumen, ContratosBars, Movimientos540, Saldo540Donut, finDeMes } from '@/components/apt/flow/AdelantosCharts'
import { CambiosTable, ConsumosTable, ContratosTable } from '@/components/apt/flow/AdelantosTables'

// Adelantos y 540: cuánto material sin contrato (adelantos IPT en 540) recibió contrato al pasar a ST, cuánto se reasignó
// de una OT a otra, qué queda en el 540 (en suspensión) y qué se consumió internamente.

const RECIENTE_DIAS = 30

export default function AdelantosPage() {
  const { filters, patchFilters, setFilters, filterKey } = useFlowFilters()
  const router = useRouter()
  const fetcher = useCallback(() => flowApi.adelantos(filters), [filters])
  const { data, error, loading, retry } = useAptQuery<FlowAdelantos>(fetcher)

  const onMes = useCallback((mes: string) => patchFilters({ desde: mes.slice(0, 10), hasta: finDeMes(mes) }), [patchFilters])
  const onContrato = useCallback((c: string) => router.push(traceHref(c)), [router])

  const header = (
    <div>
      <h2 className="text-base font-black text-slate-900">Adelantos y almacén 540</h2>
      <p className="text-xs text-slate-500">
        El 540 guarda stock antiguo y adelantos de producción con IPT pero sin contrato. Al pasar a ST VENTAS el lote cambia a un contrato
        (asignación). Algunos traspasos 647→ST cambian de OT (reasignación). El 540 está en suspensión: no debería recibir ingresos.
      </p>
    </div>
  )

  if (error && !data) return <div className="space-y-4">{header}<ErrorBlock message={error} onRetry={retry} /></div>
  if (!data) return <div className="space-y-4">{header}<LoadingBlock label="Calculando adelantos y 540…" className="h-96" /></div>
  if (data.vacio) {
    return (
      <div className="space-y-4">{header}
        <EmptyState title={filterKey ? 'Sin movimientos con los filtros aplicados' : 'Aún no hay movimientos del flujo multi‑almacén'}>
          {filterKey
            ? <button onClick={() => setFilters({})} className="mt-1 font-semibold text-[#002855] underline">Quitar filtros</button>
            : <>Cargue las hojas de traspasos y consumos en <Link href="/apt/cargas" className="font-semibold text-[#002855] underline">Cargas y parámetros</Link>.</>}
        </EmptyState>
      </div>
    )
  }

  const k = data.kpis
  const asigIniPct = k.asignacion_tn > 0 ? (k.asignacion_inicial_tn / k.asignacion_tn) * 100 : null
  const diasUltimo = k.ultimo_ingreso_540 && data.cutoff ? diffDays(data.cutoff, k.ultimo_ingreso_540) : null
  const reciente = diasUltimo !== null && diasUltimo <= RECIENTE_DIAS
  const inicialConsumido = Math.max(k.inicial_540_tn - k.inicial_540_saldo_tn, 0)

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      {header}

      {reciente && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 shadow-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>
            <b>El 540 recibió ingresos el {fmtDate(k.ultimo_ingreso_540)}</b> (hace {fmtDias(diasUltimo)} días respecto al corte).
            Si el almacén está suspendido, revise ese ingreso: {fmtTn(k.ingresos_540_tn)} TN ingresaron al 540 en el periodo.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Asignación de contrato" value={fmtTn(k.asignacion_tn)} unit="TN" tone="warn" icon={<FileSignature className="h-4 w-4" />}
          hint={<>{fmtInt(k.asignacion_filas)} filas · {fmtInt(k.asignacion_lotes)} lotes · espera sin contrato <b>{fmtDias(k.asignacion_dias_pond)} d</b> (ponderado por TN)</>} />
        <KpiCard label="Asignado desde stock previo" value={fmtTn(k.asignacion_inicial_tn)} unit="TN" icon={<Archive className="h-4 w-4" />}
          hint={<>{fmtPct(asigIniPct)} de lo asignado existía antes del primer día cargado; su antigüedad real es desconocida</>} />
        <KpiCard label="Reasignación OT→OT" value={fmtTn(k.reasignacion_tn)} unit="TN" tone="navy" icon={<Repeat className="h-4 w-4" />}
          hint={<>{fmtInt(k.reasignacion_filas)} filas: material de una OT que se guió con otra (647→ST)</>} />
        <KpiCard label="Saldo en 540" value={fmtTn(k.saldo_540_tn)} unit="TN" tone={k.saldo_540_tn > 0 ? 'warn' : 'ok'} icon={<Warehouse className="h-4 w-4" />}
          hint={<>Stock previo inferido {fmtTn(k.inicial_540_tn)} TN → queda <b>{fmtTn(k.inicial_540_saldo_tn)}</b> ({fmtTn(inicialConsumido)} TN ya salieron)</>} />
        <KpiCard label="Último ingreso a 540" value={k.ultimo_ingreso_540 ? fmtDate(k.ultimo_ingreso_540) : 'Ninguno'} tone={reciente ? 'crit' : 'ok'}
          icon={<CalendarClock className="h-4 w-4" />}
          hint={reciente ? <>Reciente: el 540 está en suspensión. Ingresos del periodo: {fmtTn(k.ingresos_540_tn)} TN</> : <>Ingresos del periodo: {fmtTn(k.ingresos_540_tn)} TN</>} />
        <KpiCard label="Consumo interno (V/C)" value={fmtTn(k.consumo_tn)} unit="TN" icon={<Wrench className="h-4 w-4" />}
          hint="Vales de consumo: material que salió para uso interno (OP/OT), no al cliente" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Asignación vs reasignación por mes" subtitle="TN que cambiaron de lote al pasar a ST · línea: días de espera sin contrato"
          info="Asignación: un adelanto del 540 (lote corto, sin contrato) pasa a ST con lote de contrato. Reasignación: material de una OT que pasa a ST con otra OT. Clic en un mes para filtrarlo.">
          {data.mensual.length ? <AsignacionMensual data={data.mensual} onMes={onMes} /> : <p className="py-16 text-center text-sm text-slate-500">Sin cambios de lote en el periodo.</p>}
        </ChartCard>
        <ChartCard title="540 mes a mes" subtitle="Ingresos por tipo (arriba) y salidas por tipo (abajo) · línea: stock previo del 540 que llegó al cliente"
          info="Muestra cómo se vacía el 540. Lo ideal mientras está suspendido: sin ingresos, solo salidas hacia ST (asignación) o consumo.">
          {data.mensual_540.length ? <Movimientos540 data={data.mensual_540} onMes={onMes} /> : <p className="py-16 text-center text-sm text-slate-500">Sin movimientos del 540 en el periodo.</p>}
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="¿Qué queda en el 540?" subtitle="Saldo al corte por origen"
          info="Stock previo: existía antes del primer día cargado; su antigüedad real es desconocida. Producción: adelantos fabricados en el periodo que aún no tienen contrato.">
          <Saldo540Donut data={data.saldo_540_origen} />
        </ChartCard>
        <ChartCard title="Contratos que recibieron material" subtitle={`Top por TN · ${fmtInt(data.contratos.length)} contratos en total · clic para ver su trazabilidad`} className="xl:col-span-2">
          {data.contratos.length ? <ContratosBars data={data.contratos} onSelect={onContrato} /> : <p className="py-16 text-center text-sm text-slate-500">Sin contratos asignados en el periodo.</p>}
        </ChartCard>
      </div>

      <ChartCard title="Contratos asignados" subtitle="Detalle por contrato: TN recibidas, lotes de origen y fechas" bodyClassName="p-0">
        <ContratosTable rows={data.contratos} />
      </ChartCard>

      <ChartCard title="Cambios de lote" subtitle="Cada traspaso a ST que cambió el lote: de qué adelanto u OT vino y a qué contrato fue"
        info="Días espera: desde la producción del adelanto hasta que recibió contrato (ponderado). Sin dato cuando el material era stock previo." bodyClassName="p-0">
        <CambiosTable rows={data.cambios} />
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Consumos internos por almacén" subtitle="Vales de consumo (V/C) por tipo de documento relacionado">
          <ConsumoResumen data={data.consumos_resumen} />
        </ChartCard>
        <ChartCard title="Consumos internos (V/C)" subtitle="Material que salió de APT para uso interno: no llega al cliente" className="xl:col-span-2" bodyClassName="p-0">
          <ConsumosTable rows={data.consumos} />
        </ChartCard>
      </div>
    </div>
  )
}
