'use client'
import { useState } from 'react'
import { CheckCircle2, Loader2, Search, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export type CreatedClient = { id: string; business_name: string; tax_id: string }

const field = 'w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]'

/** Registro del cliente dentro del Alta de OT: RUC → SUNAT → razón social y dirección, sin salir del modal.
 *  Si el RUC ya existe, el servidor devuelve ese cliente (no se duplica). */
export function InlineClientCreator({ onCreated, onCancel }: { onCreated: (client: CreatedClient) => void; onCancel: () => void }) {
  const supabase = createClient()
  const [ruc, setRuc] = useState('')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [contact, setContact] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [sunat, setSunat] = useState<{ ruc: string; status: string } | null>(null)
  const [sunatDown, setSunatDown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const verified = sunat?.ruc === ruc

  const lookup = async () => {
    if (ruc.length !== 11) { toast.error('El RUC debe tener 11 dígitos'); return }
    setSearching(true)
    try {
      const res = await fetch(`/api/sunat?ruc=${ruc}`)
      if (!res.ok) {
        if (res.status >= 500) setSunatDown(true)
        throw new Error(res.status >= 500 ? 'SUNAT no responde: puede completar los datos y guardar' : 'RUC no encontrado en SUNAT')
      }
      const data = await res.json()
      if (!data.nombre) throw new Error('No se encontraron datos para este RUC')
      setName(data.nombre)
      setAddress([data.direccion, [data.distrito, data.provincia, data.departamento].filter(Boolean).join(', ')].filter(Boolean).join(' - '))
      const status = [data.estado, data.condicion].filter(Boolean).join(' / ')
      setSunat({ ruc, status }); setSunatDown(false)
      if ((data.estado && data.estado !== 'ACTIVO') || (data.condicion && data.condicion !== 'HABIDO')) toast.warning(`RUC verificado, pero en SUNAT figura: ${status}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Error al consultar SUNAT') }
    finally { setSearching(false) }
  }

  const save = async () => {
    if (!verified && !sunatDown) { toast.error('Consulte el RUC en SUNAT antes de registrar el cliente'); return }
    if (!name.trim()) { toast.error('Ingrese la razón social'); return }
    setSaving(true)
    try {
      const { data, error } = await supabase.rpc('register_contract_client', {
        p_tax_id: ruc, p_business_name: name.trim(), p_address: address.trim() || null, p_contact_name: contact.trim() || null,
        p_phone: phone.trim() || null, p_email: email.trim() || null, p_sunat_status: verified ? sunat?.status || 'VERIFICADO' : null,
      })
      if (error) throw error
      const result = data as { success?: boolean; error?: string; existing?: boolean; id?: string; business_name?: string; tax_id?: string } | null
      if (!result?.success || !result.id) throw new Error(result?.error || 'No se pudo registrar el cliente')
      toast.success(result.existing ? `El RUC ya estaba registrado: se seleccionó ${result.business_name}` : 'Cliente registrado y seleccionado')
      onCreated({ id: result.id, business_name: result.business_name || name.trim(), tax_id: result.tax_id || ruc })
    } catch (error) { toast.error(error instanceof Error ? error.message : 'No se pudo registrar el cliente') }
    finally { setSaving(false) }
  }

  return <div className="space-y-3 rounded-lg border-2 border-blue-200 bg-blue-50/40 p-3">
    <div className="flex items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-sm font-semibold text-[#002855]"><UserPlus className="h-4 w-4" />Nuevo cliente</p>
      <button type="button" onClick={onCancel} aria-label="Cerrar registro de cliente" className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-white"><X className="h-4 w-4" /></button>
    </div>
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700">RUC <span className="text-red-500">*</span></label>
      <div className="flex gap-2">
        <input inputMode="numeric" value={ruc} onChange={e => setRuc(e.target.value.replace(/\D/g, '').slice(0, 11))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void lookup() } }} placeholder="20XXXXXXXXX" className={`${field} font-mono`} />
        <button type="button" onClick={() => void lookup()} disabled={searching || ruc.length !== 11} className="flex shrink-0 items-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50">{searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}SUNAT</button>
      </div>
      {verified ? <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-3 w-3" />Verificado en SUNAT{sunat?.status ? ` · ${sunat.status}` : ''}</p>
        : <p className="mt-1 text-xs text-slate-500">{sunatDown ? 'SUNAT no responde: complete la razón social manualmente.' : 'Consulte SUNAT para completar la razón social y la dirección.'}</p>}
    </div>
    {(verified || sunatDown) && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700 sm:col-span-2">Razón social <span className="text-red-500">*</span><input value={name} onChange={e => setName(e.target.value)} className={`${field} mt-1`} /></label>
        <label className="block text-xs font-medium text-slate-700 sm:col-span-2">Dirección fiscal<input value={address} onChange={e => setAddress(e.target.value)} className={`${field} mt-1`} /></label>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer font-semibold text-blue-700">Contacto (opcional)</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <label className="block font-medium text-slate-700">Nombre<input value={contact} onChange={e => setContact(e.target.value)} className={`${field} mt-1`} /></label>
          <label className="block font-medium text-slate-700">Teléfono<input value={phone} onChange={e => setPhone(e.target.value)} className={`${field} mt-1`} /></label>
          <label className="block font-medium text-slate-700">Correo<input type="email" value={email} onChange={e => setEmail(e.target.value)} className={`${field} mt-1`} /></label>
        </div>
      </details>
      <div className="flex justify-end"><button type="button" onClick={() => void save()} disabled={saving || !name.trim()} className="flex min-h-10 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Registrar y usar en esta OT</button></div>
    </>}
  </div>
}
