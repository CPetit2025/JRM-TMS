'use client'

import { useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'

type ComponentKind = 'SUBCONTRATO' | 'ERROR'

export function InlineComponentCreator({ rootId, rootCode, disabled = false, create }: {
  rootId: string
  rootCode: string
  disabled?: boolean
  create: (kind: ComponentKind, suffix: string) => Promise<void>
}) {
  const [kind, setKind] = useState<ComponentKind | null>(null)
  const [suffix, setSuffix] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const valid = kind && (kind === 'SUBCONTRATO' ? /^S\d{1,10}$/ : /^E\d{1,10}$/).test(suffix.trim())
  const submit = async () => {
    if (!kind || !valid || saving || disabled) return
    setSaving(true)
    setError('')
    try {
      await create(kind, suffix.trim())
      setKind(null)
      setSuffix('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo registrar. Revisa el código e intenta nuevamente.')
    } finally {
      setSaving(false)
    }
  }

  return <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3" data-root-id={rootId}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-medium text-slate-600">¿Falta un componente de esta OT?</p>
      <div className="flex flex-wrap gap-2">
        {(['SUBCONTRATO', 'ERROR'] as const).map(value => <button key={value} type="button" disabled={saving || disabled}
          onClick={() => { setKind(value); setSuffix(''); setError('') }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-[#002855] hover:bg-blue-50 disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" />{value === 'SUBCONTRATO' ? 'Registrar subcontrato' : 'Registrar error'}
        </button>)}
      </div>
    </div>
    {kind && <div className="mt-3 border-t border-slate-200 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#002855]">Nuevo {kind === 'SUBCONTRATO' ? 'subcontrato' : 'error'} de OT {rootCode}</h3>
        <button type="button" disabled={saving} onClick={() => { setKind(null); setError('') }} aria-label="Cerrar registro de componente" className="rounded p-1 text-slate-500 hover:bg-slate-200 disabled:opacity-50"><X className="h-4 w-4" /></button>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">Se vincula a esta OT madre y hereda su cliente y destino. No requiere partida de transporte. El registro se guarda al pulsar «Registrar e incluir».</p>
      <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-end">
        <label className="block min-w-0 flex-1 text-xs font-medium text-slate-700">Código del componente
          <div className="mt-1 flex overflow-hidden rounded-lg border border-slate-300 bg-white focus-within:ring-2 focus-within:ring-[#002855]">
            <span className="border-r border-slate-200 bg-slate-100 px-3 py-2 text-slate-500">{rootCode}-</span>
            <input value={suffix} disabled={saving || disabled} maxLength={11} placeholder={kind === 'SUBCONTRATO' ? 'S001' : 'E001'}
              aria-describedby="component-code-hint" onChange={event => { setSuffix(event.target.value.toUpperCase().replace(/\s/g, '')); setError('') }}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submit() } }} className="min-w-0 flex-1 px-3 py-2 text-sm outline-none" />
          </div>
        </label>
        <button type="button" disabled={!valid || saving || disabled} onClick={() => void submit()}
          className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{saving ? 'Registrando…' : 'Registrar e incluir'}
        </button>
      </div>
      <p id="component-code-hint" className="mt-1.5 text-xs text-slate-500">Usa {kind === 'SUBCONTRATO' ? 'S' : 'E'} seguido del correlativo numérico. Código final: {rootCode}-{suffix || '…'}</p>
      {error && <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    </div>}
  </div>
}
