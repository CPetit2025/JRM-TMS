'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import type { DeliveryRow } from '@/lib/delivery'
import type { DetailTab } from '@/lib/dispatch-detail'
import { DispatchDetailModal } from '@/components/despacho/detalle/DispatchDetailModal'

const supabase = createClient()

/** Abre, desde la jornada, el detalle del despacho de Torre de Control (documentos, evidencias y costos originales) */
export function JornadaDispatchDetail({ dispatchId, requestId, tab, onClose }: { dispatchId: string; requestId?: string; tab: DetailTab; onClose: () => void }) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null)
  const [current, setCurrent] = useState<DeliveryRow | null>(null)
  useEffect(() => {
    let alive = true
    void supabase.rpc('delivery_tracking_rows', { p_dispatches: [dispatchId] }).then(({ data, error }) => {
      if (!alive) return
      if (error) { toast.error(errorMessage(error)); onClose(); return }
      const list = (data || []) as DeliveryRow[]
      if (!list.length) { toast.error('Sin acceso al detalle de esta ruta'); onClose(); return }
      setRows(list); setCurrent(list.find(r => r.request_id === requestId) || list[0])
    })
    return () => { alive = false }
  }, [dispatchId, requestId, onClose])
  if (!rows || !current) return null
  return <DispatchDetailModal row={current} routeRows={rows} onSelect={setCurrent} onClose={onClose} initialTab={tab} />
}
