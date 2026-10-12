'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import { DataTable } from '@/components/ui/data-table'

type Reference = { id: string; request_id: string; doc_type: string; document_number: string }
type Service = { request_id: string; request_number: string; ot_code: string | null; order_reference?: string | null }
/** Números que ya tiene el servicio por otra vía (guía de entrega, despacho o archivo): se muestran, no se editan aquí. */
export type KnownNumber = { request_id: string; doc_type: 'GUIA_REMISION' | 'NOTA_DESPACHO'; document_number: string; source: string }

/** These references identify documents; delivery evidence and its review remain separate. */
export function DocumentNumberLinks({ dispatchId, services, canEdit, known = [], onChanged }: {
  dispatchId: string; services: Service[]; canEdit: boolean; known?: KnownNumber[]; onChanged: () => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const [references, setReferences] = useState<Reference[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [type, setType] = useState('GUIA_REMISION')
  const [numbers, setNumbers] = useState([''])
  const [saving, setSaving] = useState(false)
  const fetchReferences = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_dispatch_document_references', { p_dispatch: dispatchId })
    if (error) { setLoadError(errorMessage(error)); return }
    setReferences((data || []) as Reference[]); setLoadError('')
  }, [dispatchId, supabase])
  useEffect(() => {
    let stopped = false
    const timer = window.setTimeout(() => { void fetchReferences().finally(() => { if (!stopped) setLoading(false) }) }, 0)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [fetchReferences])
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving || !editing) return
    const normalized = numbers.map(number => number.trim().toUpperCase())
    const pattern = type === 'GUIA_REMISION' ? /^[A-Z0-9]{3,4}-[0-9]{1,10}$/ : /^[A-Z0-9]{1,8}-[0-9]{1,10}$/
    if (normalized.some(number => !pattern.test(number))) { toast.error('Use serie y correlativo, por ejemplo T001-6591. Conserve los ceros.'); return }
    if (new Set(normalized).size !== normalized.length) { toast.error('Hay números repetidos en el formulario.'); return }
    setSaving(true)
    try {
      const { data, error } = await supabase.rpc('link_dispatch_document_numbers', {
        p_dispatch: dispatchId, p_request: editing, p_type: type, p_numbers: normalized,
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'No se pudieron vincular los números')
      toast.success(`${normalized.length} número(s) vinculado(s)`)
      setEditing(null); setNumbers([''])
      await fetchReferences(); await onChanged()
    } catch (error) { toast.error(errorMessage(error)) }
    finally { setSaving(false) }
  }
  const service = services.find(row => row.request_id === editing)
  // Mismo número que ya vinculó Documentos: se muestra una sola vez
  const otherNumbers = (requestId: string, docType: string, linked: Reference[]) => {
    const seen = new Set(linked.map(reference => reference.document_number.toUpperCase()))
    return known.filter(item => item.request_id === requestId && item.doc_type === docType && !seen.has(item.document_number.toUpperCase()) && seen.add(item.document_number.toUpperCase()))
  }
  return <section className="overflow-hidden rounded-xl border border-slate-200" aria-label="Números documentarios por servicio">
    <div className="px-4 py-3"><h3 className="text-sm font-bold text-jrm-navy">Números de guía y nota</h3><p className="mt-0.5 text-xs text-slate-500">Serie y número por servicio; en gris, los que ya llegaron por la guía de entrega, el despacho o un archivo.</p></div>
    {loadError && <p role="alert" className="p-4 text-sm text-red-700">No se pudieron consultar los números: {loadError}. <button type="button" onClick={() => void fetchReferences()} className="font-semibold underline">Reintentar</button></p>}
    {loading ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Consultando números…</p> : <div className="overflow-x-auto"><DataTable className="w-full text-left text-sm"><thead><tr><th scope="col" className="px-4 py-2">OT / Orden / Servicio</th><th scope="col" className="px-4 py-2">Guías de Remisión</th><th scope="col" className="px-4 py-2">Notas de Despacho</th>{canEdit && <th scope="col" className="px-4 py-2"><span className="sr-only">Acciones</span></th>}</tr></thead><tbody>{services.map(row => <tr key={row.request_id} className="border-t border-slate-200"><td className="px-4 py-2"><p className="font-semibold text-jrm-navy">{row.ot_code ? `OT ${row.ot_code}` : row.order_reference || 'Sin referencia'}</p><p className="text-xs text-slate-500">{row.request_number}</p></td>{['GUIA_REMISION', 'NOTA_DESPACHO'].map(docType => { const linked = references.filter(reference => reference.request_id === row.request_id && reference.doc_type === docType); const others = otherNumbers(row.request_id, docType, linked); return <td key={docType} className="px-4 py-2"><div className="flex flex-wrap gap-1.5">{linked.map(reference => <span key={reference.id} title="Vinculado por Documentos" className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-mono text-xs font-semibold text-jrm-navy">{reference.document_number}</span>)}{others.map(other => <span key={`${other.source}/${other.document_number}`} title={`Registrado por ${other.source}`} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"><span className="font-mono font-semibold">{other.document_number}</span><span className="text-[10px] text-slate-500">· {other.source}</span></span>)}{!linked.length && !others.length && <span className="text-xs text-slate-400">Sin números vinculados</span>}</div></td> })}{canEdit && <td className="px-4 py-2 text-right"><button disabled={saving || !!loadError} type="button" onClick={() => { setEditing(row.request_id); setNumbers(['']); setType('GUIA_REMISION') }} className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-jrm-navy hover:bg-slate-50 disabled:opacity-50 lg:min-h-9"><Link2 className="h-4 w-4" />Vincular números</button></td>}</tr>)}</tbody></DataTable></div>}
    {canEdit && editing && <form onSubmit={save} className="space-y-3 border-t border-blue-200 bg-blue-50/40 p-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold text-jrm-navy">Vincular a {service?.request_number}{service?.ot_code ? ` · OT ${service.ot_code}` : ''}</h4><button type="button" disabled={saving} onClick={() => setEditing(null)} className="min-h-11 rounded-lg border border-slate-300 px-3 text-xs font-semibold">Cerrar formulario</button></div><label className="block text-xs font-medium text-slate-600">Tipo de documento<select disabled={saving} value={type} onChange={event => setType(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm sm:max-w-xs"><option value="GUIA_REMISION">Guía de Remisión</option><option value="NOTA_DESPACHO">Nota de Despacho</option></select></label><p className="text-xs text-slate-500">Serie y correlativo separados por guion. Ejemplo: T001-6591. Conserve los ceros originales.</p><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{numbers.map((number, index) => <div key={index} className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs font-medium text-slate-600">Número {index + 1}<input required disabled={saving} maxLength={19} value={number} onChange={event => setNumbers(values => values.map((value, position) => position === index ? event.target.value.toUpperCase() : value))} placeholder="T001-6591" autoCapitalize="characters" spellCheck={false} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm" /></label>{numbers.length > 1 && <button type="button" disabled={saving} aria-label={`Quitar número ${index + 1}`} onClick={() => setNumbers(values => values.filter((_, position) => position !== index))} className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-slate-300 text-slate-600"><X className="h-4 w-4" /></button>}</div>)}</div><div className="flex flex-wrap gap-2"><button type="button" disabled={saving || numbers.length >= 50} onClick={() => setNumbers(values => [...values, ''])} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-jrm-navy disabled:opacity-50"><Plus className="h-4 w-4" />Agregar otro número</button><button disabled={saving} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}{saving ? 'Vinculando…' : 'Guardar números'}</button></div><p className="text-xs text-slate-500">Vincular números no confirma la entrega ni sustituye la guía firmada.</p></form>}
  </section>
}
