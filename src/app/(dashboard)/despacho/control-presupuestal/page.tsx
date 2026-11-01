"use client"
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Ban, CheckCircle2, Download, OctagonAlert, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { KpiStatCard } from '@/components/ui/kpi-stat-card'
import { errorMessage, money } from '@/lib/caja'
import { ControlPresupuestalTabs } from '@/components/despacho/ControlPresupuestalTabs'

// Control presupuestal de transporte por OT: consumo = comprometido + ejecutado sobre lo asignado, con los niveles aprobados
// (docs/control-presupuestal/especificacion.md). La OT raíz suma sus subcontratos. Sobre el tope se compromete solo con
// una autorización de Gerencia (Pendientes y autorizaciones). Cada importe abre los movimientos que lo componen.

type Level = 'NORMAL' | 'ALERTA' | 'BLOQUEO' | 'EXCEDIDO' | 'SIN_PARTIDA'
type Position = {
  contract_id: string; code: string; client: string | null; type: string; status: string | null
  allocated_pen: number; reserved_pen: number; consumed_pen: number; used_pen: number; used_pct: number | null
  cap_pen: number; available_to_cap_pen: number; level: Level; operating_pct: number
  override: { pct: number; scope: string; until: string | null; reason: string | null } | null
  authorized_over_cap_pen?: number; pending_authorizations?: number
}
type Settings = { budget_alert_pct: number; budget_cap_pct: number }

const supabase = createClient()
const LEVEL: Record<Level, { label: string; cls: string; bar: string }> = {
  NORMAL: { label: 'Normal', cls: 'bg-emerald-100 text-emerald-800', bar: 'bg-emerald-500' },
  ALERTA: { label: 'Alerta', cls: 'bg-amber-100 text-amber-800', bar: 'bg-amber-500' },
  BLOQUEO: { label: 'Sobre el tope', cls: 'bg-orange-100 text-orange-800', bar: 'bg-orange-600' },
  EXCEDIDO: { label: 'Excedido', cls: 'bg-red-100 text-red-700', bar: 'bg-red-600' },
  SIN_PARTIDA: { label: 'Sin partida', cls: 'bg-slate-100 text-slate-600', bar: 'bg-slate-400' },
}

function exportCsv(rows: Position[]) {
  const head = ['OT', 'Cliente', 'Asignado', 'Comprometido', 'Ejecutado', 'Consumo S/', 'Consumo %', 'Disponible hasta el tope', 'Nivel']
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = rows.map(r => [r.code, r.client, r.allocated_pen, r.reserved_pen, r.consumed_pen, r.used_pen, r.used_pct, r.available_to_cap_pen, LEVEL[r.level].label].map(cell).join(','))
  const url = URL.createObjectURL(new Blob(['﻿' + [head.map(cell).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `control-presupuestal-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
  URL.revokeObjectURL(url)
}

export default function ControlPresupuestalPage() {
  const [rows, setRows] = useState<Position[] | null>(null)
  const [settings, setSettings] = useState<Settings>({ budget_alert_pct: 70, budget_cap_pct: 80 })
  const [level, setLevel] = useState<Level | ''>('')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('budget_positions')
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); setRows([]); return }
    setRows(data.rows as Position[]); if (data.settings) setSettings(data.settings as Settings)
  }, [])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const count = (l: Level) => (rows || []).filter(r => r.level === l).length
  const shown = useMemo(() => (rows || []).filter(r => (!level || r.level === level)
    && (!q.trim() || `${r.code} ${r.client || ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [rows, level, q])
  const toggle = (l: Level) => setLevel(cur => (cur === l ? '' : l))

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title="Control presupuestal" description={`Partida de transporte por OT: comprometido + ejecutado. Tope ${settings.budget_cap_pct} %, alerta desde ${settings.budget_alert_pct} %.`}
        actions={<><button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>
          <button type="button" disabled={!shown.length} onClick={() => exportCsv(shown)} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50 disabled:opacity-50"><Download className="h-4 w-4" />Exportar</button></>} />

      <ControlPresupuestalTabs active="ot" />
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <KpiStatCard label={`Normal (menos de ${settings.budget_alert_pct} %)`} value={count('NORMAL')} tone="emerald" icon={<CheckCircle2 className="h-5 w-5" />} loading={!rows} active={level === 'NORMAL'} onClick={() => toggle('NORMAL')} />
        <KpiStatCard label={`Alerta (${settings.budget_alert_pct}–${settings.budget_cap_pct} %)`} value={count('ALERTA')} tone="amber" icon={<AlertTriangle className="h-5 w-5" />} loading={!rows} active={level === 'ALERTA'} onClick={() => toggle('ALERTA')} />
        <KpiStatCard label={`Sobre el tope (${settings.budget_cap_pct}–100 %)`} value={count('BLOQUEO')} tone="rose" icon={<OctagonAlert className="h-5 w-5" />} loading={!rows} active={level === 'BLOQUEO'} onClick={() => toggle('BLOQUEO')} />
        <KpiStatCard label="Excedidas (más de 100 %)" value={count('EXCEDIDO')} tone="rose" icon={<Ban className="h-5 w-5" />} loading={!rows} active={level === 'EXCEDIDO'} onClick={() => toggle('EXCEDIDO')} />
      </div>

      <label className="relative block max-w-md"><span className="sr-only">Buscar OT o cliente</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="OT o cliente…" className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#002855]" /></label>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {rows === null ? <p className="p-8 text-center text-sm text-slate-500">Cargando…</p>
          : !shown.length ? <p className="p-8 text-center text-sm text-slate-500">No hay OT para los filtros seleccionados.</p>
          : <table className="w-full min-w-[60rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
              <th className="px-3 py-2">OT</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2 text-right">Asignado</th><th className="px-3 py-2 text-right">Comprometido</th>
              <th className="px-3 py-2 text-right">Ejecutado</th><th className="px-3 py-2">Consumo</th><th className="px-3 py-2 text-right">Disponible hasta el tope</th><th className="px-3 py-2">Nivel</th><th className="px-3 py-2"><span className="sr-only">Acciones</span></th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map(r => {
                const pct = Number(r.used_pct ?? 0)
                return <tr key={r.contract_id} className="hover:bg-slate-50">
                  <td className="px-3 py-2"><Link href={`/despacho/control-presupuestal/${r.contract_id}`} title="Análisis financiero de la OT" className="font-bold text-[#002855] underline">{r.code}</Link>
                    {r.override && <span className="block text-[11px] text-slate-500" title={r.override.reason || undefined}>Margen pactado: {r.override.pct} % operativo</span>}</td>
                  <td className="px-3 py-2 text-xs">{r.client || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(Number(r.allocated_pen))}</td>
                  <td className="px-3 py-2 text-right tabular-nums"><Link href={`/despacho/control-presupuestal/movimientos?ot=${r.contract_id}&efecto=COMPROMETIDO`} title="Ver lo comprometido" className="underline decoration-dotted hover:text-[#002855]">{money(Number(r.reserved_pen))}</Link></td>
                  <td className="px-3 py-2 text-right tabular-nums"><Link href={`/despacho/control-presupuestal/movimientos?ot=${r.contract_id}&efecto=EJECUTADO`} title="Ver lo ejecutado" className="underline decoration-dotted hover:text-[#002855]">{money(Number(r.consumed_pen))}</Link></td>
                  <td className="px-3 py-2"><div className="flex items-center gap-2"><div className="h-2 w-28 rounded bg-slate-100" title={`Tope ${settings.budget_cap_pct} %`}>
                    <div className={`h-2 rounded ${LEVEL[r.level].bar}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
                    <span className="tabular-nums text-xs font-semibold">{r.used_pct == null ? '—' : `${pct} %`}</span></div></td>
                  <td className={`px-3 py-2 text-right tabular-nums ${Number(r.available_to_cap_pen) < 0 ? 'font-semibold text-red-700' : ''}`}>{money(Number(r.available_to_cap_pen))}</td>
                  <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${LEVEL[r.level].cls}`}>{LEVEL[r.level].label}</span>
                    {Number(r.authorized_over_cap_pen) > 0 && <span className="block text-[11px] text-slate-500">Autorizado sobre el tope: S/ {money(Number(r.authorized_over_cap_pen))}</span>}
                    {Number(r.pending_authorizations) > 0 && <Link href="/despacho/control-presupuestal/pendientes" className="block text-[11px] font-semibold text-amber-700 underline">{r.pending_authorizations} solicitud(es) pendiente(s)</Link>}</td>
                  <td className="px-3 py-2 text-right">{['ALERTA', 'BLOQUEO'].includes(r.level) && <Link href={`/despacho/control-presupuestal/pendientes?solicitar=${r.contract_id}&codigo=${encodeURIComponent(r.code)}`}
                    className="whitespace-nowrap rounded border border-[#002855] px-2 py-0.5 text-xs font-semibold text-[#002855] hover:bg-slate-50">Solicitar autorización</Link>}</td>
                </tr>
              })}
            </tbody>
          </table>}
      </div>
      <p className="text-[11px] text-slate-500">Comprometido: flete y servicios reservados al programar. Ejecutado: lo consumido al cerrar la ruta, por Caja o por cargos registrados. En flota propia, al cerrar la ruta la tarifa se reemplaza por los costos reales (combustible —real o estimado—, peajes, viáticos, estacionamiento); los gastos de Caja se reparten entre las OT de la ruta por peso o en partes iguales.</p>
    </div>
  )
}
