"use client"

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, History, LogOut, Moon, Pin, PinOff, Search, Star, Sun, X } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { HOME_ITEM, activeEntry, flatEntries, normalize, visibleSections, type NavEntry, type NavItem } from '@/lib/nav/navConfig'
import { setSidebar, useSidebar, type SidebarTheme } from '@/lib/nav/sidebarStore'
import { COUNT_STYLE, countLabel, useMenuCounts, type MenuCount } from '@/lib/nav/useMenuCounts'

// Menú lateral: secciones plegables (varias abiertas), buscador (Ctrl + K), favoritos, recientes y dos paletas.
// Fijado: siempre visible. Sin fijar: oculto; aparece al acercar el mouse al borde izquierdo, con ☰ o con Ctrl + B.
// En celular y tablet es un panel deslizable. Contadores de pendientes por pantalla (menu_pending_counts).
// Identidad del login: azul #002855 con franja roja; la sección donde está la página actual va en un bloque resaltado
// con la línea roja del login delante del nombre, aunque esté plegada.

const PALETTE: Record<SidebarTheme, Record<string, string>> = {
  azul: {
    '--sb-bg': '#002855', '--sb-line': '#123e74', '--sb-field': '#05336a', '--sb-fg': '#d4e0f2', '--sb-strong': '#ffffff',
    '--sb-muted': '#9fb4d3', '--sb-label': '#8fa6c8', '--sb-hover': 'rgba(255,255,255,0.08)', '--sb-active': '#ffffff',
    '--sb-active-fg': '#002855', '--sb-red': '#cf152d', '--sb-bar': '#e0283f',
    '--sb-sec': 'rgba(255,255,255,0.08)', '--sb-sec-line': 'rgba(255,255,255,0.12)',
  },
  claro: {
    '--sb-bg': '#ffffff', '--sb-line': '#e3e8f0', '--sb-field': '#f4f6fa', '--sb-fg': '#334155', '--sb-strong': '#0f1d36',
    '--sb-muted': '#64748b', '--sb-label': '#5b6880', '--sb-hover': '#f1f4f9', '--sb-active': '#e8eff9',
    '--sb-active-fg': '#002855', '--sb-red': '#cf152d', '--sb-bar': '#cf152d',
    '--sb-sec': '#f3f6fb', '--sb-sec-line': '#dfe6f1',
  },
}

function Row({ entry, active, fav, onFav, showSection, count }: {
  entry: NavEntry; active: boolean; fav: boolean; onFav: (href: string) => void; showSection?: boolean; count?: MenuCount
}) {
  const { item, section, group } = entry
  const Icon = item.icon
  return (
    <div className="group relative">
      <Link href={item.href} aria-current={active ? 'page' : undefined}
        className={`relative flex min-h-11 items-center gap-3 rounded-lg py-1.5 pl-3 pr-12 lg:min-h-[34px] lg:pr-8 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--sb-red)] ${
          active ? 'bg-[var(--sb-active)] font-semibold text-[var(--sb-active-fg)]' : 'font-medium text-[var(--sb-fg)] hover:bg-[var(--sb-hover)] hover:text-[var(--sb-strong)]'}`}>
        {active && <span className="absolute -left-2 top-1.5 bottom-1.5 w-[3px] rounded-r bg-[var(--sb-bar)]" />}
        <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-[var(--sb-red)]' : ''}`} />
        <span className="min-w-0 flex-1 truncate">
          {item.label}
          {showSection && <span className="block truncate text-[10px] font-medium text-[var(--sb-muted)]">{section?.title || 'Inicio'}{group ? ` › ${group}` : ''}</span>}
        </span>
        {count && (
          <span title={count.texto} aria-label={count.texto}
            className={`shrink-0 rounded-full px-1.5 py-px font-mono text-[10.5px] font-bold tabular-nums ${COUNT_STYLE[count.tono]}`}>{countLabel(count)}</span>
        )}
      </Link>
      <button type="button" onClick={() => onFav(item.href)} aria-label={fav ? `Quitar ${item.label} de favoritos` : `Agregar ${item.label} a favoritos`}
        title={fav ? 'Quitar de favoritos' : 'Agregar a favoritos'}
        className={`absolute right-1 top-1/2 grid h-11 w-11 lg:right-1.5 lg:h-6 lg:w-6 -translate-y-1/2 place-items-center rounded-md transition-opacity hover:bg-[var(--sb-hover)] focus-visible:opacity-100 ${
          fav ? 'text-amber-400 opacity-100' : 'text-[var(--sb-muted)] lg:opacity-0 lg:group-hover:opacity-100'}`}>
        <Star className={`h-3.5 w-3.5 ${fav ? 'fill-amber-400' : ''}`} />
      </button>
    </div>
  )
}

export function Sidebar() {
  const { role, hasAccess: hasPermission } = usePermissions()
  const pathname = usePathname() || '/'
  const router = useRouter()
  const sb = useSidebar()
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const counts = useMenuCounts(pathname)

  const home = useMemo(() => HOME_ITEM(role === 'admin'), [role])
  const sections = useMemo(() => visibleSections(hasPermission), [hasPermission])
  const entries = useMemo(() => flatEntries(sections, home), [sections, home])
  const current = activeEntry(entries, pathname)
  const activeSection = current?.section?.id || null
  const openSet = new Set(sb.open ?? (activeSection ? [activeSection] : []))

  // Al cambiar de página: cerrar el panel, registrar reciente y abrir la sección de la página
  const lastPath = useRef<string | null>(null)
  useEffect(() => {
    if (lastPath.current === pathname) return
    const e = activeEntry(flatEntries(visibleSections(hasPermission), HOME_ITEM(role === 'admin')), pathname)
    if (e) lastPath.current = pathname   // sin permisos cargados aún: se registra cuando lleguen
    setSidebar(s => ({
      overlay: false,
      recents: e ? [e.item.href, ...s.recents.filter(h => h !== e.item.href)].slice(0, 4) : s.recents,
      open: s.open && e?.section && !s.open.includes(e.section.id) ? [...s.open, e.section.id] : s.open,
    }))
  }, [pathname, hasPermission, role])

  // Atajos: Ctrl + K busca, Ctrl + B fija o suelta el menú, Esc cierra
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase()
      if ((ev.ctrlKey || ev.metaKey) && k === 'k') {
        ev.preventDefault()
        setSidebar({ overlay: true })
        setTimeout(() => searchRef.current?.focus(), 30)
      } else if ((ev.ctrlKey || ev.metaKey) && k === 'b') {
        ev.preventDefault()
        if (window.matchMedia('(min-width: 1024px)').matches) setSidebar(s => ({ pinned: !s.pinned, overlay: false }))
        else setSidebar(s => ({ overlay: !s.overlay }))
      } else if (k === 'escape') {
        setSidebar({ overlay: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleSection = (id: string) => {
    const next = new Set(openSet)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSidebar({ open: [...next] })
  }
  const toggleFav = (href: string) => setSidebar(s => ({
    favs: s.favs.includes(href) ? s.favs.filter(h => h !== href) : [...s.favs, href].slice(-5),
  }))

  const nq = normalize(q.trim())
  const results = nq
    ? entries.filter(e => normalize(`${e.item.label} ${e.section?.title || 'inicio'} ${e.group || ''} ${e.item.keywords || ''}`).includes(nq))
    : []
  const byHref = (h: string) => entries.find(e => e.item.href === h)
  const favEntries = sb.favs.map(byHref).filter((e): e is NavEntry => !!e)
  const recentEntries = sb.recents.filter(h => !sb.favs.includes(h) && h !== current?.item.href).map(byHref)
    .filter((e): e is NavEntry => !!e).slice(0, 3)
  const isActive = (it: NavItem) => current?.item.href === it.href
  const row = (e: NavEntry, showSection = false) => (
    <Row key={`${e.item.href}-${showSection ? 's' : ''}`} entry={e} active={isActive(e.item)} fav={sb.favs.includes(e.item.href)} onFav={toggleFav}
      showSection={showSection} count={counts[e.item.href]} />
  )
  const label = 'px-3 pb-1 pt-3 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-[var(--sb-label)]'

  return (
    <>
      {/* Borde izquierdo: muestra el menú sin fijar al acercar el mouse */}
      {!sb.pinned && <div aria-hidden className="fixed inset-y-0 left-0 z-[59] hidden w-2 lg:block" onMouseEnter={() => setSidebar({ overlay: true })} />}
      {sb.overlay && <div aria-hidden className={`fixed inset-0 z-[59] bg-slate-950/40 ${sb.pinned ? 'lg:hidden' : 'lg:bg-transparent'}`} onClick={() => setSidebar({ overlay: false })} />}

      <aside id="principal-navigation" aria-label="Menú principal" style={PALETTE[sb.theme] as CSSProperties}
        onMouseLeave={() => { if (!sb.pinned && sb.overlay && window.matchMedia('(min-width: 1024px)').matches && document.activeElement !== searchRef.current) setSidebar({ overlay: false }) }}
        className={`fixed inset-y-0 left-0 z-[60] flex w-[264px] max-w-[calc(100vw-2rem)] flex-col border-r border-[var(--sb-line)] bg-[var(--sb-bg)] text-[var(--sb-fg)] shadow-2xl transition-transform duration-200 motion-reduce:transition-none ${
          sb.overlay ? 'visible translate-x-0' : 'invisible -translate-x-full'} ${sb.pinned ? 'lg:visible lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 lg:shadow-none' : ''}`}>

        <div aria-hidden className="h-1 shrink-0 bg-[var(--sb-red)]" />
        {/* Cabecera */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--sb-line)] pl-3 pr-2">
          <Link href="/" className="flex min-w-0 flex-1 items-center gap-2 rounded-md">
            <img src="/logo-jrm.png" alt="JRM" className="h-7 w-auto shrink-0 object-contain" />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[13px] font-extrabold text-[var(--sb-strong)]">JRM TMS</span>
              <span className="block truncate text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--sb-muted)]">Control Tower</span>
            </span>
          </Link>
          <button type="button" onClick={() => setSidebar(s => ({ pinned: !s.pinned, overlay: false }))}
            title={sb.pinned ? 'Soltar: el menú se oculta y aparece al acercar el mouse (Ctrl + B)' : 'Fijar el menú (Ctrl + B)'}
            aria-label={sb.pinned ? 'Soltar menú' : 'Fijar menú'} aria-pressed={sb.pinned}
            className="hidden h-8 w-8 place-items-center rounded-lg text-[var(--sb-muted)] hover:bg-[var(--sb-hover)] hover:text-[var(--sb-strong)] lg:grid">
            {sb.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
          <button type="button" onClick={() => setSidebar({ overlay: false })} aria-label="Cerrar menú"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--sb-muted)] hover:bg-[var(--sb-hover)] lg:hidden">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Buscador */}
        <div className="px-3 pb-1 pt-3">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-[var(--sb-line)] bg-[var(--sb-field)] px-2.5 text-[var(--sb-muted)] focus-within:border-[var(--sb-red)]">
            <Search className="h-4 w-4 shrink-0" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} type="search" placeholder="Buscar pantalla…" autoComplete="off" aria-label="Buscar pantalla"
              onKeyDown={e => {
                if (e.key === 'Enter' && results[0]) { router.push(results[0].item.href); setQ('') }
                if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() }
              }}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium text-[var(--sb-strong)] outline-none placeholder:text-[var(--sb-muted)]" />
            <kbd className="hidden rounded border border-[var(--sb-line)] px-1 font-mono text-[10px] font-bold lg:inline">Ctrl K</kbd>
          </label>
        </div>

        {/* Navegación */}
        <nav className="sidebar-scroll min-h-0 flex-1 overscroll-contain overflow-y-auto px-2 pb-4">
          {nq ? (
            results.length ? <div className="space-y-0.5 pt-1">{results.map(e => row(e, true))}</div>
              : <p className="px-3 py-4 text-xs text-[var(--sb-muted)]">No hay pantallas con «{q.trim()}».</p>
          ) : (
            <>
              <div className="pt-1">{row(entries[0])}</div>
              {favEntries.length > 0 && (
                <div>
                  <p className={`${label} flex items-center gap-1.5`}><Star className="h-3 w-3 fill-amber-400 text-amber-400" /> Favoritos</p>
                  <div className="space-y-0.5">{favEntries.map(e => row(e))}</div>
                </div>
              )}
              {recentEntries.length > 0 && (
                <div>
                  <p className={`${label} flex items-center gap-1.5`}><History className="h-3 w-3" /> Recientes</p>
                  <div className="space-y-0.5">{recentEntries.map(e => row(e))}</div>
                </div>
              )}
              {sections.map(s => {
                const open = openSet.has(s.id)
                const SIcon = s.icon
                // Sección cerrada: total de pendientes urgentes (rojo) o aviso (ámbar) para no perder alertas
                const secCounts = s.groups.flatMap(g => g.items).map(i => counts[i.href]).filter((c): c is MenuCount => !!c)
                const crit = secCounts.filter(c => c.tono === 'crit').reduce((a, c) => a + c.n, 0)
                const warn = secCounts.some(c => c.tono === 'warn')
                const here = activeSection === s.id
                return (
                  <div key={s.id} className={`mt-1 ${here ? 'rounded-xl bg-[var(--sb-sec)] pb-1 ring-1 ring-[var(--sb-sec-line)]' : ''}`}>
                    <button type="button" onClick={() => toggleSection(s.id)} aria-expanded={open}
                      title={here ? 'Estás en esta sección' : undefined}
                      className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 pb-1.5 pt-2.5 lg:min-h-0 text-left text-[10.5px] font-extrabold uppercase tracking-[0.12em] transition-colors hover:text-[var(--sb-strong)] ${
                        here ? 'text-[var(--sb-strong)]' : 'text-[var(--sb-label)]'}`}>
                      {here ? <span aria-hidden className="h-[3px] w-4 shrink-0 rounded bg-[var(--sb-red)]" /> : <SIcon className="h-3.5 w-3.5" />}
                      <span className="flex-1 truncate">{s.title}</span>
                      {!open && crit > 0 && <span className={`rounded-full px-1.5 py-px font-mono text-[10px] tracking-normal ${COUNT_STYLE.crit}`} title={`${crit} pendientes por atender`}>{crit > 99 ? '99+' : crit}</span>}
                      {!open && !crit && warn && <span className="h-2 w-2 rounded-full bg-amber-300" title="Hay avisos en esta sección" />}
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
                    </button>
                    {open && (
                      <div className={`space-y-0.5 ${here ? 'mx-1 border-l border-[var(--sb-sec-line)] pl-1' : ''}`}>
                        {s.groups.map(g => (
                          <div key={g.title || 'g'}>
                            {g.title && <p className="px-3 pb-0.5 pt-2 text-[10px] font-bold text-[var(--sb-muted)]">{g.title}</p>}
                            {g.items.map(item => row({ item, section: s, group: g.title }))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </nav>

        {/* Usuario */}
        <div className="flex items-center gap-2 border-t border-[var(--sb-line)] px-3 py-2.5">
          <Link href="/perfil" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 hover:bg-[var(--sb-hover)]" title="Mi perfil">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--sb-active)] text-xs font-extrabold uppercase text-[var(--sb-active-fg)]">{role.substring(0, 2)}</span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[12.5px] font-semibold capitalize text-[var(--sb-strong)]">{role}</span>
              <span className="block text-[11px] text-[var(--sb-muted)]">Sesión activa</span>
            </span>
          </Link>
          <button type="button" onClick={() => setSidebar(s => ({ theme: s.theme === 'azul' ? 'claro' : 'azul' }))}
            title={sb.theme === 'azul' ? 'Cambiar a menú claro' : 'Cambiar a menú azul'} aria-label="Cambiar colores del menú"
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--sb-muted)] hover:bg-[var(--sb-hover)] hover:text-[var(--sb-strong)]">
            {sb.theme === 'azul' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            onClick={async () => {
              try {
                const { createClient } = await import('@/lib/supabase/client')
                const supabase = createClient()
                await supabase.auth.signOut()
                localStorage.removeItem('userRole')
                localStorage.removeItem('userPermissions')
                window.location.href = '/login'
              } catch (err) {
                console.error('Error al cerrar sesión', err)
              }
            }}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--sb-muted)] hover:bg-red-500/15 hover:text-red-500">
            <LogOut className="h-4 w-4" />
          </button>
        </div>

        <style dangerouslySetInnerHTML={{ __html: `
          .sidebar-scroll { scrollbar-width: thin; scrollbar-color: var(--sb-line) transparent; }
          .sidebar-scroll::-webkit-scrollbar { width: 4px; }
          .sidebar-scroll::-webkit-scrollbar-thumb { background: var(--sb-line); border-radius: 4px; }
        ` }} />
      </aside>
    </>
  )
}
