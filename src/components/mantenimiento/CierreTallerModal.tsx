'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Flag, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'

// Terminar una OT exige (migración 20261023100000, trigger mant_ot_reglas):
//  - tipo de mantenimiento coherente con lo descrito (una reparación o un cambio de componente no es preventivo);
//  - fecha y hora de ingreso y de salida de taller (parada real);
//  - lectura de odómetro u horómetro validada contra la anterior (retroceso o más de 1.200 km / 16 h por día piden motivo);
//  - moneda (PEN o USD, con tipo de cambio) e indicación de si el monto incluye IGV.

const TIPOS = [['CORRECTIVA', 'Correctivo'], ['PREVENTIVA', 'Preventivo'], ['MEJORA', 'Mejora'], ['EMERGENCIA', 'Emergencia'], ['INSPECCION', 'Inspección']] as const
const toLocal = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

interface Props { orderId: string; otCode: string; activities: string | null; onClose: () => void; onDone: () => void }
interface Check { unidad: 'KM' | 'HORAS'; lectura: { ok: boolean; obs: string; mensaje?: string; anterior?: number }; tipo: string | null }

export function CierreTallerModal({ orderId, otCode, activities, onClose, onDone }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [f, setF] = useState({ order_type: '', ingreso: '', salida: '', meter: '', motivo: '', currency: 'PEN', igv: '', exchange_rate: '', requisition: '', actividades: activities ?? '' })
  const [check, setCheck] = useState<Check | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void supabase.from('maintenance_work_orders')
      .select('order_type, downtime_start, downtime_end, meter_reading, meter_override_reason, currency, includes_igv, exchange_rate, requisition')
      .eq('id', orderId).single().then(({ data }) => {
        if (data) setF(x => ({ ...x, order_type: data.order_type ?? '', ingreso: toLocal(data.downtime_start), salida: toLocal(data.downtime_end) || toLocal(new Date().toISOString()),
          meter: data.meter_reading?.toString() ?? '', motivo: data.meter_override_reason ?? '', currency: data.currency ?? 'PEN',
          igv: data.includes_igv === null || data.includes_igv === undefined ? '' : data.includes_igv ? 'SI' : 'NO',
          exchange_rate: data.exchange_rate?.toString() ?? '', requisition: data.requisition ?? '' }))
        setLoading(false)
      })
  }, [orderId, supabase])

  // Validación previa de la lectura y del tipo (sin guardar)
  useEffect(() => {
    if (!f.meter || !f.salida) { const t = window.setTimeout(() => setCheck(null), 0); return () => window.clearTimeout(t) }
    const t = window.setTimeout(() => {
      void supabase.rpc('mant_ot_prevalidar', { p_order: orderId, p_meter: Number(f.meter), p_end: new Date(f.salida).toISOString() })
        .then(({ data }) => setCheck((data ?? null) as Check | null))
    }, 400)
    return () => window.clearTimeout(t)
  }, [f.meter, f.salida, orderId, supabase])

  const lecturaMala = check && !check.lectura.ok
  const faltan = [
    !f.order_type && 'tipo de mantenimiento', !f.ingreso && 'ingreso a taller', !f.salida && 'salida de taller', !f.meter && 'lectura',
    lecturaMala && f.motivo.trim().length < 5 && 'motivo de la lectura', !f.igv && 'IGV', f.currency === 'USD' && !f.exchange_rate && 'tipo de cambio',
    !f.actividades.trim() && 'actividades realizadas',
  ].filter(Boolean) as string[]

  const submit = async () => {
    if (faltan.length) { toast.error(`Falta: ${faltan.join(', ')}`); return }
    if (new Date(f.salida) < new Date(f.ingreso)) { toast.error('La salida de taller es anterior al ingreso'); return }
    setBusy(true)
    const { error } = await supabase.from('maintenance_work_orders').update({
      order_type: f.order_type, downtime_start: new Date(f.ingreso).toISOString(), downtime_end: new Date(f.salida).toISOString(),
      meter_reading: Number(f.meter), meter_override_reason: lecturaMala ? f.motivo.trim() : null, currency: f.currency, includes_igv: f.igv === 'SI',
      exchange_rate: f.currency === 'USD' ? Number(f.exchange_rate) : null, requisition: f.requisition.trim() || null,
    }).eq('id', orderId)
    if (error) { setBusy(false); toast.error(error.message); return }
    const { data, error: e2 } = await supabase.rpc('transition_work_order', { p_work_order_id: orderId, p_new_status: 'TERMINADA', p_notes: f.actividades.trim() })
    setBusy(false)
    if (e2 || data?.success === false) { toast.error(e2?.message || data?.error || 'No se pudo terminar la OT'); return }
    toast.success(`OT ${otCode} terminada`)
    onDone()
  }

  const fld = 'h-10 w-full rounded-lg border border-slate-300 px-2 text-sm'
  const unidad = check?.unidad === 'HORAS' ? 'h (horómetro)' : 'km (odómetro)'
  return (
    <Modal isOpen onClose={onClose} title={`Terminar ${otCode}: cierre de taller`} maxWidth="max-w-2xl"
      footer={<div className="flex flex-wrap items-center justify-end gap-2">
        {faltan.length > 0 && <span className="mr-auto text-xs text-amber-700">Falta: {faltan.join(', ')}</span>}
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm">Cancelar</button>
        <button type="button" disabled={busy || loading} onClick={() => void submit()} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}Terminar OT</button>
      </div>}>
      {loading ? <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando…</p> : <div className="grid gap-3 text-sm sm:grid-cols-2">
        <label className="sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Tipo de mantenimiento *</span>
          <select value={f.order_type} onChange={e => setF({ ...f, order_type: e.target.value })} className={fld}>
            <option value="">Seleccione…</option>{TIPOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {check?.tipo && f.order_type === 'PREVENTIVA' && <span className="mt-1 flex items-center gap-1 text-xs text-red-700"><AlertTriangle className="h-3.5 w-3.5" />{check.tipo}</span>}
        </label>
        <label><span className="mb-1 block text-xs font-semibold text-slate-600">Ingreso a taller (fecha y hora) *</span>
          <input type="datetime-local" value={f.ingreso} onChange={e => setF({ ...f, ingreso: e.target.value })} className={fld} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-slate-600">Salida de taller (fecha y hora) *</span>
          <input type="datetime-local" value={f.salida} onChange={e => setF({ ...f, salida: e.target.value })} className={fld} /></label>
        <label className="sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Lectura al salir de taller, en {unidad} *</span>
          <input inputMode="decimal" value={f.meter} onChange={e => setF({ ...f, meter: e.target.value.replace(',', '.') })} className={fld} />
          {check && <span className={`mt-1 flex items-center gap-1 text-xs ${check.lectura.ok ? 'text-emerald-700' : 'text-amber-800'}`}>
            {check.lectura.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {check.lectura.ok ? (check.lectura.anterior !== undefined ? `Coherente con la lectura anterior (${check.lectura.anterior})` : (check.lectura.mensaje ?? 'Lectura válida')) : check.lectura.mensaje}</span>}
        </label>
        {lecturaMala && <label className="sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-amber-800">Motivo para confirmar esta lectura * (p. ej. cambio de medidor)</span>
          <input value={f.motivo} onChange={e => setF({ ...f, motivo: e.target.value })} className={fld} /></label>}
        <label><span className="mb-1 block text-xs font-semibold text-slate-600">Moneda *</span>
          <select value={f.currency} onChange={e => setF({ ...f, currency: e.target.value })} className={fld}><option value="PEN">Soles (PEN)</option><option value="USD">Dólares (USD)</option></select></label>
        <label><span className="mb-1 block text-xs font-semibold text-slate-600">¿El monto incluye IGV? *</span>
          <select value={f.igv} onChange={e => setF({ ...f, igv: e.target.value })} className={fld}><option value="">Seleccione…</option><option value="SI">Sí, incluye IGV</option><option value="NO">No, es sin IGV</option></select></label>
        {f.currency === 'USD' && <label><span className="mb-1 block text-xs font-semibold text-slate-600">Tipo de cambio *</span>
          <input inputMode="decimal" value={f.exchange_rate} onChange={e => setF({ ...f, exchange_rate: e.target.value.replace(',', '.') })} className={fld} /></label>}
        <label><span className="mb-1 block text-xs font-semibold text-slate-600">RQ (requerimiento)</span>
          <input value={f.requisition} onChange={e => setF({ ...f, requisition: e.target.value })} className={fld} /></label>
        <label className="sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Actividades realizadas *</span>
          <textarea rows={3} value={f.actividades} onChange={e => setF({ ...f, actividades: e.target.value })} className="w-full rounded-lg border border-slate-300 p-2 text-sm" /></label>
      </div>}
    </Modal>
  )
}
