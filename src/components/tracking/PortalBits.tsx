'use client'
import { useState } from 'react'
import { FileCheck2, FileSpreadsheet, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { openPortalDocument, originStyle, type PortalOrigin, type PortalRow, type PortalTone } from '@/lib/tracking-portal'

export function OriginBadge({ origin }: { origin: PortalOrigin }) {
  const s = originStyle(origin)
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${s.chip}`}>{s.label}</span>
}

/** Estado con fondo de color que sube y baja de intensidad (se detiene si el usuario pide reducir movimiento). */
export function StatusPill({ tone }: { tone: PortalTone }) {
  return <span className="relative inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold">
    <span aria-hidden className={`absolute inset-0 rounded-full ${tone.bg} motion-safe:animate-pulse`} />
    <span className={`relative ${tone.text}`}>{tone.label}</span>
  </span>
}

/** Packing List (Documentario) y guía de remisión subida por el conductor (app o enlace). */
export function PortalDocButtons({ row, access, emptyText = 'La guía aparece cuando el conductor la sube.' }: { row: PortalRow; access: { token: string; pin: string }; emptyText?: string }) {
  const [busy, setBusy] = useState('')
  const open = async (key: string, target: Parameters<typeof openPortalDocument>[1]) => {
    setBusy(key)
    try { await openPortalDocument(access, target) } catch (e) { toast.error(e instanceof Error ? e.message : 'Documento no disponible') } finally { setBusy('') }
  }
  const packing = (row.documents || []).filter(d => d.type === 'PACKING_LIST')
  const guides = Math.min(row.signed_photos || 0, 5)
  return <div className="flex flex-wrap items-center gap-1.5">
    {packing.map(d => <button key={d.id} type="button" disabled={busy === d.id} onClick={() => void open(d.id, { kind: 'DOC', id: d.id })} title={d.name || 'Packing List'}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-[#002855] hover:bg-slate-50 disabled:opacity-60">
      {busy === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}Packing List
    </button>)}
    {Array.from({ length: guides }, (_, n) => {
      const key = `${row.dispatch_id}-${row.request_id}-${n}`
      return <button key={key} type="button" disabled={busy === key} onClick={() => void open(key, { kind: 'FIRMA', dispatchId: row.dispatch_id, requestId: row.request_id, index: n + 1 })}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-60">
        {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCheck2 className="h-3.5 w-3.5" />}Guía de remisión{guides > 1 ? ` ${n + 1}` : ''}{row.guide_number && n === 0 ? ` ${row.guide_number}` : ''}
      </button>
    })}
    {!packing.length && !guides && <span className="text-xs text-slate-400">{emptyText}</span>}
  </div>
}
