'use client'
import { useState } from 'react'
import { FileCheck2, FileSpreadsheet, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { openPortalDocument, originStyle, type PortalAccess, type PortalOrigin, type PortalRow, type PortalTone } from '@/lib/tracking-portal'

export function OriginBadge({ origin }: { origin: PortalOrigin }) {
  const s = originStyle(origin)
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${s.chip}`}>{s.label}</span>
}

/** Estado con fondo de color que sube y baja de intensidad (se detiene si el usuario pide reducir movimiento). */
export function StatusPill({ tone }: { tone: PortalTone }) {
  // Luz de estado: punto sólido con halo intermitente en los estados activos (programado, en ruta, cierre operativo).
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone.bg} ${tone.text}`}>
    <span aria-hidden className="relative flex h-2.5 w-2.5">
      {tone.live && <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping ${tone.dot}`} />}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${tone.dot}`} />
    </span>
    {tone.label}
  </span>
}

/** Packing List y guía de remisión que sube el conductor (app o enlace); se conservan los Packing List históricos de Documentario. */
export function PortalDocButtons({ row, access, emptyText = 'La guía aparece cuando el conductor la sube.' }: { row: PortalRow; access: PortalAccess; emptyText?: string }) {
  const [busy, setBusy] = useState('')
  const open = async (key: string, target: Parameters<typeof openPortalDocument>[1]) => {
    setBusy(key)
    try { await openPortalDocument(access, target) } catch (e) { toast.error(e instanceof Error ? e.message : 'Documento no disponible') } finally { setBusy('') }
  }
  const packing = (row.documents || []).filter(d => d.type === 'PACKING_LIST')
  const driverPacking = Math.min(row.packing_photos || 0, 5)
  const guides = Math.min(row.signed_photos || 0, 5)
  return <div className="flex flex-wrap items-center gap-1.5">
    {packing.map(d => <button key={d.id} type="button" disabled={busy === d.id} onClick={() => void open(d.id, { kind: 'DOC', id: d.id })} title={d.name || 'Packing List'}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-[#002855] hover:bg-slate-50 disabled:opacity-60">
      {busy === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}Packing List
    </button>)}
    {Array.from({ length: driverPacking }, (_, n) => {
      const key = `${row.dispatch_id}-${row.request_id}-pk${n}`
      return <button key={key} type="button" disabled={busy === key} onClick={() => void open(key, { kind: 'PACKING', dispatchId: row.dispatch_id, requestId: row.request_id, index: n + 1 })}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-[#002855] hover:bg-slate-50 disabled:opacity-60">
        {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}Packing List{driverPacking > 1 ? ` ${n + 1}` : ''}
      </button>
    })}
    {Array.from({ length: guides }, (_, n) => {
      const key = `${row.dispatch_id}-${row.request_id}-${n}`
      return <button key={key} type="button" disabled={busy === key} onClick={() => void open(key, { kind: 'FIRMA', dispatchId: row.dispatch_id, requestId: row.request_id, index: n + 1 })}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-60">
        {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCheck2 className="h-3.5 w-3.5" />}Guía de remisión{guides > 1 ? ` ${n + 1}` : ''}{row.guide_number && n === 0 ? ` ${row.guide_number}` : ''}
      </button>
    })}
    {!packing.length && !driverPacking && !guides && <span className="text-xs text-slate-400">{emptyText}</span>}
  </div>
}
