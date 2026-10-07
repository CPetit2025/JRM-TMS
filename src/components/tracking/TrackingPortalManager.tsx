'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, KeyRound, Link2, Loader2, Plus, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { DataTable } from '@/components/ui/data-table'

type Site = { id: string; name: string }
type Contract = { id: string; code: string; site_id: string }
type PortalLink = { token: string; site_id: string; contract_ids: string[]; created_at: string; revoked_at: string | null; rotated_at: string | null }
type Credential = { token: string; pin: string }

export function TrackingPortalManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const db = useMemo(() => createClient(), [])
  const [sites, setSites] = useState<Site[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [links, setLinks] = useState<PortalLink[]>([])
  const [site, setSite] = useState('')
  const [scope, setScope] = useState<'site' | 'contracts'>('contracts')
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [credential, setCredential] = useState<Credential | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [options, listed] = await Promise.all([
        db.rpc('get_tracking_portal_scope_options'), db.rpc('list_tracking_portal_links'),
      ])
      if (options.error) throw options.error
      if (listed.error) throw listed.error
      const available = options.data?.sites || []
      setSites(available); setContracts(options.data?.contracts || []); setLinks(listed.data || [])
      setSite(previous => available.some((item: Site) => item.id === previous) ? previous : available[0]?.id || '')
      setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String((err as { message?: string })?.message || err)) }
    finally { setLoading(false) }
  }, [db])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => { window.clearTimeout(timer); setCredential(null) }
  }, [open, refresh])

  const url = (token: string) => `${window.location.origin}/tracking/${token}`
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copiado. Comparte el acceso con el destinatario autorizado.') }
    catch { toast.error('No se pudo copiar. Selecciona el enlace y el código para copiarlos manualmente.') }
  }
  const message = (value: Credential) => `JRM · Planificación y seguimiento de transporte\nEnlace: ${url(value.token)}\nCódigo de acceso: ${value.pin}\nConsulta el calendario y el avance de los servicios autorizados. Este acceso permanece disponible hasta su revocación.`

  const generate = async () => {
    if (!site || (scope === 'contracts' && !selected.length)) return
    setBusy(true)
    try {
      const result = await db.rpc('generate_tracking_portal_link', { p_scope: { site_id: site, contract_ids: scope === 'contracts' ? selected : [] } })
      if (result.error) throw result.error
      if (!result.data?.token || !result.data?.pin) throw new Error('No se recibieron las credenciales del portal.')
      setCredential(result.data); await refresh(); toast.success('Portal permanente creado.')
    } catch (err) { toast.error((err as { message?: string })?.message || 'No se pudo crear el acceso.') }
    finally { setBusy(false) }
  }
  const manage = async (token: string, action: 'REVOKE' | 'ROTATE_PIN') => {
    setBusy(true)
    try {
      const result = await db.rpc('manage_tracking_portal_link', { p_token: token, p_action: action })
      if (result.error) throw result.error
      if (action === 'ROTATE_PIN') {
        if (!result.data?.pin) throw new Error('No se recibió el nuevo código.')
        setCredential({ token, pin: result.data.pin })
      } else if (credential?.token === token) setCredential(null)
      await refresh(); toast.success(action === 'REVOKE' ? 'Acceso revocado.' : 'Código cambiado. El código anterior ya no permite ingresar.')
    } catch (err) { toast.error((err as { message?: string })?.message || 'No se pudo actualizar el acceso.') }
    finally { setBusy(false) }
  }

  return <Modal isOpen={open} onClose={onClose} title="Portal permanente · accesos de seguimiento" maxWidth="max-w-5xl">
    <div className="space-y-5">
      <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm leading-6 text-[#002855]"><ShieldCheck aria-hidden className="mr-2 inline h-4 w-4" />El enlace permite consultar calendario, solicitudes y avances en lectura. Define las OT o la sede que podrá consultar el destinatario. Las guías se cargan desde el acceso del transportista.</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}<button onClick={() => void refresh()} className="ml-3 min-h-11 underline">Reintentar</button></p>}
      <section className="space-y-4 rounded-xl border border-slate-200 p-4">
        <h3 className="font-bold text-[#002855]">Crear un acceso</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">Sede de operación<select value={site} onChange={event => { setSite(event.target.value); setSelected([]) }} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"><option value="">Selecciona una sede</option>{sites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="text-sm font-medium text-slate-700">Visibilidad<select value={scope} onChange={event => setScope(event.target.value as typeof scope)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"><option value="contracts">Solo las OT seleccionadas</option><option value="site">Todas las operaciones de esta sede</option></select></label>
        </div>
        {scope === 'contracts' && <fieldset className="space-y-2"><legend className="text-sm font-semibold text-slate-700">OT autorizadas · {selected.length} seleccionada(s)</legend>
          <input aria-label="Buscar OT para autorizar" placeholder="Buscar número de OT" value={search} onChange={event => setSearch(event.target.value)} className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm" />
          <div className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-3">{contracts.filter(item => item.site_id === site && item.code.toLowerCase().includes(search.toLowerCase())).map(item => <label key={item.id} className="flex min-h-11 items-center gap-2 rounded px-2 text-sm hover:bg-slate-50"><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />OT {item.code}</label>)}</div>
          <p className="text-xs text-slate-500">Este alcance muestra únicamente los servicios de esas OT. El GPS de rutas compartidas queda fuera de esta vista.</p>
        </fieldset>}
        {scope === 'site' && <p className="text-xs leading-5 text-amber-800">El destinatario podrá consultar todas las solicitudes y rutas de esta sede, incluidas las que se registren después de crear el enlace.</p>}
        <button disabled={busy || loading || !site || (scope === 'contracts' && (!selected.length || selected.length > 100))} onClick={() => void generate()} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Plus aria-hidden className="h-4 w-4" />}Crear enlace permanente</button>
      </section>
      {credential && <section className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <h3 className="font-semibold text-emerald-900">Acceso listo para compartir</h3>
        <label className="block text-xs font-semibold text-slate-600">Enlace<input readOnly value={url(credential.token)} onFocus={event => event.target.select()} className="mt-1 min-h-11 w-full rounded-lg border border-emerald-200 bg-white px-3 text-sm" /></label>
        <p className="text-sm text-slate-700">Código: <strong className="font-mono text-lg tracking-widest text-[#002855]">{credential.pin}</strong></p>
        <button onClick={() => void copy(message(credential))} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Copy aria-hidden className="h-4 w-4" />Copiar enlace y código</button>
        <p className="text-xs text-slate-600">El código se muestra al crear o cambiar el acceso. Si lo pierdes, genera uno nuevo para el mismo enlace.</p>
      </section>}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2"><h3 className="font-bold text-[#002855]">Accesos existentes</h3><button disabled={loading || busy} onClick={() => void refresh()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm"><RefreshCw aria-hidden className="h-4 w-4" />Actualizar</button></div>
        {loading ? <p role="status" className="p-4 text-sm text-slate-500">Consultando accesos…</p> : !links.length ? <p className="rounded-lg border p-4 text-sm text-slate-500">Todavía no hay portales permanentes.</p> : <div className="overflow-x-auto rounded-xl border border-slate-200"><DataTable><thead><tr><th>Alcance</th><th>Creación · Lima</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{links.map(link => <tr key={link.token}>
          <td><p className="font-semibold text-[#002855]">{sites.find(item => item.id === link.site_id)?.name || 'Sede autorizada'}</p><p className="mt-1 text-xs text-slate-500">{link.contract_ids.length ? link.contract_ids.map(id => contracts.find(item => item.id === id)?.code || 'OT autorizada').join(' · ') : 'Todas las operaciones de la sede'}</p></td>
          <td className="whitespace-nowrap text-sm">{new Date(link.created_at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' })}</td>
          <td><span className={`rounded-full px-2 py-1 text-xs font-semibold ${link.revoked_at ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}>{link.revoked_at ? 'Revocado' : 'Activo'}</span></td>
          <td><div className="flex flex-wrap gap-2">{!link.revoked_at && <>
            <button disabled={busy} onClick={() => void copy(url(link.token))} className="inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 text-xs font-semibold"><Link2 aria-hidden className="h-4 w-4" />Copiar enlace</button>
            <button disabled={busy} onClick={() => void manage(link.token, 'ROTATE_PIN')} className="inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 text-xs font-semibold"><KeyRound aria-hidden className="h-4 w-4" />Cambiar código</button>
            <button disabled={busy} onClick={() => void manage(link.token, 'REVOKE')} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-red-200 px-3 text-xs font-semibold text-red-700"><XCircle aria-hidden className="h-4 w-4" />Revocar</button>
          </>}</div></td>
        </tr>)}</tbody></DataTable></div>}
      </section>
    </div>
  </Modal>
}
