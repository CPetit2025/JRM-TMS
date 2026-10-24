'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { ChartCard } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'
import { fmtN } from '@/lib/inventario/format'
import { notifyInvUpdated } from '@/lib/inventario/api'
import { descartarFotoStock, recalcularTodo, vinculacionEstado, type VinculacionEstado } from '@/lib/inventario/vinculacion'

// Qué tiene cada módulo de la carga única y qué quedó sin vincular o sin calcular
function hallazgos(e: VinculacionEstado) {
  const out: Array<{ tone: 'warn' | 'error'; text: React.ReactNode }> = []
  const inv = e.inventario, apt = e.clasico, ana = e.analitica
  if (inv.sin_usar > 0) out.push({ tone: 'error', text: <>Hay una foto de stock al <b>{fmtDate(inv.snapshot_cutoff)}</b>: el inventario calcula desde el <b>{fmtDate(inv.model_from)}</b> y deja sin usar <b>{fmtN(inv.sin_usar)}</b> movimientos del {fmtDate(inv.sin_usar_desde)} al {fmtDate(inv.sin_usar_hasta)}.</> })
  if (inv.cargas_en_preparacion > 0) out.push({ tone: 'warn', text: <>{fmtN(inv.cargas_en_preparacion)} carga(s) del inventario quedaron en preparación (sin terminar): el recálculo programado espera hasta 45 minutos. Vuelva a aplicar la carga para completarlas.</> })
  if (inv.dirty) out.push({ tone: 'warn', text: 'El inventario tiene cambios sin recalcular.' })
  if (inv.data_max && (!apt.data_max || apt.data_max < inv.data_max)) out.push({ tone: 'error', text: <>El APT clásico (y el peso APT de los servicios) llega hasta el <b>{fmtDate(apt.data_max)}</b> y el inventario hasta el <b>{fmtDate(inv.data_max)}</b>: la última carga no se aplicó al APT clásico. Vuelva a aplicar la carga.</> })
  if (inv.data_min && apt.data_min && apt.data_min > inv.data_min) out.push({ tone: 'warn', text: <>El APT clásico empieza el {fmtDate(apt.data_min)} y el inventario el {fmtDate(inv.data_min)}.</> })
  if (apt.corte_manual && apt.data_max && apt.corte_manual < apt.data_max) out.push({ tone: 'error', text: <>El APT clásico tiene un <b>corte manual al {fmtDate(apt.corte_manual)}</b>: lo posterior no se calcula. Quítelo en <Link href="/apt/clasico/cargas" className="font-semibold underline">Parámetros del APT clásico</Link>.</> })
  if (inv.data_max && (!ana.hasta || ana.hasta < inv.data_max)) out.push({ tone: 'error', text: <>La Analítica llega hasta el <b>{fmtDate(ana.hasta)}</b>{ana.importaciones ? '' : ' (sin importaciones)'} y el inventario hasta el <b>{fmtDate(inv.data_max)}</b>. Vuelva a aplicar la carga: ahora también se importa a la Analítica.</> })
  if (inv.data_min && ana.desde && ana.desde > inv.data_min) out.push({ tone: 'warn', text: <>La Analítica empieza el {fmtDate(ana.desde)} y el inventario el {fmtDate(inv.data_min)}.</> })
  return out
}

export function VinculacionPanel({ canLoad, reloadKey }: { canLoad: boolean; reloadKey?: number }) {
  const [estado, setEstado] = useState<VinculacionEstado | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [avisos, setAvisos] = useState<string[] | null>(null)
  const load = useCallback(() => { vinculacionEstado().then(e => { setEstado(e); setError(null) }).catch(e => setError(e instanceof Error ? e.message : 'No se pudo consultar')) }, [])
  useEffect(() => { load() }, [load, reloadKey])

  const todo = async () => {
    setAvisos(null)
    try { setAvisos(await recalcularTodo(m => setBusy(m))) } finally { setBusy(null); notifyInvUpdated(); load() }
  }
  const descartar = async () => {
    if (!window.confirm('Se descarta la foto de stock y el inventario vuelve a calcular con todos los movimientos cargados. ¿Continuar?')) return
    setAvisos(null)
    try { setAvisos(await descartarFotoStock(m => setBusy(m))) } catch (e) { setAvisos([e instanceof Error ? e.message : 'No se pudo descartar']) } finally { setBusy(null); notifyInvUpdated(); load() }
  }
  if (error) return <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Estado de vinculación: {error}</p>
  if (!estado) return null
  const inv = estado.inventario, apt = estado.clasico, ana = estado.analitica
  const h = hallazgos(estado)
  return <ChartCard title="Estado de vinculación" subtitle="Una carga alimenta el inventario, el APT clásico (y el peso APT de los servicios) y la Analítica: rango que tiene cada uno y desde dónde calcula">
    <div className="space-y-3">
      <Table head={<tr><th className={th}>Módulo</th><th className={th}>Datos</th><th className={th}>Calcula desde</th><th className={`${th} text-right`}>Registros</th><th className={th}>Último cálculo</th></tr>}>
        <tr><td className={`${td} font-semibold`}>Inventario multi‑almacén</td><td className={td}>{fmtDate(inv.data_min)} – {fmtDate(inv.data_max)}</td>
          <td className={td}>{inv.model_from ? <span className="font-semibold text-red-700">{fmtDate(inv.model_from)} (foto de stock)</span> : 'Primer movimiento'}</td>
          <td className={tdNum}>{fmtN(inv.movimientos)}</td><td className={td}>{fmtDateTime(inv.rebuilt_at)}{inv.dirty ? ' · pendiente' : ''}</td></tr>
        <tr><td className={`${td} font-semibold`}>APT clásico · servicios</td><td className={td}>{fmtDate(apt.data_min)} – {fmtDate(apt.data_max)}</td>
          <td className={td}>{apt.corte_manual ? <span className="font-semibold text-red-700">Corte manual {fmtDate(apt.corte_manual)}</span> : `Corte ${fmtDate(apt.cutoff)}`}</td>
          <td className={tdNum}>{fmtN(estado.servicios.con_peso)} servicios con peso</td><td className={td}>{fmtDateTime(apt.rebuilt_at)}</td></tr>
        <tr><td className={`${td} font-semibold`}>Analítica APT y Distribución</td><td className={td}>{fmtDate(ana.desde)} – {fmtDate(ana.hasta)}</td>
          <td className={td}>{fmtN(ana.importaciones)} importación(es) vigentes</td><td className={tdNum}>{fmtN(ana.filas)}</td><td className={td}>{fmtDateTime(ana.ultima)}</td></tr>
      </Table>
      {h.length === 0
        ? <p className="flex items-center gap-2 rounded-lg bg-emerald-50 p-2 text-xs font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" />Los tres módulos cubren el mismo rango y están calculados.</p>
        : h.map((x, i) => <p key={i} role={x.tone === 'error' ? 'alert' : undefined} className={`flex items-start gap-2 rounded-lg p-2 text-xs ${x.tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{x.text}</span></p>)}
      {canLoad && <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void todo()} disabled={!!busy} className="flex min-h-10 items-center gap-2 rounded-lg border border-[#002855] px-4 text-sm font-semibold text-[#002855] disabled:opacity-60">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Recalcular y vincular todo</button>
        {inv.sin_usar > 0 && <button type="button" onClick={() => void descartar()} disabled={!!busy} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#cf152d] px-4 text-sm font-semibold text-white disabled:opacity-60">
          Descartar la foto de stock del {fmtDate(inv.snapshot_cutoff)}</button>}
        <span className="text-xs text-slate-500">{busy ?? 'Rehace el inventario, la estadía y el flujo del APT clásico y el peso APT de los servicios con lo ya cargado (no vuelve a subir archivos).'}</span>
      </div>}
      {avisos && (avisos.length
        ? avisos.map((a, i) => <p key={i} className="text-xs text-amber-800">{a}</p>)
        : <p className="text-xs font-semibold text-emerald-700">Recalculado y vinculado.</p>)}
    </div>
  </ChartCard>
}
