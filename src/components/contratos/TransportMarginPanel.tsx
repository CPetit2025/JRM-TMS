'use client'
import { useEffect, useState } from 'react'
import { History, Loader2, Percent, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type MarginEntry = {
  id: string; scope: 'OT' | 'CLIENTE'; operating_pct: number; reason: string; valid_until: string | null
  active: boolean; vigente: boolean; created_at: string; created_by_name: string | null
  revoked_at: string | null; revoked_by_name: string | null; revoke_reason: string | null
}
type MarginInfo = {
  root_id: string; client_id: string | null; client_name: string | null; operating_pct: number
  source: 'DEFAULT' | 'OT' | 'CLIENTE'
  current: { id: string; scope: 'OT' | 'CLIENTE'; operating_pct: number; reason: string; valid_until: string | null } | null
  can_manage: boolean; history: MarginEntry[]
}

const field = 'w-full rounded-lg border border-slate-300 bg-white p-2 text-sm outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]'
const fmtDate = (d: string | null) => d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('es-PE') : ''

/** Margen operativo de la partida de transporte (80 % por defecto). El Administrador del sistema o el Jefe de
 *  Distribución pueden ampliarlo para la OT (familia completa) o para su cliente, con motivo y vencimiento opcional. */
export function TransportMarginPanel({ contractId, onChanged }: { contractId: string; onChanged?: () => void }) {
  const supabase = createClient()
  const [info, setInfo] = useState<MarginInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [scope, setScope] = useState<'OT' | 'CLIENTE'>('OT')
  const [pct, setPct] = useState('85')
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [saving, setSaving] = useState(false)

  const [version, setVersion] = useState(0)
  useEffect(() => {
    let cancel = false
    supabase.rpc('get_transport_margin', { p_contract: contractId }).then(({ data }) => {
      if (!cancel && data?.success) setInfo(data as MarginInfo)
    })
    return () => { cancel = true }
  }, [supabase, contractId, version])
  const load = () => setVersion(v => v + 1)

  if (!info) return null

  const save = async () => {
    setSaving(true)
    const { data, error } = await supabase.rpc('set_transport_margin', {
      p_contract: contractId, p_scope: scope, p_pct: Number(pct), p_reason: reason.trim(), p_valid_until: until || null,
    })
    setSaving(false)
    if (error || !data?.success) { toast.error(data?.error || error?.message || 'No se pudo ampliar el margen'); return }
    toast.success(`Margen operativo ampliado al ${Number(pct)} %`)
    setOpen(false); setReason(''); setUntil('')
    load(); onChanged?.()
  }

  const revoke = async () => {
    if (!info.current) return
    const motivo = window.prompt('Motivo para revocar la ampliación (mínimo 10 caracteres):')
    if (!motivo) return
    const { data, error } = await supabase.rpc('revoke_transport_margin', { p_id: info.current.id, p_reason: motivo.trim() })
    if (error || !data?.success) { toast.error(data?.error || error?.message || 'No se pudo revocar'); return }
    toast.success('Ampliación revocada')
    load(); onChanged?.()
  }

  const sourceLabel = info.source === 'OT' ? 'ampliado para esta OT' : info.source === 'CLIENTE' ? `ampliado para el cliente ${info.client_name || ''}` : 'margen estándar'
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800"><Percent className="h-4 w-4" aria-hidden="true" />
            Margen operativo: {Number(info.operating_pct)} % <span className="font-normal text-slate-500">({sourceLabel})</span></p>
          <p className="mt-0.5 text-xs text-slate-500">Utilidad protegida: {Math.round((100 - Number(info.operating_pct)) * 100) / 100} %.
            {info.current && <> Motivo: «{info.current.reason}»{info.current.valid_until ? ` · vence el ${fmtDate(info.current.valid_until)}` : ' · sin vencimiento'}.</>}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {info.history.length > 0 && <button type="button" onClick={() => setShowHistory(v => !v)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            <History className="h-3.5 w-3.5" aria-hidden="true" />Historial ({info.history.length})</button>}
          {info.can_manage && info.current && <button type="button" onClick={revoke} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">Revocar ampliación</button>}
          {info.can_manage && <button type="button" onClick={() => { setOpen(true); setScope(info.current?.scope || 'OT'); setPct(String(info.current ? info.current.operating_pct : 85)) }}
            className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#003a7a]"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />Ampliar margen</button>}
        </div>
      </div>

      {open && (
        <div className="mt-3 grid gap-3 rounded-lg border border-blue-200 bg-blue-50/50 p-3 md:grid-cols-2">
          <div className="md:col-span-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-[#002855]">Ampliar margen operativo de la partida</p>
            <button type="button" aria-label="Cerrar" onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-800"><X className="h-4 w-4" /></button>
          </div>
          <label className="text-xs font-medium text-slate-700">Aplicar a
            <select className={field} value={scope} onChange={e => setScope(e.target.value as 'OT' | 'CLIENTE')}>
              <option value="OT">Esta OT (madre, subcontratos y errores)</option>
              {info.client_id && <option value="CLIENTE">Todas las OT del cliente {info.client_name || ''}</option>}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-700">Margen operativo (%)
            <input type="number" min={80.01} max={100} step={0.5} className={field} value={pct} onChange={e => setPct(e.target.value)} />
            <span className="mt-0.5 block font-normal text-slate-500">Estándar 80 %. Ej.: 85 % = 5 % más de gasto operativo.</span>
          </label>
          <label className="text-xs font-medium text-slate-700 md:col-span-2">Motivo (obligatorio)
            <textarea rows={2} maxLength={500} className={field} value={reason} onChange={e => setReason(e.target.value)} placeholder="Ej.: acceso a mina con escolta; el cliente reconoce el mayor gasto operativo" />
          </label>
          <label className="text-xs font-medium text-slate-700">Vence el (opcional)
            <input type="date" className={field} value={until} onChange={e => setUntil(e.target.value)} />
          </label>
          <div className="flex items-end justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-white">Cancelar</button>
            <button type="button" disabled={saving || reason.trim().length < 10 || !(Number(pct) > 80 && Number(pct) <= 100)} onClick={save}
              className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}Guardar ampliación</button>
          </div>
        </div>
      )}

      {showHistory && (
        <ul className="mt-3 divide-y divide-slate-100 text-xs">
          {info.history.map(h => (
            <li key={h.id} className="py-2">
              <span className={`mr-2 rounded px-1.5 py-0.5 font-semibold ${h.vigente ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{h.vigente ? 'Vigente' : 'Inactiva'}</span>
              <strong>{Number(h.operating_pct)} %</strong> · {h.scope === 'OT' ? 'OT' : 'Cliente'} · {h.reason}
              <span className="block text-slate-500">Registró {h.created_by_name || '—'} el {fmtDate(h.created_at)}{h.valid_until ? ` · vence ${fmtDate(h.valid_until)}` : ''}
                {h.revoked_at ? ` · ${h.revoke_reason || 'Revocada'} (${h.revoked_by_name || 'sistema'}, ${fmtDate(h.revoked_at)})` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
