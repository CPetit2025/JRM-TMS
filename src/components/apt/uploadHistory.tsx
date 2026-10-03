'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtDateTime, fmtInt, fmtTn } from '@/lib/apt/format'
import { APT_KINDS, APT_KIND_LABEL } from '@/lib/apt/parseWorkbook'
import type { AptUpload, AptUploadSummaryKey, AptUploadSummaryKind } from '@/lib/apt/types'
import { KIND_STYLE } from './uploadCoverage'
import { ChartCard, EmptyState, ErrorBlock, LoadingBlock } from './ui'

// Historial de cargas aplicadas o descartadas (las que están a medio subir no se muestran)

const STATUS_CLS: Record<AptUpload['status'], string> = {
  APLICADA: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DESCARTADA: 'bg-slate-50 text-slate-500 border-slate-200',
  CARGANDO: 'bg-amber-50 text-amber-700 border-amber-200',
}

// Tipos de hoja como columnas: ENTRADA y SALIDA siempre; los demás solo si alguna carga los trae
const ALL_KINDS = APT_KINDS.map(k => ({ kind: k, key: k.toLowerCase() as AptUploadSummaryKey, label: APT_KIND_LABEL[k] }))

function KindCells({ k }: { k?: AptUploadSummaryKind }) {
  if (!k) return <td colSpan={5} className="border-l border-slate-100 px-2 py-2 text-center text-xs text-slate-300">—</td>
  return (
    <>
      <td className="border-l border-slate-100 px-2 py-2 text-right tabular-nums">{fmtInt(k.filas)}</td>
      <td className="px-2 py-2 text-right tabular-nums">
        {fmtInt(k.validas)}
        {k.excluidas > 0 && <span className="ml-1 text-[11px] text-amber-600" title="Filas excluidas">({fmtInt(k.excluidas)})</span>}
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-slate-600">{fmtDate(k.desde)} – {fmtDate(k.hasta)}</td>
      <td className="px-2 py-2 text-right font-semibold tabular-nums text-[#002855]">{fmtTn(k.tn)}</td>
      <td className="px-2 py-2 text-right tabular-nums text-slate-600">{fmtInt(k.reemplazadas)}</td>
    </>
  )
}

export function UploadHistory() {
  const [rows, setRows] = useState<AptUpload[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    aptApi.uploads().then(d => { setRows(d as AptUpload[]); setError(null) }).catch(e => setError(e instanceof Error ? e.message : 'No se pudo cargar el historial'))
  }, [])

  useEffect(() => {
    load()
    window.addEventListener('apt:updated', load)
    return () => window.removeEventListener('apt:updated', load)
  }, [load])

  const KINDS = ALL_KINDS.filter(k => k.kind === 'ENTRADA' || k.kind === 'SALIDA' || rows?.some(u => u.summary?.[k.key]))

  const exportar = () => {
    if (!rows) return
    exportAptXlsx('APT_historial_cargas', {
      Cargas: rows.map(u => {
        const out: Record<string, unknown> = {
          Fecha: fmtDateTime(u.applied_at || u.created_at), Archivo: u.file_name, Estado: u.status,
        }
        KINDS.forEach(({ key, label }) => {
          const k = u.summary?.[key]
          out[`${label} filas`] = k?.filas ?? null
          out[`${label} válidas`] = k?.validas ?? null
          out[`${label} excluidas`] = k?.excluidas ?? null
          out[`${label} desde`] = k?.desde ? fmtDate(k.desde) : null
          out[`${label} hasta`] = k?.hasta ? fmtDate(k.hasta) : null
          out[`${label} TN`] = k?.tn ?? null
          out[`${label} reemplazadas`] = k?.reemplazadas ?? null
        })
        return out
      }),
    })
  }

  return (
    <ChartCard
      title="Historial de cargas"
      subtitle="Cada carga reemplaza los movimientos de su rango de fechas; “reemplazadas” son las filas anteriores que sustituyó."
      bodyClassName="p-0"
      actions={rows && rows.length > 0 && (
        <button onClick={exportar} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
          <Download className="h-3.5 w-3.5" /> Exportar Excel
        </button>
      )}>
      {error ? <div className="p-4"><ErrorBlock message={error} onRetry={() => { setError(null); load() }} /></div>
        : !rows ? <LoadingBlock label="Cargando historial…" className="h-32" />
        : rows.length === 0 ? <div className="p-4"><EmptyState title="Aún no hay cargas">Cargue el archivo con las hojas ENTRADA y SALIDA y los reportes de traspasos.</EmptyState></div>
        : (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-sm" style={{ minWidth: 360 + KINDS.length * 370 }}>
              <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-slate-200">
                  <th rowSpan={2} className="px-3 py-2 text-left font-bold">Fecha</th>
                  <th rowSpan={2} className="px-2 py-2 text-left font-bold">Archivo</th>
                  <th rowSpan={2} className="px-2 py-2 text-left font-bold">Estado</th>
                  {KINDS.map(k => (
                    <th key={k.key} colSpan={5} className={`border-l border-slate-200 px-2 py-1.5 text-center font-black ${KIND_STYLE[k.kind].text}`}>{k.label}</th>
                  ))}
                </tr>
                <tr className="border-b border-slate-200">
                  {KINDS.map(({ key }) => ['Filas', 'Válidas', 'Rango', 'TN', 'Reempl.'].map((h, i) => (
                    <th key={key + h} className={`px-2 py-1.5 font-semibold ${h === 'Rango' ? 'text-left' : 'text-right'} ${i === 0 ? 'border-l border-slate-200' : ''}`}>{h}</th>
                  )))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(u => (
                  <tr key={u.id} className={`hover:bg-slate-50 ${u.status === 'DESCARTADA' ? 'opacity-60' : ''}`}>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-700">{fmtDateTime(u.applied_at || u.created_at)}</td>
                    <td className="max-w-[260px] truncate px-2 py-2 text-slate-700" title={u.file_name}>{u.file_name}</td>
                    <td className="px-2 py-2">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLS[u.status] || STATUS_CLS.DESCARTADA}`}>
                        {u.status === 'APLICADA' ? 'Aplicada' : u.status === 'DESCARTADA' ? 'Descartada' : 'Cargando'}
                      </span>
                    </td>
                    {KINDS.map(k => <KindCells key={k.key} k={u.summary?.[k.key]} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </ChartCard>
  )
}
