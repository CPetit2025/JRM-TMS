'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FileText, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { DOCS_BUCKET, receiptUrl } from '@/lib/caja'

// Documentos del viaje para el conductor: guías de remisión, packing list y Nota de Despacho que cargó el
// Asistente Documentario. Mientras no estén confirmados la ruta no puede iniciarse (regla en la BD).
// También muestra la tripulación (ayudantes / auxiliares) asignada por Transporte.

type Doc = { id: string; doc_type: string; document_number: string | null; file_path: string; file_name: string | null; transport_request_id: string | null }
type State = { required: boolean; ready: boolean; reissue: boolean; reason: string | null }

const CREW_LABEL: Record<string, string> = {
  AYUDANTE: 'Ayudante', AUXILIAR: 'Auxiliar', ESTIBADOR: 'Estibador', MONTACARGUISTA: 'Montacarguista', OPERADOR_GRUA: 'Operador de grúa', OTRO: 'Otro',
}
const LABEL: Record<string, string> = { GUIA_REMISION: 'Guía', PACKING_LIST: 'Packing list', NOTA_DESPACHO: 'Nota de Despacho', OTRO: 'Documento' }

export function TripDocuments({ dispatchId, requestNumbers }: { dispatchId: string; requestNumbers?: Record<string, string> }) {
  const supabase = useMemo(() => createClient(), [])
  const [docs, setDocs] = useState<Doc[]>([])
  const [state, setState] = useState<State | null>(null)
  const [crew, setCrew] = useState<{ full_name: string; crew_role: string }[]>([])

  useEffect(() => {
    let cancel = false
    const run = async () => {
      const [{ data: d }, { data: s }, { data: c }] = await Promise.all([
        supabase.from('dispatch_documents').select('id, doc_type, document_number, file_path, file_name, transport_request_id')
          .eq('dispatch_id', dispatchId).is('voided_at', null).order('uploaded_at'),
        supabase.from('dispatches').select('docs_required, docs_ready_at, docs_reissue, docs_reissue_reason').eq('id', dispatchId).maybeSingle(),
        supabase.rpc('get_dispatch_crew', { p_dispatch_id: dispatchId }),
      ])
      if (cancel) return
      setDocs((d || []) as Doc[])
      setCrew((c || []) as { full_name: string; crew_role: string }[])
      if (s) setState({ required: !!s.docs_required, ready: !!s.docs_ready_at, reissue: !!s.docs_reissue, reason: s.docs_reissue_reason })
    }
    void run()
    return () => { cancel = true }
  }, [supabase, dispatchId])

  const open = async (path: string) => {
    const url = await receiptUrl(supabase, `${DOCS_BUCKET}/${path}`)
    if (url) window.open(url, '_blank', 'noopener')
  }

  const pending = state?.required && (!state.ready || state.reissue)
  const crewBox = crew.length > 0 && (
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mb-4">
      <h3 className="font-bold text-slate-800 text-sm flex items-center gap-1.5 mb-1"><Users className="w-4 h-4" />Tripulación</h3>
      <ul className="text-sm text-slate-700">
        {crew.map((m, i) => <li key={i}>{m.full_name} <span className="text-xs text-slate-500">· {CREW_LABEL[m.crew_role] || m.crew_role}</span></li>)}
      </ul>
    </div>
  )
  if (!state?.required && docs.length === 0) return crewBox || null

  return (
    <>
    {crewBox}
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mb-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-slate-800 text-sm flex items-center gap-1.5"><FileText className="w-4 h-4" />Documentos del viaje</h3>
        {state?.required && (pending
          ? <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{state.reissue ? 'Por reemitir' : 'Pendientes'}</span>
          : <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Listos</span>)}
      </div>
      {pending && (
        <p className="text-xs text-amber-700 mb-2">
          {state?.reissue ? `Las guías deben reemitirse (${state.reason || 'cambió el despacho'}).` : 'El Asistente Documentario aún no confirma las guías.'} No podrás iniciar la ruta hasta que estén listas.
        </p>
      )}
      {docs.length === 0 ? <p className="text-xs text-slate-400">Aún no hay documentos cargados.</p> : (
        <ul className="space-y-1.5">
          {docs.map(d => (
            <li key={d.id}>
              <button onClick={() => open(d.file_path)} className="w-full text-left flex items-center gap-2 text-sm text-blue-700 active:bg-slate-50 rounded p-1">
                {/\.(xlsx|xls|csv)$/i.test(d.file_name || d.file_path) ? <FileSpreadsheet className="w-4 h-4 text-emerald-600 shrink-0" /> : <FileText className="w-4 h-4 shrink-0" />}
                <span className="truncate">{LABEL[d.doc_type] || 'Documento'} {d.document_number || ''}
                  {d.transport_request_id && requestNumbers?.[d.transport_request_id] ? ` · ${requestNumbers[d.transport_request_id]}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
    </>
  )
}
