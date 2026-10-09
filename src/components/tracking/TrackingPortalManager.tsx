'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Building2, CalendarDays, Check, Copy, ExternalLink, KeyRound, Link2, Loader2, MapPinned, MessageCircle, Plus, RefreshCw, Route, Search, ShieldCheck, Users, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { DataTable } from '@/components/ui/data-table'
import { otKind } from '@/lib/tracking-portal'

// Accesos de seguimiento para clientes: quién recibe el enlace, qué puede consultar (un cliente completo, OT
// específicas o toda la sede) y qué verá (calendario, ruta del día con guías y Packing List, GPS). Solo lectura.

type Site = { id: string; name: string }
type Client = { id: string; name: string }
type Contract = { id: string; code: string; site_id: string; client_id?: string | null; type?: string | null; parent_id?: string | null }
type PortalLink = { token: string; site_id: string; contract_ids: string[]; client_ids?: string[]; label?: string | null; created_at: string; revoked_at: string | null; rotated_at: string | null }
type Credential = { token: string; pin: string; label?: string | null }
type Scope = 'client' | 'contracts' | 'site'

const KIND_CHIP: Record<string, string> = { SUBCONTRATO: 'border-violet-200 bg-violet-50 text-violet-800', ERROR: 'border-rose-200 bg-rose-50 text-rose-800' }
const KIND_LABEL: Record<string, string> = { SUBCONTRATO: 'Subcontrato', ERROR: 'Error' }
const SCOPES: { key: Scope; title: string; text: string; icon: typeof Users }[] = [
  { key: 'client', title: 'Un cliente', text: 'Todas sus OT, subcontratos y errores, también los que se registren después.', icon: Users },
  { key: 'contracts', title: 'OT específicas', text: 'Solo las OT elegidas, con sus subcontratos y errores.', icon: Link2 },
  { key: 'site', title: 'Toda la sede', text: 'Todas las operaciones de la sede. Para uso interno o supervisión.', icon: Building2 },
]
const VIEWS = [
  { icon: CalendarDays, title: 'Calendario', text: 'OT, subcontratos, errores y órdenes OS / OC / RQ por fecha, y el registro de solicitudes con su hora de creación.' },
  { icon: Route, title: 'Ruta del día', text: 'Unidad, conductor y paradas, con guía de remisión, Packing List y guía firmada.' },
  { icon: MapPinned, title: 'Monitoreo GPS', text: 'Posición de las rutas cuyas paradas están todas dentro del acceso.' },
]
const fmt = (value: string) => new Date(value).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' })

export function TrackingPortalManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const db = useMemo(() => createClient(), [])
  const [sites, setSites] = useState<Site[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [links, setLinks] = useState<PortalLink[]>([])
  const [tab, setTab] = useState<'new' | 'list'>('new')
  const [label, setLabel] = useState('')
  const [site, setSite] = useState('')
  const [scope, setScope] = useState<Scope>('client')
  const [selectedClients, setSelectedClients] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [credential, setCredential] = useState<Credential | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const clientName = useCallback((id?: string | null) => clients.find(c => c.id === id)?.name || 'Sin cliente', [clients])
  const siteContracts = useMemo(() => contracts.filter(c => c.site_id === site), [contracts, site])
  // OT madre (o sin madre en la sede) con sus subcontratos y errores, agrupadas por cliente.
  const groups = useMemo(() => {
    const ids = new Set(siteContracts.map(c => c.id))
    const children = new Map<string, Contract[]>()
    siteContracts.forEach(c => { if (c.parent_id && ids.has(c.parent_id)) children.set(c.parent_id, [...(children.get(c.parent_id) || []), c]) })
    const family = (c: Contract): Contract[] => (children.get(c.id) || []).flatMap(k => [k, ...family(k)])
    const roots = siteContracts.filter(c => !c.parent_id || !ids.has(c.parent_id)).map(c => ({ item: c, family: family(c) }))
    const byClient = new Map<string, typeof roots>()
    roots.forEach(r => { const key = r.item.client_id || ''; byClient.set(key, [...(byClient.get(key) || []), r]) })
    return [...byClient.entries()].map(([id, list]) => ({ id, name: clientName(id), list }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [siteContracts, clientName])
  const clientCounts = useMemo(() => {
    const m = new Map<string, number>()
    siteContracts.forEach(c => { if (c.client_id) m.set(c.client_id, (m.get(c.client_id) || 0) + 1) })
    return m
  }, [siteContracts])
  const siteClients = clients.filter(c => clientCounts.has(c.id))
  const term = search.trim().toLowerCase()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [options, listed] = await Promise.all([db.rpc('get_tracking_portal_scope_options'), db.rpc('list_tracking_portal_links')])
      if (options.error) throw options.error
      if (listed.error) throw listed.error
      const available: Site[] = options.data?.sites || []
      setSites(available); setClients(options.data?.clients || []); setContracts(options.data?.contracts || []); setLinks(listed.data || [])
      setSite(previous => available.some(item => item.id === previous) ? previous : available[0]?.id || '')
      setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String((err as { message?: string })?.message || err)) }
    finally { setLoading(false) }
  }, [db])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => { window.clearTimeout(timer); setCredential(null); setTab('new') }
  }, [open, refresh])

  const url = (token: string) => `${window.location.origin}/tracking/${token}`
  const message = (value: Credential) => `JRM · Seguimiento de transporte${value.label ? ` para ${value.label}` : ''}\nEnlace: ${url(value.token)}\nCódigo de acceso: ${value.pin}\nIncluye el calendario de servicios, la ruta del día con guías y Packing List, y el monitoreo GPS. El acceso permanece activo hasta que JRM lo revoque.`
  const copy = async (text: string, done = 'Copiado') => {
    try { await navigator.clipboard.writeText(text); toast.success(done) }
    catch { toast.error('No se pudo copiar. Selecciona el texto y cópialo manualmente.') }
  }
  const resetForm = () => { setCredential(null); setLabel(''); setSelectedClients([]); setSelected([]); setSearch('') }

  const scopeCount = scope === 'client' ? selectedClients.length : scope === 'contracts' ? selected.length : 1
  const ready = !!site && label.trim().length >= 3 && scopeCount > 0 && selected.length <= 100 && selectedClients.length <= 20
  const generate = async () => {
    if (!ready) return
    setBusy(true)
    try {
      const result = await db.rpc('generate_tracking_portal_link', { p_scope: {
        site_id: site, label: label.trim(),
        client_ids: scope === 'client' ? selectedClients : [], contract_ids: scope === 'contracts' ? selected : [],
      } })
      if (result.error) throw result.error
      if (!result.data?.token || !result.data?.pin) throw new Error('No se recibieron las credenciales del acceso.')
      setCredential({ token: result.data.token, pin: result.data.pin, label: label.trim() }); await refresh(); toast.success('Acceso creado.')
    } catch (err) { toast.error((err as { message?: string })?.message || 'No se pudo crear el acceso.') }
    finally { setBusy(false) }
  }
  const manage = async (link: PortalLink, action: 'REVOKE' | 'ROTATE_PIN') => {
    if (action === 'REVOKE' && !window.confirm(`¿Revocar el acceso${link.label ? ` de ${link.label}` : ''}? El enlace dejará de funcionar.`)) return
    setBusy(true)
    try {
      const result = await db.rpc('manage_tracking_portal_link', { p_token: link.token, p_action: action })
      if (result.error) throw result.error
      if (action === 'ROTATE_PIN') {
        if (!result.data?.pin) throw new Error('No se recibió el nuevo código.')
        setCredential({ token: link.token, pin: result.data.pin, label: link.label }); setTab('new')
      } else if (credential?.token === link.token) setCredential(null)
      await refresh(); toast.success(action === 'REVOKE' ? 'Acceso revocado.' : 'Código cambiado. El anterior ya no permite ingresar.')
    } catch (err) { toast.error((err as { message?: string })?.message || 'No se pudo actualizar el acceso.') }
    finally { setBusy(false) }
  }
  const scopeText = (link: PortalLink) => {
    if (link.client_ids?.length) return `Cliente: ${link.client_ids.map(clientName).join(', ')}`
    if (link.contract_ids.length) return `OT: ${link.contract_ids.map(id => contracts.find(c => c.id === id)?.code || 'OT autorizada').join(', ')}`
    return `Toda la sede ${sites.find(s => s.id === link.site_id)?.name || ''}`.trim()
  }
  const active = links.filter(l => !l.revoked_at).length

  return <Modal isOpen={open} onClose={onClose} title="Compartir seguimiento con clientes" maxWidth="max-w-5xl">
    <div className="space-y-4">
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
        {([['new', 'Nuevo acceso'], ['list', `Accesos creados${links.length ? ` · ${active} activos` : ''}`]] as const).map(([key, text]) =>
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`min-h-10 flex-1 rounded-lg px-3 text-sm font-semibold transition ${tab === key ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{text}</button>)}
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}<button onClick={() => void refresh()} className="ml-3 min-h-11 underline">Reintentar</button></p>}

      {tab === 'new' && credential && <section className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-600 text-white"><Check className="h-5 w-5" /></span>
          <div><h3 className="font-bold text-emerald-900">Acceso listo{credential.label ? ` para ${credential.label}` : ''}</h3><p className="text-sm text-emerald-800">Envía el enlace y el código al destinatario. El código no se vuelve a mostrar; si se pierde, cámbialo desde «Accesos creados».</p></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
          <label className="block text-xs font-semibold text-slate-600">Enlace<input readOnly value={url(credential.token)} onFocus={e => e.target.select()} className="mt-1 min-h-11 w-full rounded-lg border border-emerald-200 bg-white px-3 text-sm" /></label>
          <div className="text-xs font-semibold text-slate-600">Código de acceso<p className="mt-1 flex min-h-11 items-center justify-center rounded-lg border border-emerald-200 bg-white font-mono text-xl font-bold tracking-[0.3em] text-[#002855]">{credential.pin}</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void copy(message(credential), 'Enlace, código e instrucciones copiados')} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Copy className="h-4 w-4" />Copiar mensaje</button>
          <a href={`https://wa.me/?text=${encodeURIComponent(message(credential))}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white"><MessageCircle className="h-4 w-4" />Compartir por WhatsApp</a>
          <a href={url(credential.token)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-[#002855]"><ExternalLink className="h-4 w-4" />Ver como el cliente</a>
          <button onClick={resetForm} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700"><Plus className="h-4 w-4" />Crear otro acceso</button>
        </div>
      </section>}

      {tab === 'new' && !credential && <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-5">
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 font-bold text-[#002855]"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#002855] text-xs text-white">1</span>¿Para quién es el acceso?</h3>
            <div className={`grid gap-3 ${sites.length > 1 ? 'sm:grid-cols-[minmax(0,1fr)_14rem]' : ''}`}>
              <label className="text-sm font-medium text-slate-700">Destinatario<input value={label} maxLength={120} onChange={e => setLabel(e.target.value)} placeholder="Ej.: Siderperú · Jefatura de logística" className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label>
              {sites.length > 1 && <label className="text-sm font-medium text-slate-700">Sede<select value={site} onChange={e => { setSite(e.target.value); setSelected([]); setSelectedClients([]) }} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3">{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
            </div>
            <p className="text-xs text-slate-500">Identifica el acceso en la lista para cambiar su código o revocarlo.</p>
          </section>

          <section className="space-y-3">
            <h3 className="flex items-center gap-2 font-bold text-[#002855]"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#002855] text-xs text-white">2</span>¿Qué podrá consultar?</h3>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
              {SCOPES.map(s => <button key={s.key} type="button" role="radio" aria-checked={scope === s.key} onClick={() => { setScope(s.key); setSearch('') }}
                className={`rounded-xl border p-3 text-left transition ${scope === s.key ? 'border-[#002855] bg-blue-50 ring-1 ring-[#002855]' : 'border-slate-200 hover:border-slate-300'}`}>
                <span className="flex items-center gap-2 text-sm font-bold text-[#002855]"><s.icon className="h-4 w-4" />{s.title}</span>
                <span className="mt-1 block text-xs leading-5 text-slate-600">{s.text}</span>
              </button>)}
            </div>

            {scope !== 'site' && <label className="relative block"><span className="sr-only">Buscar</span><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={scope === 'client' ? 'Buscar cliente' : 'Buscar OT o cliente'} className="min-h-11 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-sm" /></label>}

            {scope === 'client' && <div className="max-h-72 divide-y overflow-y-auto rounded-xl border border-slate-200">
              {loading ? <p className="p-4 text-sm text-slate-500">Cargando clientes…</p>
                : siteClients.filter(c => c.name.toLowerCase().includes(term)).map(c => {
                  const on = selectedClients.includes(c.id)
                  return <label key={c.id} className={`flex min-h-12 cursor-pointer items-center gap-3 px-3 text-sm ${on ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                    <input type="checkbox" checked={on} onChange={e => setSelectedClients(p => e.target.checked ? [...p, c.id] : p.filter(id => id !== c.id))} />
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{c.name}</span>
                    <span className="shrink-0 text-xs text-slate-500">{clientCounts.get(c.id)} OT</span>
                  </label>
                })}
              {!loading && !siteClients.length && <p className="p-4 text-sm text-slate-500">No hay clientes con OT en esta sede.</p>}
            </div>}

            {scope === 'contracts' && <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-200">
              {groups.map(g => {
                const list = g.list.filter(r => !term || g.name.toLowerCase().includes(term) || [r.item, ...r.family].some(c => c.code.toLowerCase().includes(term)))
                if (!list.length) return null
                return <div key={g.id || 'none'}>
                  <p className="sticky top-0 z-10 border-b bg-slate-50 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">{g.name}</p>
                  {list.map(({ item, family }) => {
                    const on = selected.includes(item.id), kind = otKind(item.code, item.type)
                    return <label key={item.id} className={`flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-sm last:border-b-0 ${on ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                      <input type="checkbox" checked={on} onChange={e => setSelected(p => e.target.checked ? [...p, item.id] : p.filter(id => id !== item.id))} />
                      <span className="font-semibold text-slate-800">OT {item.code}</span>
                      {KIND_LABEL[kind] && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${KIND_CHIP[kind]}`}>{KIND_LABEL[kind]}</span>}
                      {family.length > 0 && <span className="text-xs text-slate-500">incluye {family.map(f => <span key={f.id} className={`ml-1 rounded border px-1 py-0.5 text-[10px] font-semibold ${KIND_CHIP[otKind(f.code, f.type)] || 'border-slate-200'}`}>{f.code.replace(`${item.code}-`, '')}</span>)}</span>}
                    </label>
                  })}
                </div>
              })}
            </div>}

            {scope === 'site' && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">El destinatario verá todas las solicitudes y rutas de la sede, de todos los clientes, incluidas las que se registren después.</p>}
          </section>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500"><ShieldCheck className="h-4 w-4" />El destinatario verá · solo lectura</p>
            <ul className="space-y-3">{VIEWS.map(v => <li key={v.title} className="flex gap-2.5"><v.icon className="mt-0.5 h-4 w-4 shrink-0 text-[#002855]" /><span className="text-xs leading-5 text-slate-600"><b className="block text-sm text-slate-900">{v.title}</b>{v.text}</span></li>)}</ul>
          </div>
          <div className="rounded-xl border border-slate-200 p-4 text-sm">
            <p className="text-xs text-slate-500">Resumen</p>
            <p className="mt-1 font-semibold text-slate-900">{label.trim() || 'Sin destinatario'}</p>
            <p className="mt-1 text-slate-600">{scope === 'site' ? `Toda la sede ${sites.find(s => s.id === site)?.name || ''}`
              : scope === 'client' ? (selectedClients.length ? selectedClients.map(clientName).join(', ') : 'Elige uno o más clientes')
              : (selected.length ? `${selected.length} OT con sus subcontratos y errores` : 'Elige una o más OT')}</p>
            <button disabled={busy || loading || !ready} onClick={() => void generate()} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}Crear acceso
            </button>
            {!ready && <p className="mt-2 text-xs text-slate-500">{label.trim().length < 3 ? 'Indica el destinatario.' : 'Elige qué podrá consultar.'}</p>}
          </div>
        </aside>
      </div>}

      {tab === 'list' && <section className="space-y-3">
        <div className="flex items-center justify-between gap-2"><p className="text-sm text-slate-600">Cada acceso funciona hasta que se revoque. Cambiar el código invalida el anterior.</p><button disabled={loading || busy} onClick={() => void refresh()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button></div>
        {loading ? <p role="status" className="p-4 text-sm text-slate-500">Consultando accesos…</p>
          : !links.length ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">Todavía no hay accesos. Crea el primero en «Nuevo acceso».</p>
          : <div className="overflow-x-auto rounded-xl border border-slate-200"><DataTable className="w-full"><thead><tr><th>Destinatario</th><th>Alcance</th><th>Creado</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{links.map(link => <tr key={link.token}>
            <td className="font-semibold text-[#002855]">{link.label || <span className="font-normal italic text-slate-400">Sin nombre</span>}</td>
            <td className="max-w-72 text-xs text-slate-600"><span className="line-clamp-2" title={scopeText(link)}>{scopeText(link)}</span></td>
            <td className="whitespace-nowrap text-sm">{fmt(link.created_at)}</td>
            <td><span className={`rounded-full px-2 py-1 text-xs font-semibold ${link.revoked_at ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}>{link.revoked_at ? 'Revocado' : 'Activo'}</span></td>
            <td><div className="flex flex-wrap gap-1.5">{!link.revoked_at && <>
              <button disabled={busy} onClick={() => void copy(url(link.token), 'Enlace copiado (el código no se guarda: cámbialo si se perdió)')} className="inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold"><Link2 className="h-3.5 w-3.5" />Copiar enlace</button>
              <button disabled={busy} onClick={() => void manage(link, 'ROTATE_PIN')} className="inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold"><KeyRound className="h-3.5 w-3.5" />Nuevo código</button>
              <button disabled={busy} onClick={() => void manage(link, 'REVOKE')} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-red-200 px-2.5 text-xs font-semibold text-red-700"><XCircle className="h-3.5 w-3.5" />Revocar</button>
            </>}</div></td>
          </tr>)}</tbody></DataTable></div>}
      </section>}
    </div>
  </Modal>
}
