'use client'

import { useEffect, useMemo, useState } from 'react'
import { Camera, ExternalLink, FileSpreadsheet, FileText, Loader2, Mic, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmtDate, receiptUrl } from '@/lib/caja'

// Galería de evidencias del app del conductor (fotos, PDF y audio del bucket privado driver_evidence).
// Fuente: get_dispatch_evidence (un despacho), get_vehicle_evidence (una unidad) o una lista de rutas.
// Las URL se firman al mostrarse (10 min); para enlaces permanentes (Excel) usar evidenceLink().

export type EvidenceItem = { kind: string; label: string; path: string; taken_at?: string | null }

const KIND_LABEL: Record<string, string> = {
  DOCUMENTO: 'Guías de remisión y documentos de despacho', ENTREGA: 'Entregas', CHECKLIST: 'Checklist', GUIA: 'Guías y documentos de cierre', ODOMETRO: 'Odómetro',
  FALLA: 'Fallas', GASTO: 'Comprobantes de gasto', ANTICIPO: 'Anticipos', EVIDENCIA: 'Evidencias',
}
const isAudio = (p: string) => /\.(webm|ogg|m4a|mp3|aac|wav)($|\?)/i.test(p)
const isPdf = (p: string) => /\.pdf($|\?)/i.test(p)
const isSheet = (p: string) => /\.(xlsx|xls|csv)($|\?)/i.test(p)

// Enlace permanente que exige sesión y firma la URL al abrirse
export const evidenceLink = (ref: string | null | undefined) =>
  ref ? `${typeof window === 'undefined' ? '' : window.location.origin}/evidencia?ref=${encodeURIComponent(ref)}` : ''

export function EvidenceGallery({ dispatchId, plate, items, title = 'Evidencias del app', limit }: {
  dispatchId?: string; plate?: string; items?: EvidenceItem[]; title?: string; limit?: number
}) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<(EvidenceItem & { url: string | null })[] | null>(null)
  const [zoom, setZoom] = useState<string | null>(null)
  const itemsKey = JSON.stringify(items || null)

  useEffect(() => {
    let cancel = false
    const run = async () => {
      let list: EvidenceItem[] = items || []
      if (!items && dispatchId) list = ((await supabase.rpc('get_dispatch_evidence', { p_dispatch_id: dispatchId })).data || []) as EvidenceItem[]
      else if (!items && plate) list = ((await supabase.rpc('get_vehicle_evidence', { p_plate: plate, p_limit: limit || 60 })).data || []) as EvidenceItem[]
      const signed = await Promise.all(list.filter(i => i.path).map(async i => ({ ...i, url: await receiptUrl(supabase, i.path) })))
      if (!cancel) setRows(signed)
    }
    void run()
    return () => { cancel = true }
    // itemsKey resume items (evita recargar en cada render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, dispatchId, plate, itemsKey, limit])

  const groups = useMemo(() => {
    const g = new Map<string, (EvidenceItem & { url: string | null })[]>()
    ;(rows || []).forEach(r => g.set(r.kind, [...(g.get(r.kind) || []), r]))
    return [...g.entries()]
  }, [rows])

  return (
    <div className="space-y-3">
      <h3 className="font-bold text-slate-800 flex items-center gap-2"><Camera className="w-4 h-4" />{title}{rows ? ` (${rows.length})` : ''}</h3>
      {rows === null ? <div className="p-4 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
        : rows.length === 0 ? <p className="text-sm text-slate-400">Sin evidencias registradas desde el app.</p>
        : groups.map(([kind, list]) => (
          <div key={kind}>
            <div className="text-xs font-bold uppercase text-slate-500 mb-1.5">{KIND_LABEL[kind] || kind}</div>
            <div className="flex flex-wrap gap-2">
              {list.map((r, i) => (
                <div key={`${r.path}-${i}`} className="w-28 text-[10px] text-slate-500">
                  {!r.url ? <div className="h-20 rounded-lg border border-dashed flex items-center justify-center text-center p-1">No disponible</div>
                    : isAudio(r.path) ? <div className="h-20 rounded-lg border flex flex-col items-center justify-center gap-1 p-1"><Mic className="w-4 h-4" /><audio controls src={r.url} className="w-full h-7" /></div>
                    : isPdf(r.path) ? <a href={r.url} target="_blank" rel="noreferrer" className="h-20 rounded-lg border flex flex-col items-center justify-center gap-1 text-blue-700"><FileText className="w-6 h-6" />PDF</a>
                    : isSheet(r.path) ? <a href={r.url} target="_blank" rel="noreferrer" className="h-20 rounded-lg border flex flex-col items-center justify-center gap-1 text-emerald-700"><FileSpreadsheet className="w-6 h-6" />Excel</a>
                    : <button type="button" onClick={() => setZoom(r.url)} className="block w-28 h-20 rounded-lg overflow-hidden border bg-slate-100">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.url} alt={r.label} className="w-full h-full object-cover" loading="lazy" />
                      </button>}
                  <div className="mt-0.5 truncate" title={r.label}>{r.label}</div>
                  {r.taken_at && <div>{fmtDate(r.taken_at, true)}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}
      {zoom && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4" onClick={() => setZoom(null)}>
          <button type="button" className="absolute top-4 right-4 text-white" aria-label="Cerrar"><X className="w-7 h-7" /></button>
          <a href={zoom} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="absolute top-4 left-4 text-white text-sm flex items-center gap-1"><ExternalLink className="w-4 h-4" />Abrir original</a>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="Evidencia" className="max-h-full max-w-full object-contain rounded-lg" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
