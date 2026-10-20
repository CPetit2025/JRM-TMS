'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type AutoApproval = { enabled: boolean; can_edit: boolean; updated_at: string | null; updated_by_name: string | null }

// Interruptor central de la aprobación automática de solicitudes de transporte. Lo cambian el Administrador o quien
// aprueba solicitudes; el servidor valida el permiso y guarda cada cambio en el historial.
export function RequestAutoApprovalSettings() {
  const supabase = useMemo(() => createClient(), [])
  const [state, setState] = useState<AutoApproval | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void supabase.rpc('get_request_auto_approval').then(({ data, error: loadError }) => {
      if (cancelled) return
      if (loadError || !data?.success) setError(loadError?.message || data?.error || 'No se pudo consultar la aprobación automática.')
      else setState(data as AutoApproval)
    })
    return () => { cancelled = true }
  }, [supabase])

  const toggle = async (enabled: boolean) => {
    if (!state?.can_edit) return
    if (!window.confirm(enabled
      ? '¿Activar la aprobación automática? Las solicitudes con OT o con OC, OS o RQ sin OT que se registren sin observaciones quedarán aprobadas sin revisión del Supervisor de Despacho. Para las referencias sin OT se autoriza el monto registrado.'
      : '¿Desactivar la aprobación automática? Las nuevas solicitudes volverán a esperar la aprobación del Supervisor de Despacho.')) return
    setSaving(true); setError('')
    const { data, error: saveError } = await supabase.rpc('set_request_auto_approval', { p_enabled: enabled })
    setSaving(false)
    if (saveError || !data?.success) { const message = saveError?.message || data?.error || 'No se guardó el cambio.'; setError(message); toast.error(message); return }
    setState(data as AutoApproval)
    toast.success(enabled ? 'Aprobación automática activada' : 'Aprobación automática desactivada')
  }

  if (!state && !error) return <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Consultando aprobación automática…</p>

  return <div className="space-y-4">
    <div><h2 className="font-semibold text-[#002855]">Aprobación de solicitudes</h2>
      <p className="mt-1 text-sm text-slate-600">Define si las solicitudes de transporte esperan la aprobación del Supervisor de Despacho o se aprueban al registrarse.</p></div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {state && <>
      <label className={`flex items-start gap-3 rounded-lg border p-4 ${state.enabled ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200'}`}>
        <input type="checkbox" role="switch" aria-checked={state.enabled} className="mt-1 h-4 w-4" checked={state.enabled}
          disabled={!state.can_edit || saving} onChange={event => void toggle(event.target.checked)} />
        <span className="min-w-0 flex-1">
          <strong className="flex items-center gap-2 text-sm">Aprobación automática {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${state.enabled ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'}`}>{state.enabled ? 'Activa' : 'Desactivada'}</span></strong>
          <span className="mt-1 block text-xs text-slate-600">Activa: una solicitud con OT o con OC, OS o RQ sin OT que se registra o corrige sin observaciones pasa directamente a «Aprobada» y queda lista para armar la ruta. Desactivada: espera la aprobación del Supervisor de Despacho.</span>
        </span>
      </label>
      <ul className="list-disc space-y-1 rounded-lg bg-blue-50 p-3 pl-7 text-xs leading-5 text-blue-900">
        <li>Incluye recojos y traslados con OC, OS o RQ sin OT: se autoriza automáticamente el monto registrado de flete y descarga, sin consumir la partida de otra OT.</li>
        <li>Las solicitudes observadas por partida, costos o referencia deben corregirse antes de aprobarse.</li>
        <li>No aprueba las solicitudes que ya estaban pendientes: aplica a las que se registren o editen después del cambio.</li>
        <li>El historial indica cuándo se aprobó de forma automática. Al armar la ruta se valida la partida de las solicitudes con OT y el monto autorizado de las referencias sin OT.</li>
      </ul>
      <p className="text-xs text-slate-500">
        {state.updated_at ? `Último cambio: ${new Date(state.updated_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}${state.updated_by_name ? ` · ${state.updated_by_name}` : ''}. ` : ''}
        {!state.can_edit && 'Solo el Administrador o quien aprueba solicitudes (Supervisor de Despacho) puede cambiarla.'}
      </p>
    </>}
  </div>
}
