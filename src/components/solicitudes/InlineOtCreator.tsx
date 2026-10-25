'use client'

import { allPages } from '@/lib/analytics/model'
import { useEffect, useMemo, useState } from 'react'
import { Briefcase, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { InlineClientCreator } from '@/components/contratos/InlineClientCreator'
import { clientDocLabel } from '@/lib/countries'

export type CreatedOt = {
  id: string; code: string; client_name: string | null
  destination_address: string; destination_department: string; destination_province: string; destination_district: string
}
type ClientOption = { id: string; business_name: string; tax_id: string | null; country_code?: string | null; country_name?: string | null }

const field = 'mt-1 w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]'

/** Alta de una OT madre dentro de la Nueva solicitud, sin salir del modal. Usa el mismo alta del servidor que Contratos
 *  (create_contract: permisos, sede, código único y partida) y permite registrar el cliente ahí mismo (RUC/SUNAT o
 *  extranjero). La partida solo se pide si el usuario puede asignarla; si no, la OT queda sin partida y Contratos la
 *  completa (la solicitud quedará observada hasta entonces). */
export function InlineOtCreator({ canSetBudget, initialDestination, onCreated, onCancel }: {
  canSetBudget: boolean
  initialDestination?: Partial<Pick<CreatedOt, 'destination_address' | 'destination_department' | 'destination_province' | 'destination_district'>>
  onCreated: (ot: CreatedOt) => Promise<void> | void
  onCancel: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [clients, setClients] = useState<ClientOption[]>([])
  const [addingClient, setAddingClient] = useState(false)
  const [code, setCode] = useState('')
  const [clientId, setClientId] = useState('')
  const [budget, setBudget] = useState('')
  const [dest, setDest] = useState({
    destination_address: initialDestination?.destination_address || '', destination_department: initialDestination?.destination_department || '',
    destination_province: initialDestination?.destination_province || '', destination_district: initialDestination?.destination_district || '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Por páginas: la API entrega como máximo 1.000 filas por consulta
    void allPages<ClientOption>((o, n) => supabase.from('clients').select('id, business_name, tax_id, country_code, country_name').eq('is_active', true)
      .order('business_name').order('id').range(o, o + n - 1), 1000)
      .then(data => { if (!cancelled) setClients(data) }, () => { if (!cancelled) setClients([]) })
    return () => { cancelled = true }
  }, [supabase])

  const save = async () => {
    const finalCode = code.trim()
    if (!finalCode) { toast.error('Indique el código de la OT'); return }
    if (!clientId) { toast.error('Seleccione el cliente de la OT o regístrelo con «Nuevo cliente»'); return }
    if (!dest.destination_address.trim() || !dest.destination_department.trim() || !dest.destination_province.trim() || !dest.destination_district.trim()) {
      toast.error('Complete la dirección y el departamento, provincia y distrito del destino'); return
    }
    const budgetPen = canSetBudget && budget.trim() ? Number(budget) : 0
    if (!Number.isFinite(budgetPen) || budgetPen < 0) { toast.error('La partida no puede ser negativa'); return }
    setSaving(true)
    try {
      const payload = { code: finalCode, type: 'CONTRATO', parent_contract_id: null, client_id: clientId, status: 'ACTIVO', ...dest,
        destination_address: dest.destination_address.trim() }
      const { data, error } = await supabase.rpc('create_contract', { p_payload: payload, p_budget_pen: budgetPen })
      if (error) throw new Error(error.message)
      const result = data as { success?: boolean; id?: string; error?: string } | null
      if (!result?.success || !result.id) throw new Error(result?.error || 'No se pudo registrar la OT')
      await onCreated({ id: result.id, code: finalCode, client_name: clients.find(c => c.id === clientId)?.business_name || null, ...dest, destination_address: payload.destination_address })
      toast.success(budgetPen > 0 ? `OT ${finalCode} registrada con su partida y seleccionada` : `OT ${finalCode} registrada y seleccionada. Contratos debe asignar su partida de transporte.`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo registrar la OT') }
    finally { setSaving(false) }
  }

  return <div className="mt-3 space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-3">
    <div className="flex items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-sm font-semibold text-[#002855]"><Briefcase className="h-4 w-4" />Nueva OT madre</p>
      <button type="button" onClick={onCancel} disabled={saving} aria-label="Cancelar nueva OT" className="rounded-full p-1 text-slate-500 hover:bg-white"><X className="h-4 w-4" /></button>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="block text-sm font-medium text-slate-700">Código de la OT <span className="text-red-500">*</span>
        <input value={code} onChange={e => setCode(e.target.value)} maxLength={100} placeholder="16584" className={field} disabled={saving} /></label>
      <div className="text-sm font-medium text-slate-700">
        <div className="flex items-center justify-between gap-2"><span>Cliente <span className="text-red-500">*</span></span>
          {!addingClient && <button type="button" onClick={() => setAddingClient(true)} className="flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Plus className="h-3.5 w-3.5" />Nuevo cliente</button>}</div>
        {!addingClient && <div className="mt-1"><SearchableSelect value={clientId} onChange={setClientId}
          options={clients.map(c => ({ value: c.id, label: `${c.business_name} (${clientDocLabel(c)})` }))} placeholder="-- Buscar por RUC o razón social --" /></div>}
      </div>
    </div>
    {addingClient && <InlineClientCreator onCancel={() => setAddingClient(false)} onCreated={client => {
      setClients(list => list.some(c => c.id === client.id) ? list : [...list, { ...client, tax_id: client.tax_id }].sort((a, b) => a.business_name.localeCompare(b.business_name)))
      setClientId(client.id); setAddingClient(false)
    }} />}
    <label className="block text-sm font-medium text-slate-700">Dirección de destino / proyecto <span className="text-red-500">*</span>
      <input value={dest.destination_address} onChange={e => setDest({ ...dest, destination_address: e.target.value })} placeholder="Ej. Av. Industrial 123" className={field} disabled={saving} /></label>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {([['destination_department', 'Departamento', 'LIMA'], ['destination_province', 'Provincia', 'LIMA'], ['destination_district', 'Distrito', 'ATE']] as const).map(([key, label, example]) =>
        <label key={key} className="block text-sm font-medium text-slate-700">{label} <span className="text-red-500">*</span>
          <input value={dest[key]} onChange={e => setDest({ ...dest, [key]: e.target.value.toUpperCase() })} placeholder={`Ej. ${example}`} className={`${field} uppercase`} disabled={saving} /></label>)}
    </div>
    {canSetBudget
      ? <label className="block text-sm font-medium text-slate-700">Partida de transporte (S/)
          <input type="number" step="0.01" min="0" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0.00" className={field} disabled={saving} />
          <span className="mt-1 block text-xs font-normal text-slate-500">{Number(budget) > 0 ? `Operación (80%): S/ ${(Number(budget) * 0.8).toFixed(2)}` : 'Sin partida, la solicitud quedará observada hasta que Contratos la asigne.'}</span></label>
      : <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">La OT se registra sin partida de transporte: Contratos debe asignarla para aprobar la solicitud.</p>}
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onCancel} disabled={saving} className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700">Cancelar</button>
      <button type="button" onClick={() => void save()} disabled={saving || addingClient} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Registrar OT y usarla</button>
    </div>
  </div>
}
