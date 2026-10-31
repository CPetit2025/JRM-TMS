'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { receiptUrl } from '@/lib/caja'
import type { DispatchFiles, RouteEvidence } from '@/lib/dispatch-detail'

/**
 * Documentos y evidencias de la parada; se piden solo al abrir esas pestañas (enabled). Las URL se firman al cargar
 * (10 min) y nunca se guardan: los documentos están en dispatch_documents y las fotos del app en driver_evidence.
 */
export function useDispatchFiles(dispatchId: string, requestId: string, enabled: boolean) {
  const db = useMemo(() => createClient(), [])
  const [state, setState] = useState<{ key: string; files: DispatchFiles | null; route: RouteEvidence[]; urls: Record<string, string | null>; error: string }>({ key: '', files: null, route: [], urls: {}, error: '' })
  const [attempt, setAttempt] = useState(0)
  const key = `${dispatchId}/${requestId}/${attempt}`
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      try {
        const [files, evidence] = await Promise.all([
          db.rpc('get_dispatch_detail_files', { p_dispatch: dispatchId, p_request: requestId }),
          db.rpc('get_dispatch_evidence', { p_dispatch_id: dispatchId }),
        ])
        if (files.error || !files.data) throw new Error(files.error?.message || 'No se encontró el despacho.')
        const data = files.data as DispatchFiles, route = ((evidence.data || []) as RouteEvidence[]).filter(r => r.path)
        const paths = [...data.documents.map(d => `dispatch_documents/${d.file_path}`), ...(data.evidence || []).map(e => `dispatch_documents/${e.file_path}`), ...data.submissions.flatMap(s => [...s.photos, ...s.packing_photos]),
          ...(data.rejection?.photos || []), ...route.map(r => r.path)]
        const urls = Object.fromEntries(await Promise.all([...new Set(paths)].map(async p => [p, await receiptUrl(db, p).catch(() => null)] as const)))
        if (alive) setState({ key, files: data, route, urls, error: '' })
      } catch (e) {
        if (alive) setState({ key, files: null, route: [], urls: {}, error: e instanceof Error ? e.message : 'No se pudieron cargar los documentos.' })
      }
    })()
    return () => { alive = false }
  }, [db, dispatchId, requestId, key, enabled])
  const current = state.key === key
  return { files: current ? state.files : null, route: current ? state.route : [], urls: current ? state.urls : {}, error: current ? state.error : '', loading: !current, reload: () => setAttempt(n => n + 1) }
}
