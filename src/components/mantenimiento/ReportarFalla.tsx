'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, TriangleAlert } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'

// Reporte de una falla o incidencia mecánica desde Operación (Jefe de Distribución, supervisores de transporte y
// despacho, Torre de Control). Usa reportar_falla (migración 20261005160000): avisa a Soporte Mecánico y Mantenimiento.

const supabase = createClient()
const field = 'w-full rounded-lg border px-3 py-2 text-sm'

export function ReportarFallaButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [plates, setPlates] = useState<string[]>([])
  const [form, setForm] = useState({ placa: '', descripcion: '', criticidad: 'MEDIA', odometro: '' })
  const [saving, setSaving] = useState(false)

  const abrir = () => {
    setOpen(true)
    if (!plates.length) supabase.from('vehicles').select('plate').order('plate').then(({ data }) => setPlates((data || []).map((v: { plate: string }) => v.plate)))
  }
  const enviar = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const { data, error } = await supabase.rpc('reportar_falla', {
      p_placa: form.placa, p_descripcion: form.descripcion, p_criticidad: form.criticidad, p_odometro: form.odometro ? Number(form.odometro) : null,
    })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(data.mensaje)
    setForm({ placa: '', descripcion: '', criticidad: 'MEDIA', odometro: '' })
    setOpen(false)
  }

  return (
    <>
      <button onClick={abrir} className={`flex items-center gap-2 rounded-lg border border-[#cf152d]/40 bg-white px-4 py-2 text-sm font-semibold text-[#cf152d] shadow-sm hover:bg-red-50 ${className}`}>
        <TriangleAlert className="h-4 w-4" />Reportar falla
      </button>
      {open && (
        <Modal isOpen onClose={() => setOpen(false)} title="Reportar falla o incidencia mecánica">
          <form onSubmit={enviar} className="space-y-3 text-sm">
            <label className="block">Unidad<select required className={field} value={form.placa} onChange={e => setForm({ ...form, placa: e.target.value })}>
              <option value="">Seleccionar…</option>{plates.map(p => <option key={p}>{p}</option>)}</select></label>
            <label className="block">¿Qué pasó?<textarea required minLength={5} rows={3} className={field} value={form.descripcion} onChange={e => setForm({ ...form, descripcion: e.target.value })}
              placeholder="Ej.: pierde aceite por el cárter, no enciende la luz de freno izquierda…" /></label>
            <div className="grid grid-cols-2 gap-3">
              <label>Criticidad<select className={field} value={form.criticidad} onChange={e => setForm({ ...form, criticidad: e.target.value })}>
                <option value="CRITICA">Crítica (no puede operar)</option><option value="ALTA">Alta</option><option value="MEDIA">Media</option><option value="BAJA">Baja</option>
              </select></label>
              <label>Odómetro (opcional)<input type="number" min={0} className={field} value={form.odometro} onChange={e => setForm({ ...form, odometro: e.target.value })} /></label>
            </div>
            {form.criticidad === 'CRITICA' && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-800">Una falla crítica bloquea la unidad hasta que Mantenimiento la libere.</p>}
            <p className="text-xs text-slate-500">Llega de inmediato a Soporte Mecánico y Mantenimiento, con su nombre y rol.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border px-4 py-2">Cancelar</button>
              <button disabled={saving} className="flex items-center gap-2 rounded-lg bg-[#cf152d] px-4 py-2 font-semibold text-white">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Reportar</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
