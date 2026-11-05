'use client'

import { useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'

export interface TransportBudgetTarget {
  id: string
  code: string
  allocated_pen: number | string | null
}

export function TransportBudgetEditor({ target, onClose, onSaved }: {
  target: TransportBudgetTarget
  onClose: () => void
  onSaved: (amount: number) => void
}) {
  const [amount, setAmount] = useState(() => Number(target.allocated_pen ?? 0).toFixed(2))
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const close = () => { if (!pending.current) onClose() }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (pending.current) return
    setError('')
    const raw = amount.trim()
    const value = Number(raw)
    if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(raw) || !Number.isFinite(value) || value < 0 || value > 999999999999.99) {
      setError('Indique un monto válido, cero o mayor, con hasta dos decimales.')
      return
    }

    pending.current = true
    setSaving(true)
    try {
      const { data, error: rpcError } = await createClient().rpc('set_contract_transport_budget', {
        p_contract_id: target.id,
        p_amount: value,
        p_reason: reason.trim() || `Edición de partida desde el expediente: ${target.code}`,
      })
      if (rpcError) throw new Error(rpcError.message)
      if (data?.success !== true) throw new Error(data?.error || 'No se pudo guardar la partida de transporte.')
      toast.success(`Partida de ${target.code} actualizada`)
      onSaved(value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar la partida de transporte.')
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={close} title={`Editar partida · ${target.code}`} maxWidth="max-w-lg">
      <form onSubmit={save} className="space-y-4">
        <p className="text-sm text-slate-600">El nuevo monto reemplaza la partida de este registro y actualiza el presupuesto consolidado de la OT madre.</p>
        <div>
          <label htmlFor="transport-budget-amount" className="mb-1 block text-sm font-semibold text-slate-700">Partida de transporte (S/)</label>
          <input id="transport-budget-amount" type="number" inputMode="decimal" min="0" max="999999999999.99" step="0.01" required autoFocus
            value={amount} disabled={saving} onChange={event => setAmount(event.target.value)}
            aria-invalid={!!error} aria-describedby={error ? 'transport-budget-error' : undefined}
            className="h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]/15 disabled:bg-slate-50" />
        </div>
        <div>
          <label htmlFor="transport-budget-reason" className="mb-1 block text-sm font-medium text-slate-700">Motivo del ajuste (opcional)</label>
          <textarea id="transport-budget-reason" rows={2} maxLength={400} value={reason} disabled={saving}
            onChange={event => setReason(event.target.value)} placeholder="Ej.: corrección de la partida asignada"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]/15 disabled:bg-slate-50" />
        </div>
        {error && <p id="transport-budget-error" role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button type="button" disabled={saving} onClick={close} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancelar</button>
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white hover:bg-[#003a7a] disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {saving ? 'Guardando…' : 'Guardar monto'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
