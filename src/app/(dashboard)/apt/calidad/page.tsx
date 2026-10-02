'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CheckCircle2, Eye, FileSpreadsheet, ShieldAlert, XCircle } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { APT_COLORS, CLASE_SALIDA_LABEL, ESTADO_STYLE, fmtDate, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import type { AptQuality, AptQualitySheet } from '@/lib/apt/types'
import { ChartCard, EmptyState, ErrorBlock, EstadoBadge, InlineBar, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { AXIS_TICK, ChartTip, ExportButton, Modal, useAptQuery } from '@/components/apt/TfcShared'

// Calidad de datos y conciliación: qué se leyó de ENTRADA y SALIDA, qué se excluyó y si el modelo FIFO cuadra con la fuente

const CLASE_HELP: Record<string, string> = {
  ASIGNADA: 'La salida se descontó por completo de capas ingresadas del mismo lote y producto (FIFO).',
  EXCEDE_INGRESO: 'El lote y el producto ingresaron a APT, pero la salida supera el saldo disponible: el exceso es stock anterior al inicio de los datos o ingresos no registrados.',
  OTRO_PRODUCTO_DEL_LOTE: 'El lote tiene ingresos en APT, pero este producto nunca ingresó por la hoja ENTRADA (p. ej. piezas despachadas sin pasar por APT).',
  LOTE_SIN_INGRESO: 'El lote no tiene ningún ingreso en los datos cargados: ingresó antes del periodo cargado o no pasó por APT.',
  SIN_NUMREL: 'La salida no trae NumRel: no se puede asociar a ningún lote.',
}

type Tone = 'ok' | 'warn' | 'info'
interface Obs { label: string; value: ReactNode; tone: Tone; lectura?: string }

const pctOf = (n: number, d: number) => (d > 0 ? fmtPct((n / d) * 100) : '—')

function Chips({ rec, empty = '—' }: { rec: Record<string, number>; empty?: string }) {
  const items = Object.entries(rec).sort((a, b) => b[1] - a[1])
  if (!items.length) return <span className="text-slate-400">{empty}</span>
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {items.map(([k, n]) => (
        <span key={k} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
          {k} <span className="tabular-nums text-slate-400">{fmtInt(n)}</span>
        </span>
      ))}
    </span>
  )
}

function sheetObs(h: AptQualitySheet, cutoff: string | null): Obs[] {
  const entrada = h.tipo === 'ENTRADA'
  const nUnid = Object.keys(h.unidades).length
  const nBod = Object.keys(h.bodegas).length
  return [
    { label: 'Filas leídas', value: fmtInt(h.filas), tone: 'info' },
    { label: 'Filas válidas', value: `${fmtInt(h.validas)} (${pctOf(h.validas, h.filas)})`, tone: 'info' },
    {
      label: 'Filas excluidas', tone: h.excluidas ? 'warn' : 'ok',
      value: h.excluidas ? <span className="space-y-0.5 text-right">
        <span className="block font-bold">{fmtInt(h.excluidas)}</span>
        {Object.entries(h.motivos_exclusion).map(([m, n]) => <span key={m} className="block text-[10px] font-normal text-slate-500">{m}: {fmtInt(n)}</span>)}
      </span> : '0',
      lectura: h.excluidas ? 'No entran al cálculo; ver la tabla de filas excluidas al final.' : 'Todas las filas se usan en el cálculo.',
    },
    { label: 'Fechas', value: `${fmtDate(h.fecha_min)} – ${fmtDate(h.fecha_max)}`, tone: 'info' },
    { label: 'Días con movimiento', value: fmtInt(h.dias_con_movimiento), tone: 'info' },
    {
      label: 'Posteriores al corte', value: fmtInt(h.posteriores_al_corte), tone: h.posteriores_al_corte ? 'warn' : 'ok',
      lectura: h.posteriores_al_corte ? `Filas con fecha posterior al corte (${fmtDate(cutoff)}): no se consideran hasta mover el corte.` : undefined,
    },
    { label: 'TN (peso)', value: fmtTn(h.tn), tone: 'info' },
    { label: 'Lotes · productos · documentos', value: `${fmtInt(h.lotes)} · ${fmtInt(h.productos)} · ${fmtInt(h.documentos)}`, tone: 'info' },
    {
      label: 'Sin peso', value: `${fmtInt(h.sin_peso)} (${pctOf(h.sin_peso, h.validas)})`, tone: h.sin_peso ? 'warn' : 'ok',
      lectura: !h.sin_peso ? undefined : entrada
        ? 'Capas sin PesoTotalProduccido: no suman TN y se marcan como Problema de información.'
        : 'Salidas sin PesoTotalProduccido: no descuentan saldo. Si corresponden a capas ingresadas, el saldo de ese lote podría quedar sobrestimado.',
    },
    {
      label: 'Sin NumRel', value: fmtInt(h.sin_numrel), tone: h.sin_numrel ? 'warn' : 'ok',
      lectura: h.sin_numrel ? (entrada ? 'Sin NumRel: el lote se toma de la columna Lote.' : 'Salidas sin NumRel: quedan como “Salida sin NumRel” y no descuentan ningún lote.') : undefined,
    },
    ...(entrada ? [{
      label: 'Lote derivado del NumRel', value: fmtInt(h.lote_derivado), tone: (h.lote_derivado ? 'info' : 'ok') as Tone,
      lectura: h.lote_derivado ? 'La columna Lote venía vacía: el lote se obtuvo del NumRel_OP quitando el último sufijo.' : undefined,
    }] : [{
      label: 'ERROR DE CONTRATO asignadas a su lote', value: fmtInt(h.error_contrato_a_lote), tone: 'info' as Tone,
      lectura: h.error_contrato_a_lote ? 'Salidas con DocRel “ERROR DE CONTRATO”: se descuentan del lote indicado en la columna Lote (no del NumRel de la salida).' : undefined,
    }]),
    {
      label: 'Peso inconsistente', value: fmtInt(h.peso_inconsistente), tone: h.peso_inconsistente ? 'warn' : 'ok',
      lectura: h.peso_inconsistente ? 'Cantidad × PesoUnitario difiere del peso total en más de 1 kg; se usa el peso total.' : 'Cantidad × PesoUnitario coincide con el peso total.',
    },
    {
      label: 'Duplicados exactos', value: fmtInt(h.duplicados), tone: h.duplicados ? 'warn' : 'ok',
      lectura: h.duplicados ? 'Filas iguales en documento, producto, NumRel, cantidad y peso. Se conservan (pueden ser líneas repetidas legítimas); conviene revisarlas en el ERP.' : undefined,
    },
    {
      label: 'Unidades', value: <Chips rec={h.unidades} />, tone: nUnid > 1 ? 'info' : 'ok',
      lectura: nUnid > 1 ? 'Unidades mezcladas: el análisis usa peso (PesoTotalProduccido), no la cantidad.' : 'Una sola unidad de medida.',
    },
    {
      label: 'Bodegas', value: <Chips rec={h.bodegas} />, tone: nBod > 1 ? 'warn' : 'ok',
      lectura: nBod > 1 ? 'Hay más de una bodega en la hoja: confirme que todas corresponden al flujo de APT.' : 'Una sola bodega en la hoja.',
    },
    { label: 'DocRel', value: <Chips rec={h.docrels} />, tone: 'info', lectura: entrada ? 'Tipo de documento relacionado de los ingresos.' : 'Tipo de documento de venta de las salidas.' },
  ]
}

const TONE_DOT: Record<Tone, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', info: 'bg-slate-300' }

function SheetCard({ h, cutoff }: { h: AptQualitySheet; cutoff: string | null }) {
  return (
    <ChartCard title={<><FileSpreadsheet className="h-4 w-4 text-[#002855]" /> Hoja {h.tipo}</>}
      subtitle={h.tipo === 'ENTRADA' ? 'P/E Producción · ingresos a APT' : 'Despacho Ventas · salidas de APT'} bodyClassName="p-0">
      <dl className="divide-y divide-slate-100">
        {sheetObs(h, cutoff).map(o => (
          <div key={o.label} className="grid grid-cols-[1fr_auto] gap-x-3 px-4 py-2">
            <dt className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[o.tone]}`} aria-hidden />{o.label}
            </dt>
            <dd className="max-w-[60%] text-right text-xs font-bold tabular-nums text-slate-900 justify-self-end">{o.value}</dd>
            {o.lectura && <p className="col-span-2 mt-0.5 pl-3.5 text-[11px] leading-snug text-slate-500">{o.lectura}</p>}
          </div>
        ))}
      </dl>
    </ChartCard>
  )
}

export default function CalidadPage() {
  const fetcher = useCallback(() => aptApi.quality(), [])
  const { data, error, loading, retry } = useAptQuery<AptQuality>(fetcher)
  const [raw, setRaw] = useState<AptQuality['excluidas'][number] | null>(null)
  const closeRaw = useCallback(() => setRaw(null), [])

  const clases = useMemo(() => (data?.salidas_por_clase ?? []).map(c => ({
    ...c, label: CLASE_SALIDA_LABEL[c.clase] || c.clase, asignado: Math.max(c.tn - c.tn_sin_entrada, 0),
  })), [data])
  const totSal = clases.reduce((s, c) => s + c.tn, 0)
  const totSinEntrada = clases.reduce((s, c) => s + c.tn_sin_entrada, 0)
  const totFilasSal = clases.reduce((s, c) => s + c.filas, 0)
  const capasTot = (data?.capas_por_estado ?? []).reduce((s, c) => s + c.capas, 0)
  const tnCapasTot = (data?.capas_por_estado ?? []).reduce((s, c) => s + c.tn_in, 0)

  const doExport = () => {
    if (!data) return
    const hojaRows = data.hojas.map(h => ({
      Hoja: h.tipo, Filas: h.filas, Validas: h.validas, Excluidas: h.excluidas,
      'Motivos de exclusión': Object.entries(h.motivos_exclusion).map(([k, v]) => `${k}: ${v}`).join('; '),
      'Fecha mín.': fmtDate(h.fecha_min), 'Fecha máx.': fmtDate(h.fecha_max), 'Días con movimiento': h.dias_con_movimiento,
      'Posteriores al corte': h.posteriores_al_corte, TN: h.tn, Lotes: h.lotes, Productos: h.productos, Documentos: h.documentos,
      'Sin peso': h.sin_peso, 'Sin NumRel': h.sin_numrel, 'Lote derivado': h.lote_derivado, 'ERROR DE CONTRATO a lote': h.error_contrato_a_lote,
      'Peso inconsistente': h.peso_inconsistente, 'Duplicados exactos': h.duplicados,
      Unidades: Object.entries(h.unidades).map(([k, v]) => `${k}: ${v}`).join('; '),
      Bodegas: Object.entries(h.bodegas).map(([k, v]) => `${k}: ${v}`).join('; '),
      DocRel: Object.entries(h.docrels).map(([k, v]) => `${k}: ${v}`).join('; '),
    }))
    exportAptXlsx('APT_calidad_datos', {
      Conciliacion: data.conciliacion.map(c => ({ Concepto: c.concepto, 'Fuente TN': c.fuente, 'Modelo TN': c.modelo, Diferencia: c.diferencia, Estado: c.estado, Explicación: c.explicacion })),
      Hojas: hojaRows,
      'Salidas por clase': clases.map(c => ({ Clase: c.label, Código: c.clase, Filas: c.filas, TN: c.tn, 'TN sin entrada': c.tn_sin_entrada, Explicación: CLASE_HELP[c.clase] || '' })),
      'Capas por estado': data.capas_por_estado.map(c => ({ Estado: c.estado, Capas: c.capas, 'TN ingresadas': c.tn_in })),
      'Filas excluidas': data.excluidas.map(e => ({ Hoja: e.tipo, Fila: e.fila, Archivo: e.archivo, Motivo: e.motivo, 'Fila original': JSON.stringify(e.raw) })),
    })
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-base font-black text-slate-900">Calidad de datos y conciliación</h2>
        <p className="text-xs text-slate-500">Qué se leyó de ENTRADA y SALIDA, qué se excluyó y si el modelo FIFO cuadra con la fuente. Sin filtros: siempre sobre toda la información cargada.</p>
      </div>
      {data && <ExportButton onClick={doExport} />}
    </div>
  )

  if (error && !data) return <div className="space-y-4">{header}<ErrorBlock message={error} onRetry={retry} /></div>
  if (!data) return <div className="space-y-4">{header}<LoadingBlock /></div>
  if (!data.hojas?.some(h => h.filas > 0)) {
    return <div className="space-y-4">{header}<EmptyState title="Aún no hay movimientos: cargue ENTRADA y SALIDA" /></div>
  }

  const revisar = data.conciliacion.filter(c => c.estado !== 'OK')
  const allOk = revisar.length === 0
  const ent = data.hojas.find(h => h.tipo === 'ENTRADA')
  const sal = data.hojas.find(h => h.tipo === 'SALIDA')
  const sai = data.salida_antes_de_ingreso

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      {header}

      <div className={`flex items-start gap-3 rounded-xl border p-4 shadow-sm ${allOk ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
        {allOk ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 h-6 w-6 shrink-0 text-red-600" aria-hidden />}
        <div className="text-sm">
          <p className="font-black">{allOk ? 'Conciliación OK' : `Conciliación con ${revisar.length} control(es) por REVISAR`}</p>
          <p className="mt-0.5 text-xs">
            {allOk
              ? `Los ${data.conciliacion.length} controles cuadran: cada TN de la fuente está en el modelo y cada kg despachado se asigna una sola vez. Corte: ${fmtDate(data.cutoff)}.`
              : `Revise: ${revisar.map(r => r.concepto).join(' · ')}. Las cifras del módulo pueden no cuadrar con la fuente.`}
          </p>
        </div>
      </div>
      {!data.historico_suficiente && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
          <p><b>Histórico de entradas insuficiente para calcular Aging completo.</b> Cargue más días de ENTRADA para que la permanencia del saldo sea representativa.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Filas ENTRADA" value={fmtInt(ent?.filas)} tone="navy" hint={`${fmtInt(ent?.validas)} válidas · ${fmtInt(ent?.excluidas)} excluidas`} />
        <KpiCard label="Filas SALIDA" value={fmtInt(sal?.filas)} tone="navy" hint={`${fmtInt(sal?.validas)} válidas · ${fmtInt(sal?.excluidas)} excluidas`} />
        <KpiCard label="TN SALIDA sin entrada" value={fmtTn(totSinEntrada)} unit="TN" tone={totSinEntrada > 0 ? 'warn' : 'ok'}
          hint={`${pctOf(totSinEntrada, totSal)} de las TN despachadas no tienen ingreso identificado`} />
        <KpiCard label="Lotes sin ingreso" value={fmtInt(data.lotes_sin_ingreso)} tone={data.lotes_sin_ingreso ? 'warn' : 'ok'} hint="Lotes con salidas y sin ninguna fila de ENTRADA" />
        <KpiCard label="Salidas antes del ingreso" value={fmtInt(sai.capas)} unit="capas" tone={sai.capas ? 'warn' : 'ok'} hint={`${fmtTn(sai.tn)} TN asignadas con 0 días`} />
        <KpiCard label="Filas excluidas" value={fmtInt((ent?.excluidas ?? 0) + (sal?.excluidas ?? 0))} tone={(ent?.excluidas ?? 0) + (sal?.excluidas ?? 0) ? 'warn' : 'ok'} hint="No entran al cálculo" />
      </div>

      <ChartCard title="Conciliación fuente vs modelo" subtitle="Toneladas de las hojas cargadas frente a lo que reconstruye el modelo FIFO" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-bold">Concepto</th>
                <th className="px-3 py-2 text-right font-bold">Fuente (TN)</th>
                <th className="px-3 py-2 text-right font-bold">Modelo (TN)</th>
                <th className="px-3 py-2 text-right font-bold">Diferencia</th>
                <th className="px-3 py-2 text-center font-bold">Estado</th>
                <th className="px-3 py-2 text-left font-bold">Explicación</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.conciliacion.map(c => (
                <tr key={c.concepto} className={c.estado === 'OK' ? '' : 'bg-red-50/60'}>
                  <td className="px-3 py-2 font-semibold text-slate-800">{c.concepto}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtTn(c.fuente)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtTn(c.modelo)}</td>
                  <td className={`px-3 py-2 text-right font-bold tabular-nums ${c.estado === 'OK' ? 'text-slate-500' : 'text-red-600'}`}>{fmtTn(c.diferencia)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
                      c.estado === 'OK' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                      {c.estado === 'OK' ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <ShieldAlert className="h-3 w-3" aria-hidden />}{c.estado}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{c.explicacion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        {ent && <SheetCard h={ent} cutoff={data.cutoff} />}
        {sal && <SheetCard h={sal} cutoff={data.cutoff} />}
      </div>

      <ChartCard title="Correspondencia de salidas" subtitle={`${fmtInt(totFilasSal)} salidas válidas · ${fmtTn(totSal)} TN · cuánto de cada clase se descuenta de capas ingresadas a APT`}
        info="Cada salida se busca en las capas de ENTRADA del mismo lote y producto. Lo que no encuentra ingreso queda como “sin entrada” y no afecta el saldo de APT.">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={clases} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }} barCategoryGap={6}>
              <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => fmtInt(v)} />
              <YAxis type="category" dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} width={200} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} content={
                <ChartTip fmt={v => `${fmtTn(Number(v))} TN`} extra={r => <>{fmtInt(Number(r.filas))} filas · {pctOf(Number(r.tn), totSal)} de las TN</>} />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="asignado" name="Asignado a capas de APT" stackId="t" fill={APT_COLORS.out} />
              <Bar dataKey="tn_sin_entrada" name="Sin entrada identificada" stackId="t" fill={APT_COLORS.amber} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-bold">Clase</th>
                <th className="px-3 py-2 text-right font-bold">Filas</th>
                <th className="px-3 py-2 text-right font-bold">TN</th>
                <th className="px-3 py-2 text-right font-bold">% TN</th>
                <th className="px-3 py-2 text-right font-bold">TN sin entrada</th>
                <th className="px-3 py-2 text-left font-bold">Lectura</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {clases.map(c => (
                <tr key={c.clase}>
                  <td className="whitespace-nowrap px-3 py-2 font-semibold text-slate-800">{c.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtInt(c.filas)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtTn(c.tn)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pctOf(c.tn, totSal)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${c.tn_sin_entrada > 0.0005 ? 'font-bold text-amber-700' : 'text-slate-400'}`}>{fmtTn(c.tn_sin_entrada)}</td>
                  <td className="min-w-[260px] px-3 py-2 text-slate-500">{CLASE_HELP[c.clase] || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Capas por estado" subtitle={`${fmtInt(capasTot)} capas · ${fmtTn(tnCapasTot)} TN ingresadas`} bodyClassName="p-0">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-bold">Estado</th>
                <th className="px-3 py-2 text-right font-bold">Capas</th>
                <th className="px-3 py-2 text-right font-bold">TN ingresadas</th>
                <th className="w-28 px-3 py-2"><span className="sr-only">Proporción</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.capas_por_estado.map(c => (
                <tr key={c.estado} title={ESTADO_STYLE[c.estado]?.help}>
                  <td className="px-3 py-2"><EstadoBadge estado={c.estado} /></td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtInt(c.capas)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtTn(c.tn_in)} <span className="text-slate-400">({pctOf(c.tn_in, tnCapasTot)})</span></td>
                  <td className="px-3 py-2"><InlineBar value={c.tn_in} max={tnCapasTot} color={ESTADO_STYLE[c.estado]?.color} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>

        <ChartCard title="Salidas registradas antes del ingreso" subtitle="Despachos con fecha anterior a la fecha de ingreso de la capa que consumen">
          <div className="grid grid-cols-2 gap-3">
            <KpiCard label="Capas afectadas" value={fmtInt(sai.capas)} tone={sai.capas ? 'warn' : 'ok'} hint={`${pctOf(sai.capas, capasTot)} de las capas`} />
            <KpiCard label="TN asignadas" value={fmtTn(sai.tn)} unit="TN" tone={sai.tn ? 'warn' : 'ok'} hint={`${pctOf(sai.tn, tnCapasTot)} de las TN ingresadas`} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            El FIFO respeta el orden de los movimientos por lote y producto. Cuando una salida tiene fecha anterior al ingreso de la capa que le
            corresponde (por ejemplo, el parte de producción se registró después del despacho), esos kilos se asignan con <b>0 días</b> de permanencia
            y la capa se marca como <EstadoBadge estado="Problema de información" /> para revisarla en el origen. No alteran el saldo, pero sí indican
            fechas de registro poco confiables.
          </p>
        </ChartCard>
      </div>

      <ChartCard title="Filas excluidas" subtitle={`${fmtInt(data.excluidas.length)} filas${data.excluidas.length >= 200 ? ' (se muestran las primeras 200)' : ''} · no entran al cálculo`} bodyClassName="p-0">
        {data.excluidas.length ? (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500 shadow-[0_1px_0_#e2e8f0]">
                <tr>
                  <th className="px-3 py-2 text-left font-bold">Hoja</th>
                  <th className="px-3 py-2 text-right font-bold">Fila</th>
                  <th className="px-3 py-2 text-left font-bold">Archivo</th>
                  <th className="px-3 py-2 text-left font-bold">Motivo</th>
                  <th className="px-3 py-2"><span className="sr-only">Ver fila original</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.excluidas.map(e => (
                  <tr key={`${e.tipo}-${e.archivo}-${e.fila}`} className="hover:bg-slate-50">
                    <td className="px-3 py-1.5 font-semibold">{e.tipo}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(e.fila)}</td>
                    <td className="px-3 py-1.5 text-slate-500">{e.archivo}</td>
                    <td className="px-3 py-1.5 text-slate-700">{e.motivo}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button type="button" onClick={() => setRaw(e)} aria-label={`Ver fila original ${e.fila} de ${e.tipo}`}
                        className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-[#002855] hover:text-[#002855]">
                        <Eye className="h-3 w-3" /> Ver fila
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="p-4 text-sm text-slate-500">No hay filas excluidas.</p>}
      </ChartCard>

      {raw && (
        <Modal title={`Fila original · ${raw.tipo} · fila ${raw.fila}`} onClose={closeRaw}>
          <p className="mb-3 text-xs text-slate-500">{raw.archivo} · Motivo: <b className="text-slate-700">{raw.motivo}</b></p>
          <table className="w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {Object.entries(raw.raw || {}).map(([k, v]) => (
                <tr key={k}>
                  <th className="w-1/3 px-2 py-1.5 text-left font-semibold text-slate-500">{k}</th>
                  <td className="break-all px-2 py-1.5 font-mono text-slate-800">{v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  )
}
