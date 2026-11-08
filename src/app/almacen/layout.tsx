'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import {
  Boxes, ClipboardList, PackageCheck, ScanLine, ShieldCheck, Waypoints, Settings2,
  Menu, X, LogOut, UserRound, Warehouse,
} from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { createClient } from '@/lib/supabase/client'

const links = [
  { href: '/almacen', label: 'Centro WMS', icon: Boxes, permission: 'almacen-lectura', group: 'Inicio' },
  { href: '/almacen/apt/etiquetado', label: '01 · Actualizar ingresos WMS', icon: Warehouse, permission: 'almacen-carga', group: 'Recepción' },
  { href: '/almacen/etiquetado', label: '02 · Recepción por IPT', icon: ScanLine, permission: 'almacen-etiquetado', group: 'Recepción' },
  { href: '/almacen/apt/etiquetas-impresas', label: '03 · Control de recepción', icon: PackageCheck, permission: 'almacen-etiquetado', group: 'Recepción' },
  { href: '/almacen/tareas', label: 'Tareas', icon: ClipboardList, permission: 'almacen-picking', group: 'Despacho' },
  { href: '/almacen/paquetes', label: 'Paquetes y LPN', icon: PackageCheck, permission: 'almacen-packing', group: 'Despacho' },
  { href: '/almacen/auditoria', label: 'Auditoría', icon: ShieldCheck, permission: 'almacen-auditoria', group: 'Despacho' },
  { href: '/almacen/stock-erp', label: 'Stock ERP', icon: Boxes, permission: 'almacen-lectura', group: 'Control' },
  { href: '/almacen/conciliacion', label: 'Conciliación', icon: Waypoints, permission: 'almacen-carga', group: 'Control' },
  { href: '/almacen/maestros/embalajes', label: 'Embalajes', icon: Settings2, permission: 'almacen-supervisor', group: 'Configuración' },
  { href: '/almacen/maestros/etiquetas', label: 'Etiquetas', icon: Settings2, permission: 'almacen-supervisor', group: 'Configuración' },
]

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/almacen'
  const { hasAccess, isLoaded, role } = usePermissions()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [email, setEmail] = useState('')
  const visible = useMemo(() => links.filter(x =>
    x.href === '/almacen/stock-erp'
      ? ['almacen-lectura', 'almacen-carga', 'almacen-supervisor'].some(hasAccess)
      : x.href === '/almacen/conciliacion'
      ? ['almacen-carga', 'almacen-supervisor', 'apt-carga'].some(hasAccess)
      : x.href === '/almacen/auditoria'
        ? ['almacen-auditoria', 'almacen-supervisor'].some(hasAccess)
      : x.href === '/almacen/tareas'
        ? ['almacen-lectura', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-supervisor'].some(hasAccess)
        : x.href === '/almacen/paquetes'
          ? ['almacen-lectura', 'almacen-packing', 'almacen-carga', 'almacen-supervisor'].some(hasAccess)
          : x.href === '/almacen' || x.href.startsWith('/almacen/apt/')
            ? ['almacen-lectura', 'almacen-supervisor', 'almacen-etiquetado', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'apt', 'apt-carga'].some(hasAccess)
            : hasAccess(x.permission)
  ), [hasAccess])
  const current = visible.find(x => x.href === pathname) || [...visible].filter(x => pathname.startsWith(x.href + '/')).sort((a,b) => b.href.length-a.href.length)[0]
  const hasTmsAccess = ['dashboard','reportes','clientes','ot','solicitudes','despacho','torre-control','mantenimiento-dashboard','caja','usuarios'].some(hasAccess)

  useEffect(() => {
    if (pathname === '/almacen/login') return
    let live = true
    void createClient().auth.getUser().then(({ data }) => {
      if (live) setEmail(data.user?.email || '')
    }).catch(() => {})
    return () => { live = false }
  }, [pathname])

  if (pathname === '/almacen/login') return <>{children}</>
  if (!isLoaded) return <div className="grid min-h-dvh place-items-center bg-slate-50 text-sm text-slate-500">Cargando Portal de Almacén…</div>

  const closeMenu = () => setMobileOpen(false)
  const signOut = async () => {
    await createClient().auth.signOut()
    window.location.assign('/almacen/login')
  }

  return <div className="flex h-dvh min-w-0 bg-slate-50 text-slate-900">
    {mobileOpen && <button aria-label="Cerrar menú" className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden" onClick={closeMenu} />}
    <aside className={`fixed inset-y-0 left-0 z-50 flex w-[264px] max-w-[calc(100vw-2rem)] flex-col border-r border-[#123e74] bg-[#002855] text-[#d4e0f2] shadow-2xl transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:shadow-none ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="h-1 shrink-0 bg-[#cf152d]" />
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <Link href="/almacen" onClick={closeMenu} className="flex min-w-0 flex-1 items-center gap-2">
          <img src="/logo-jrm.png" alt="JRM" className="h-7 w-auto shrink-0 object-contain" />
          <span className="min-w-0 leading-tight"><b className="block truncate text-[13px] text-white">JRM Almacén</b><small className="block truncate text-[9px] font-bold uppercase tracking-[0.18em] text-blue-200">Operación WMS</small></span>
        </Link>
        <button onClick={closeMenu} className="grid h-10 w-10 place-items-center rounded-lg text-blue-200 hover:bg-white/10 lg:hidden" aria-label="Cerrar navegación"><X size={17}/></button>
      </div>
      <nav aria-label="Menú de Almacén" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-3">
        {(['Inicio','Recepción','Despacho','Control','Configuración'] as const).map(group => {
          const items = visible.filter(x => x.group === group)
          if (!items.length) return null
          return <section key={group} className="mb-3">
            <p className="px-3 pb-1 pt-2 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-[#8fa6c8]">{group}</p>
            <div className="space-y-0.5">{items.map(({href,label,icon:Icon}) => {
              const active = href === '/almacen' ? pathname === href : pathname === href || pathname.startsWith(href + '/')
              return <Link key={href} href={href} onClick={closeMenu} aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] transition-colors ${active ? 'bg-white font-semibold text-[#002855]' : 'font-medium text-[#d4e0f2] hover:bg-white/10 hover:text-white'}`}>
                {active && <span className="absolute -left-2 top-1.5 bottom-1.5 w-[3px] rounded-r bg-[#cf152d]" />}
                <Icon size={16} className={active ? 'text-[#cf152d]' : ''}/><span className="truncate">{label}</span>
              </Link>
            })}</div>
          </section>
        })}
      </nav>
      <div className="border-t border-white/10 p-2.5">
        <div className="flex items-center gap-2">
          <Link href="/perfil" onClick={closeMenu} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1.5 hover:bg-white/10" title="Mi perfil">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-xs font-extrabold uppercase text-[#002855]">{(role || 'WM').slice(0,2)}</span>
            <span className="min-w-0 leading-tight"><b className="block truncate text-xs capitalize text-white">{role || 'Sesión activa'}</b><small className="block truncate text-[10px] text-blue-200">{email || 'Cuenta activa'}</small></span>
          </Link>
          <button type="button" onClick={() => void signOut()} aria-label="Cerrar sesión" title="Cerrar sesión" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-blue-200 hover:bg-white/10 hover:text-white"><LogOut size={16}/></button>
        </div>
      </div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-200 border-t-[3px] border-t-[#cf152d] bg-white px-3 sm:px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={() => setMobileOpen(true)} aria-label="Mostrar menú" aria-expanded={mobileOpen} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-[#002855] lg:hidden"><Menu size={19}/></button>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#002855] sm:text-[11px]"><span className="h-[3px] w-5 shrink-0 rounded bg-[#cf152d]"/><span className="truncate">Operación WMS{current ? ` › ${current.group}` : ''}</span></p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          {process.env.NEXT_PUBLIC_DEPLOYMENT_SYSTEM !== 'wms' && <NotificationBell />}
          {hasTmsAccess && <a href={process.env.NEXT_PUBLIC_TMS_ORIGIN || 'https://www.jrmlogistica.app'} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"><Boxes size={16}/><span className="hidden sm:inline">Ir al TMS</span></a>}
          <Link href="/perfil" aria-label="Mi perfil" className="flex min-w-0 items-center gap-2 border-l border-slate-200 pl-2 sm:gap-3 sm:pl-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-100 text-blue-700 sm:h-10 sm:w-10"><UserRound size={17}/></div>
            <div className="hidden min-w-0 lg:block"><p className="text-xs font-semibold capitalize text-slate-700">{role || "Usuario"}</p><p className="max-w-40 truncate text-[11px] text-slate-500" title={email}>{email || "Sesión activa"}</p></div>
          </Link>
        </div>
      </header>
      <main className="relative z-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-auto p-3 sm:p-4 lg:p-5">{children}</main>
      <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-2.5 text-center text-[11px] text-slate-500">JRM TMS · Portal de Almacén · Trazabilidad de operaciones</footer>
    </div>
  </div>
}
