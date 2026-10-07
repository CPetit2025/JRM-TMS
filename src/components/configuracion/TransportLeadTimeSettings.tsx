'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { DEFAULT_LEAD_TIME_SETTINGS, type DeliveryZone, type TransportLeadTimeSettings as LeadTimeSettings } from '@/lib/transport-lead-time'

const zones: { key: DeliveryZone; label: string }[] = [
  { key: 'LIMA', label: 'Lima y Callao' }, { key: 'PROVINCIA', label: 'Provincia' }, { key: 'EXTERIOR', label: 'Exterior' },
]

export function TransportLeadTimeSettings() {
  const supabase = useMemo(() => createClient(), [])
  const [settings, setSettings] = useState<LeadTimeSettings>(DEFAULT_LEAD_TIME_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void supabase.rpc('get_transport_lead_time_settings').then(({ data, error: loadError }) => {
      if (cancelled) return
      if (loadError || !data) setError(loadError?.message || 'No se pudo consultar la configuración central.')
      else { setSettings(data as LeadTimeSettings); setLoaded(true) }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [supabase])

  const save = async () => {
    if (!loaded) return
    if (zones.some(({ key }) => !Number.isInteger(settings.zones[key].hours) || settings.zones[key].hours < 1 || settings.zones[key].hours > 720)) {
      toast.error('Ingresa horas completas entre 1 y 720 para cada zona.'); return
    }
    setSaving(true); setError('')
    try {
      const { data, error: saveError } = await supabase.rpc('set_transport_lead_time_settings', { p_settings: settings })
      if (saveError) throw saveError
      if (data?.success === false) throw new Error(data.error || 'No se guardó la configuración.')
      const refreshed = await supabase.rpc('get_transport_lead_time_settings')
      if (refreshed.error) throw refreshed.error
      setSettings(refreshed.data as LeadTimeSettings)
      toast.success('Anticipación actualizada para las nuevas solicitudes.')
    } catch (cause: unknown) {
      const message = (cause as { message?: string })?.message || 'No se pudo guardar la configuración.'
      setError(message); toast.error(message)
    } finally { setSaving(false) }
  }

  if (loading) return <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Consultando plazos…</p>

  return <div className="space-y-5">
    <div><h2 className="font-semibold text-[#002855]">Planificación y plazos</h2><p className="mt-1 text-sm text-slate-600">Anticipación mínima entre el registro de una solicitud y la entrega solicitada. Se cuentan horas continuas, incluidos fines de semana, en horario de Lima.</p></div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <fieldset disabled={!loaded || saving} className="space-y-4 disabled:opacity-60">
      <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-4"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings(previous => ({ ...previous, enabled: event.target.checked }))} /><span><strong className="block text-sm">Control obligatorio de anticipación</strong><span className="text-xs text-slate-500">Al activarlo, se impiden entregas anteriores al plazo configurado.</span></span></label>
      <div className="grid gap-3 sm:grid-cols-3">{zones.map(({ key, label }) => <div key={key} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={settings.zones[key].enabled} onChange={event => setSettings(previous => ({ ...previous, zones: { ...previous.zones, [key]: { ...previous.zones[key], enabled: event.target.checked } } }))} />{label}</label>
        <label className="block text-xs text-slate-500">Horas mínimas<input type="number" min={1} max={720} step={1} value={settings.zones[key].hours} onChange={event => setSettings(previous => ({ ...previous, zones: { ...previous.zones, [key]: { ...previous.zones[key], hours: Number(event.target.value) } } }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900" /></label>
      </div>)}</div>
      <p className="rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-900">Ejemplo: una solicitud para Lima registrada a las 17:45 permite entregar desde las 17:45 del día siguiente cuando el plazo es de 24 horas. Editar o reprogramar no reinicia el reloj. Las solicitudes existentes conservan su regla histórica. El control aplica a entregas de transporte JRM; recojos, traslados y recojo por cliente mantienen su circuito.</p>
      <button type="button" onClick={() => void save()} disabled={saving || !loaded} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar plazos</button>
    </fieldset>
  </div>
}
