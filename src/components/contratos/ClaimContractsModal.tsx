'use client'
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'

// Administrador de Contratos: elige las OT raíz (sin responsable) de las que será Responsable de OT.
// La base solo ofrece OT de sus sedes sin responsable y no reasigna una OT que otro ya tomó.
// Se monta solo mientras está abierta, así cada apertura empieza con la selección y la búsqueda limpias.
type Available = { id: string; code: string; type: string; status: string; client_name: string | null; created_at: string }
type Props = { open: boolean; onClose: () => void; onClaimed: () => void; firstTime?: boolean }

export function ClaimContractsModal({ open, onClose, onClaimed, firstTime }: Props) {
  const [supabase] = useState(() => createClient())
  const [items, setItems] = useState<Available[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    supabase.rpc('contract_admin_available_ots').then(({ data, error }) => {
      if (!alive) return
      if (error) toast.error('No se pudieron cargar las OT disponibles: ' + error.message)
      setItems((data as Available[]) || [])
      setLoading(false)
    })
    return () => { alive = false }
  }, [supabase])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter(i => `${i.code} ${i.client_name || ''}`.toLowerCase().includes(q)) : items
  }, [items, query])

  const toggle = (id: string) => setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const save = async () => {
    if (selected.size === 0) return
    setSaving(true)
    const { data, error } = await supabase.rpc('claim_contract_responsibility', { p_contract_ids: [...selected] })
    setSaving(false)
    if (error) { toast.error('No se pudo asignar: ' + error.message); return }
    const taken = Number(data?.asignadas || 0), skipped = Number(data?.omitidas || 0)
    toast.success(`${taken} OT asignada(s) a tu cartera${skipped ? ` · ${skipped} ya tenían responsable` : ''}`)
    onClaimed(); onClose()
  }

  return (
    <Modal isOpen={open} onClose={onClose} title="Selecciona tus contratos (Responsable de OT)" maxWidth="max-w-2xl">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {firstTime ? 'Aún no tienes contratos asignados. ' : ''}Marca las OT de las que eres responsable. Solo aparecen las OT madre e independientes de tus sedes que todavía no tienen responsable; los subcontratos y errores se incluyen con su OT madre.
        </p>
        <label className="flex items-center gap-2 rounded-lg border border-slate-300 px-3">
          <Search className="h-4 w-4 text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar por OT o cliente" className="min-h-10 w-full bg-transparent text-sm outline-none" />
        </label>
        <div className="max-h-[50vh] overflow-auto rounded-lg border border-slate-200">
          {loading ? <div className="grid place-items-center p-8"><Loader2 className="h-5 w-5 animate-spin text-[#002855]" /></div>
            : shown.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">No hay OT disponibles sin responsable{query ? ' con ese filtro' : ''}.</p>
            : <ul className="divide-y">
              {shown.map(i => (
                <li key={i.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
                    <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} className="h-4 w-4" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-slate-900">{i.code}</span>
                      <span className="block truncate text-xs text-slate-500">{i.type === 'OT_INDEPENDIENTE' ? 'OT independiente' : 'Contrato madre'}{i.client_name ? ` · ${i.client_name}` : ''} · {i.status}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-slate-600">{selected.size} seleccionada(s)</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="min-h-10 rounded-lg border px-4 text-sm">{firstTime ? 'Más tarde' : 'Cancelar'}</button>
            <button type="button" onClick={save} disabled={saving || selected.size === 0}
              className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? 'Asignando…' : 'Asumir como Responsable de OT'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
