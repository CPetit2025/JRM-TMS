'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { routeShareText, type RouteShare } from '@/lib/route-share'
import { toast } from 'sonner'

export function RouteShareModal({ ids, onClose }: { ids: string[]; onClose: () => void }) {
 const supabase = useMemo(() => createClient(), [])
 const [routes, setRoutes] = useState<RouteShare[] | null>(null), [error, setError] = useState('')
 useEffect(() => {
  let alive = true
  void supabase.rpc('get_route_share_details', { p_dispatches: ids }).then(({ data, error }) => {
   if (!alive) return
   if (error) setError(error.message)
   else setRoutes(data as RouteShare[])
  })
  return () => { alive = false }
 }, [ids, supabase])
 const text = routes ? routeShareText(routes) : ''
 const copy = async () => { try { await navigator.clipboard.writeText(text); toast.success('Datos de las rutas copiados') } catch { toast.error('Seleccione y copie el texto de la vista previa.') } }
 return <Modal isOpen onClose={onClose} title={`Compartir ${ids.length} ruta(s)`} maxWidth="max-w-3xl" footer={<div className="flex flex-wrap justify-end gap-2">
  <button type="button" disabled={!text} onClick={() => void copy()} className="min-h-10 rounded-lg border px-4 text-sm font-semibold disabled:opacity-50">Copiar datos</button>
  <button type="button" disabled={!text} onClick={() => {
   if (!navigator.share) { void copy(); return }
   void navigator.share({ title: 'Rutas JRM', text }).catch(e => { if (e.name !== 'AbortError') toast.error('No se pudo compartir. Use Copiar datos.') })
  }} className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Compartir</button>
 </div>}>
  <p className="mb-3 text-sm text-slate-600">Revise los datos de las rutas seleccionadas antes de compartirlos.</p>
  {error ? <p role="alert" className="text-red-700">{error}</p> : routes ? <textarea aria-label="Datos para compartir" readOnly value={text} className="min-h-96 w-full rounded-lg border p-3 text-sm" /> : <p role="status">Cargando los datos de las rutas…</p>}
 </Modal>
}
