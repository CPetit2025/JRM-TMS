'use client'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Modal } from '@/components/ui/modal'
import { WMS_PERMISSIONS } from '@/lib/wms-administration'
import { isSystemAdminRole } from '@/lib/roles'

type Role = { id: string; name: string; description: string | null; permissions: string[] }
type Account = { id: string; first_name: string; last_name: string; username: string; email: string; document_number: string; phone: string; role_id: string; is_active: boolean; roles: Role | null }
type TmsPerson = { id: string; first_name: string; last_name: string; username: string | null; email: string | null; document_number: string | null; phone: string | null; is_active: boolean }
const EMPTY = { first_name: '', last_name: '', username: '', document_number: '', phone: '', role_id: '', password: '', is_active: false }
const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 p-2 text-slate-900'
const buttonClass = 'rounded-lg bg-[#002855] px-4 py-2 text-white disabled:opacity-50'

export function WmsAdministration({ mode }: { mode: 'users' | 'roles' }) {
  const [users, setUsers] = useState<Account[]>([])
  const [tmsUsers, setTmsUsers] = useState<TmsPerson[]>([])
  const [selectedTmsId, setSelectedTmsId] = useState('')
  const [tmsSearch, setTmsSearch] = useState('')
  const [firstAccessEmail, setFirstAccessEmail] = useState('')
  const [firstAccessUrl, setFirstAccessUrl] = useState<string | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [account, setAccount] = useState(EMPTY)
  const [role, setRole] = useState({ name: '', description: '', permissions: ['almacen-lectura'] })
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/admin/wms', { cache: 'no-store', signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setUsers(data.users); setRoles(data.roles); setTmsUsers(data.tmsUsers || [])
      if (data.truncated) setNotice('Se muestran los primeros 1000 usuarios WMS. El directorio requiere paginación para consultar más registros.')
      return true
    } catch (e) {
      if (signal?.aborted) return false
      setUsers([]); setRoles([]); setTmsUsers([]); setError(e instanceof Error ? e.message : 'No se pudo consultar WMS')
      return false
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    // Fetch the external directory on mount, with cancellation on system change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  const operationalRoles = roles.filter(r => !isSystemAdminRole(r.name) && r.permissions?.includes('almacen-lectura'))
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setNotice('')
    setFirstAccessUrl(null)
    try {
      const response = await fetch('/api/admin/wms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'users' && !editing
        ? { action: 'provision_tms_user', tms_profile_id: selectedTmsId, role_id: account.role_id, is_active: account.is_active }
        : { action: mode === 'users' ? 'user' : 'role', id: editing, ...(mode === 'users' ? account : role) }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setOpen(false); setAccount(EMPTY)
      setNotice(data.message || 'Cambio guardado únicamente en WMS. Los accesos de TMS no cambiaron.')
      setFirstAccessUrl(data.firstAccessUrl || null)
      setFirstAccessEmail(data.firstAccessRecipient || '')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar WMS') }
    finally { setSaving(false) }
  }
  const create = () => { setEditing(null); setAccount(EMPTY); setSelectedTmsId(''); setTmsSearch(''); setFirstAccessUrl(null); setRole({ name: '', description: '', permissions: ['almacen-lectura'] }); setError(''); setOpen(true) }
  const selectedTms = tmsUsers.find(u => u.id === selectedTmsId)
  const selectableTms = tmsUsers.filter(u => u.id === selectedTmsId || `${u.first_name} ${u.last_name} ${u.username || u.email} ${u.document_number}`.toLowerCase().includes(tmsSearch.toLowerCase()))
  const filtered = users.filter(u => `${u.first_name} ${u.last_name} ${u.username || u.email} ${u.document_number}`.toLowerCase().includes(search.toLowerCase()))
  return <section className="space-y-4">
    <div className="flex flex-wrap justify-between gap-3"><div><h1 className="text-xl font-bold">{mode === 'users' ? 'Usuarios del WMS' : 'Roles y permisos del WMS'}</h1><p className="text-sm text-slate-600">{mode === 'users' ? 'Seleccione una persona registrada en TMS para asignarle rol y acceso al almacén. Su acceso TMS permanece independiente.' : 'Estos permisos se aplican solamente al almacén. Los roles con el mismo nombre en TMS son independientes.'}</p></div><button className={buttonClass} disabled={loading || !!error} onClick={create}>{mode === 'users' ? 'Habilitar usuario TMS' : 'Nuevo rol WMS'}</button></div>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error} {!open && <button onClick={() => void load()} className="ml-3 underline">Reintentar</button>}</div>}
    {firstAccessUrl && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm"><p>Primer acceso: comparta este enlace solo con {firstAccessEmail} para que configure su contraseña WMS.</p><button type="button" className="mt-2 underline" onClick={async () => { try { await navigator.clipboard.writeText(firstAccessUrl); setNotice('Enlace de primer acceso copiado.') } catch { setError('No se pudo copiar el enlace. Intente nuevamente.') } }}>Copiar enlace de primer acceso</button></div>}
    {notice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-blue-900">{notice}</p>}
    {loading ? <p role="status">Consultando WMS…</p> : !error && (mode === 'users' ? <>
      <label className="block text-sm">Buscar usuario WMS<input className={inputClass} value={search} onChange={e => setSearch(e.target.value)} placeholder="Nombre, correo o documento" /></label>
      <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr>{['Usuario', 'Correo', 'Rol WMS', 'Acceso WMS', 'Acciones'].map(h => <th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>{filtered.map(u => <tr key={u.id} className="border-t"><td className="p-3">{u.first_name} {u.last_name}</td><td className="p-3">{u.username || u.email}</td><td className="p-3">{u.roles?.name || 'Sin rol'}</td><td className="p-3">{u.is_active && u.role_id ? 'Habilitado' : 'Deshabilitado'}</td><td className="p-3">{isSystemAdminRole(u.roles?.name) ? 'Administrador protegido' : <button className="underline" onClick={() => { setFirstAccessUrl(null); setEditing(u.id); setAccount({ ...EMPTY, ...u, username: u.username || u.email, phone: u.phone || '', document_number: u.document_number || '' }); setOpen(true) }}>Editar acceso WMS</button>}</td></tr>)}{!filtered.length && <tr><td colSpan={5} className="p-6">No hay usuarios WMS que coincidan.</td></tr>}</tbody></table></div>
    </> : <div className="grid gap-3 md:grid-cols-2">{operationalRoles.map(r => <article key={r.id} className="rounded-xl border bg-white p-4 space-y-2"><h2 className="font-semibold">{r.name}</h2><p className="text-sm text-slate-600">{r.description}</p><ul className="list-disc pl-5 text-sm">{r.permissions.map(p => <li key={p}>{WMS_PERMISSIONS.find(([key]) => key === p)?.[1] || p}</li>)}</ul><button className="underline text-sm" onClick={() => { setEditing(r.id); setRole({ name: r.name, description: r.description || '', permissions: r.permissions }); setOpen(true) }}>Editar permisos WMS</button></article>)}</div>)}
    <Modal isOpen={open} onClose={() => { if (!saving) { setOpen(false); setError('') } }} title={mode === 'users' && !editing ? 'Habilitar usuario TMS en WMS' : `${editing ? 'Editar' : 'Crear'} ${mode === 'users' ? 'usuario' : 'rol'} WMS`}>
      <form onSubmit={save} className="space-y-4"><p className="rounded-lg bg-blue-50 p-3 text-sm">Este cambio afecta únicamente WMS.</p>{error && <p role="alert" className="text-red-700">{error}</p>}
        {mode === 'users' ? <>
          {!editing ? <div className="space-y-3">
            <label className="block text-sm">Buscar usuario TMS<input className={inputClass} value={tmsSearch} onChange={e => setTmsSearch(e.target.value)} placeholder="Nombre, correo o documento" /></label>
            <label className="block text-sm">Usuario registrado en TMS<select aria-label="Usuario registrado en TMS" required className={inputClass} value={selectedTmsId} onChange={e => {
              setSelectedTmsId(e.target.value)
              const person = tmsUsers.find(u => u.id === e.target.value)
              const existing = users.find(u => (u.email || u.username)?.toLowerCase() === (person?.username || person?.email)?.toLowerCase())
              setAccount({ ...EMPTY, role_id: existing?.role_id || '', is_active: existing?.is_active || false })
            }}><option value="">Seleccione un usuario TMS</option>{selectableTms.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name} · {u.username || u.email || 'Sin correo'}</option>)}</select></label>
            {!tmsUsers.length && <p role="status" className="text-amber-800">No hay usuarios TMS disponibles. Registre primero a la persona en la pestaña TMS.</p>}
            {selectedTms && <dl className="rounded-lg bg-slate-50 p-3 text-sm"><dt className="font-semibold">Datos registrados en TMS</dt><dd>{selectedTms.first_name} {selectedTms.last_name}</dd><dd>{selectedTms.username || selectedTms.email}</dd><dd>Documento: {selectedTms.document_number || 'Sin registrar'}</dd></dl>}
            <p className="text-sm text-slate-600">Si ya tiene cuenta WMS, se conserva su contraseña. Si es nuevo, al guardar se mostrará un enlace de primer acceso para compartir con la persona.</p>
          </div> : <div className="grid gap-3 sm:grid-cols-2">{([['first_name', 'Nombres'], ['last_name', 'Apellidos'], ['username', 'Correo corporativo'], ['document_number', 'Documento'], ['phone', 'Teléfono']] as const).map(([key, label]) => <label key={key} className="text-sm">{label}<input className={inputClass} type={key === 'username' ? 'email' : 'text'} maxLength={key === 'document_number' ? 20 : 120} required={key !== 'phone'} value={account[key]} onChange={e => setAccount({ ...account, [key]: e.target.value })} /></label>)}</div>}
          <label className="block text-sm">Rol WMS<select aria-label="Rol WMS" required className={inputClass} value={account.role_id} onChange={e => setAccount({ ...account, role_id: e.target.value })}><option value="">Seleccione un rol WMS</option>{operationalRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          {editing && <label className="block text-sm">Nueva contraseña WMS (opcional)<input type="password" autoComplete="new-password" minLength={8} maxLength={200} required={!editing} className={inputClass} value={account.password} onChange={e => setAccount({ ...account, password: e.target.value })} /></label>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={account.is_active} onChange={e => setAccount({ ...account, is_active: e.target.checked })} />Habilitar acceso al WMS</label><p className="text-sm text-slate-600">Desmarcado: cuenta WMS inactiva. Su acceso al TMS permanece como estaba.</p>
        </> : <>
          <label className="block text-sm">Nombre del rol WMS<input required disabled={!!editing} maxLength={50} className={inputClass} value={role.name} onChange={e => setRole({ ...role, name: e.target.value })} /></label>
          <label className="block text-sm">Descripción<textarea className={inputClass} maxLength={1000} value={role.description} onChange={e => setRole({ ...role, description: e.target.value })} /></label>
          <fieldset className="space-y-2"><legend className="font-semibold">Permisos del almacén</legend>{WMS_PERMISSIONS.map(([key, label]) => <label key={key} className="flex gap-2"><input type="checkbox" checked={role.permissions.includes(key)} disabled={key === 'almacen-lectura'} onChange={e => setRole({ ...role, permissions: e.target.checked ? [...role.permissions, key] : role.permissions.filter(p => p !== key) })} />{label}</label>)}</fieldset>
        </>}
        <div className="flex justify-end gap-3"><button type="button" disabled={saving} onClick={() => { setOpen(false); setError('') }}>Cancelar</button><button className={buttonClass} disabled={saving}>{saving ? 'Guardando…' : 'Guardar en WMS'}</button></div>
      </form>
    </Modal>
  </section>
}
