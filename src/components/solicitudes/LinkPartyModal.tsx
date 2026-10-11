'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { createClient } from '@/lib/supabase/client'
import { requiresSupplier } from '@/lib/suppliers'

// Completa el proveedor (recojo / traslado) o el cliente (entrega sin OT) de una solicitud antigua.
// Con OT el cliente es el de la OT: se asigna en Contratos y OTs. Cambiar uno ya asignado solo lo hace el Administrador
// (set_request_party). Se monta solo mientras está abierto.
export type PartyRequest = { id: string; request_number?: string | null; request_type?: string; attention_mode?: string | null; contract_id?: string | null }
type Option = { id: string; business_name: string; tax_id: string | null }
type Props = { request: PartyRequest; onClose: () => void; onLinked: () => void }

export function LinkPartyModal({ request, onClose, onLinked }: Props) {
  const [supabase] = useState(() => createClient())
  const supplierMode = requiresSupplier(request)
  const fromOt = !supplierMode && Boolean(request.contract_id)
  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(!fromOt)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (fromOt) return
    let alive = true
    supabase.from(supplierMode ? 'suppliers' : 'clients').select('id, business_name, tax_id').eq('is_active', true).order('business_name')
      .then(({ data, error }) => {
        if (!alive) return
        if (error) toast.error('No se pudo cargar la lista: ' + error.message)
        setOptions((data || []) as Option[])
        setLoading(false)
      })
    return () => { alive = false }
  }, [supabase, supplierMode, fromOt])

  const save = async () => {
    if (!value) return
    setSaving(true)
    const { error } = await supabase.rpc('set_request_party', {
      p_request_id: request.id,
      p_client_id: supplierMode ? null : value,
      p_supplier_id: supplierMode ? value : null,
    })
    setSaving(false)
    if (error) { toast.error('No se pudo vincular: ' + error.message); return }
    toast.success(`${supplierMode ? 'Proveedor' : 'Cliente'} vinculado a ${request.request_number || 'la solicitud'}`)
    onLinked(); onClose()
  }

  const party = supplierMode ? 'proveedor' : 'cliente'
  return (
    <Modal isOpen onClose={onClose} title={`Vincular ${party} · ${request.request_number || ''}`} maxWidth="max-w-lg">
      {fromOt ? (
        <div className="space-y-3 text-sm text-slate-700">
          <p>Esta solicitud toma el cliente de su OT, y la OT no tiene cliente. Asígnelo en Contratos y OTs: se aplica a toda la familia y a sus solicitudes.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="min-h-10 rounded-lg border px-4 text-sm">Cerrar</button>
            <Link href="/contratos" className="inline-flex min-h-10 items-center rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white">Ir a Contratos y OTs</Link>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {supplierMode ? 'Los recojos y traslados se identifican por su proveedor.' : 'La entrega sin OT se identifica por su cliente.'} Sin {party} la solicitud no se puede programar en una ruta.
          </p>
          {loading ? <div className="grid place-items-center p-6"><Loader2 className="h-5 w-5 animate-spin text-[#002855]" /></div> : (
            <SearchableSelect value={value} onChange={setValue}
              options={options.map(o => ({ value: o.id, label: `${o.business_name}${o.tax_id ? ` (${o.tax_id})` : ''}` }))}
              placeholder="-- Buscar por RUC o razón social --" />
          )}
          <p className="text-xs text-slate-500">¿No aparece? Regístrelo primero en {supplierMode ? 'Proveedores' : 'Clientes'}.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="min-h-10 rounded-lg border px-4 text-sm">Cancelar</button>
            <button type="button" onClick={save} disabled={saving || !value}
              className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? 'Vinculando…' : `Vincular ${party}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
