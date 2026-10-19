'use client'

import Link from 'next/link'
import { AlertTriangle, CheckCircle2, CircleDashed, Download, ShieldCheck, XCircle } from 'lucide-react'
import { ChartCard } from '@/components/apt/ui'
import { KindBadge, Table, td, tdNum, th } from '@/components/inventario/parts'
import { KIND_LABEL, fmtN1, fmtQty } from '@/lib/inventario/format'
import type { InvCheckState, InvVerify } from '@/lib/inventario/types'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate } from '@/lib/apt/format'

const STATE: Record<InvCheckState, { icon: typeof CheckCircle2; cls: string; label: string }> = {
  OK: { icon: CheckCircle2, cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', label: 'Cumple' },
  AVISO: { icon: AlertTriangle, cls: 'border-amber-200 bg-amber-50 text-amber-900', label: 'Revisar' },
  FALLA: { icon: XCircle, cls: 'border-red-200 bg-red-50 text-red-800', label: 'No cumple' },
  SIN_DATOS: { icon: CircleDashed, cls: 'border-slate-200 bg-slate-50 text-slate-600', label: 'Sin datos' },
}

function valueText(c: InvVerify['checks'][number]) {
  if (c.valor === null) return STATE[c.estado].label
  if (c.unidad === '%') return `${fmtN1(c.valor)} % (meta ≥ ${c.meta} %)`
  if (c.unidad === 'bodegas') return `${c.valor} de ${c.meta} bodegas`
  if (c.unidad === 'huecos') return `${c.valor} hueco(s)`
  return String(c.valor)
}

// Controles medibles del modelo: cada cifra del inventario indica si cuadra y por qué
export function VerificationPanel({ v, full = false }: { v: InvVerify; full?: boolean }) {
  const score = v.total ? Math.round((v.ok / v.total) * 100) : 0
  const tone = v.checks.some(c => c.estado === 'FALLA') ? 'text-red-700' : v.ok === v.total ? 'text-emerald-700' : 'text-amber-700'
  const exportCuadre = () => exportAptXlsx(`verificacion-inventario-${v.corte ?? ''}`, {
    Controles: v.checks.map(c => ({ Control: c.titulo, Resultado: valueText(c), Estado: STATE[c.estado].label, Detalle: c.detalle })),
    'Cuadre por bodega': v.cuadre.map(r => ({
      Bodega: r.bodega, Tipo: KIND_LABEL[r.kind], Líneas: r.lineas, 'Saldo inicial (foto)': r.saldo_inicial_foto,
      'Saldo inicial (inferido)': r.saldo_inicial_inferido, 'Entradas del archivo': r.entradas_archivo, 'Entradas en el modelo': r.entradas_modelo,
      'Salidas del archivo': r.salidas_archivo, 'Salidas en el modelo': r.salidas_modelo, 'Saldo calculado': r.saldo_calculado,
      'Saldo del modelo': r.saldo_modelo, Diferencia: r.diferencia, Cuadra: r.ok ? 'Sí' : 'No',
    })),
  })
  return (
    <ChartCard title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-[#002855]" /> Confiabilidad de las cifras</span>}
      subtitle={`${v.ok} de ${v.total} controles cumplen · datos ${fmtDate(v.desde)} – ${fmtDate(v.corte)}${v.snapshot_cutoff ? ` · foto de stock al ${fmtDate(v.snapshot_cutoff)}` : ' · sin foto de stock'}`}
      actions={<div className="flex items-center gap-2"><span className={`text-2xl font-black tabular-nums ${tone}`}>{score} %</span>
        {full ? <button type="button" onClick={exportCuadre} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]"><Download className="h-3.5 w-3.5" /> Excel</button>
          : <Link href="/apt/datos" className="text-xs font-semibold text-[#002855] underline">Ver detalle</Link>}</div>}>
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {v.checks.map(c => {
          const s = STATE[c.estado]
          const Icon = s.icon
          return <li key={c.id} className={`rounded-lg border p-3 ${s.cls}`}>
            <p className="flex items-center gap-2 text-sm font-bold"><Icon className="h-4 w-4 shrink-0" />{c.titulo}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{valueText(c)}</p>
            {full && <p className="mt-1 text-xs leading-snug opacity-90">{c.detalle}</p>}
          </li>
        })}
      </ul>
      {full && <div className="mt-4">
        <p className="mb-2 text-xs text-slate-500">Cuadre por bodega, en cantidades: saldo calculado = saldo inicial + entradas − salidas del archivo; debe ser igual al saldo del modelo (diferencia 0).</p>
        <Table empty={!v.cuadre.length} head={<tr><th className={th}>Bodega</th><th className={`${th} text-right`}>Inicial</th><th className={`${th} text-right`}>Entradas</th><th className={`${th} text-right`}>Salidas</th><th className={`${th} text-right`}>Saldo calculado</th><th className={`${th} text-right`}>Saldo modelo</th><th className={`${th} text-right`}>Diferencia</th><th className={th}>Cuadra</th></tr>}>
          {v.cuadre.map(r => <tr key={r.bodega} className={r.ok ? '' : 'bg-red-50'}>
            <td className={td}><p className="font-semibold text-slate-800">{r.bodega}</p><KindBadge kind={r.kind} /></td>
            <td className={tdNum}>{fmtQty(r.saldo_inicial_foto + r.saldo_inicial_inferido)}{r.saldo_inicial_inferido > 0 && <p className="text-[10px] text-amber-700">{fmtQty(r.saldo_inicial_inferido)} inferido</p>}</td>
            <td className={tdNum}>{fmtQty(r.entradas_archivo)}</td><td className={tdNum}>{fmtQty(r.salidas_archivo)}</td>
            <td className={tdNum}>{fmtQty(r.saldo_calculado)}</td><td className={tdNum}>{fmtQty(r.saldo_modelo)}</td>
            <td className={`${tdNum} ${r.diferencia ? 'font-bold text-red-700' : ''}`}>{fmtQty(r.diferencia)}</td>
            <td className={td}>{r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="Cuadra" /> : <XCircle className="h-4 w-4 text-red-600" aria-label="No cuadra" />}</td>
          </tr>)}
        </Table>
      </div>}
    </ChartCard>
  )
}
