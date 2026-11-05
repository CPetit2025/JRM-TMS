'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Boxes, ClipboardList, PackageCheck, ScanLine, ShieldCheck, Truck, Waypoints, Settings2 } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'

const links = [
  { href: '/almacen', label: 'Inicio', icon: Boxes, permission: 'almacen-lectura' },
  { href: '/almacen/tareas', label: 'Tareas', icon: ClipboardList, permission: 'almacen-picking' },
  { href: '/almacen/etiquetado', label: 'Etiquetado', icon: ScanLine, permission: 'almacen-etiquetado' },
  { href: '/almacen/paquetes', label: 'Paquetes y LPN', icon: PackageCheck, permission: 'almacen-packing' },
  { href: '/almacen/conciliacion', label: 'Conciliación', icon: Waypoints, permission: 'almacen-carga' },
  { href: '/almacen/maestros/embalajes', label: 'Embalajes', icon: Settings2, permission: 'almacen-supervisor' },
  { href: '/almacen/apt/datos', label: 'Actualizable APT', icon: Boxes, permission: 'apt' },
]

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { hasAccess, isLoaded } = usePermissions()
  if (pathname === '/almacen/login') return <>{children}</>
  const hasTmsAccess = ['dashboard','reportes','clientes','ot','solicitudes','despacho','torre-control','mantenimiento-dashboard','caja','usuarios'].some(hasAccess)
  const visible = links.filter(x => x.href === '/almacen/conciliacion' ? ['almacen-carga','almacen-supervisor','apt-carga'].some(hasAccess) : x.href === '/almacen/tareas' ? ['almacen-lectura','almacen-picking','almacen-packing','almacen-carga','almacen-supervisor'].some(hasAccess) : x.href === '/almacen/paquetes' ? ['almacen-lectura','almacen-packing','almacen-carga','almacen-supervisor'].some(hasAccess) : x.href === '/almacen' ? ['almacen-lectura','almacen-supervisor','almacen-etiquetado','almacen-picking','almacen-packing','almacen-carga','apt','apt-carga'].some(hasAccess) : x.href === '/almacen/apt/datos' ? ['almacen-lectura','almacen-supervisor','almacen-etiquetado','almacen-picking','almacen-packing','almacen-carga','apt','apt-carga'].some(hasAccess) : hasAccess(x.permission))
  if (!isLoaded) return <div className="grid min-h-dvh place-items-center text-sm text-slate-500">Cargando Portal de Almacén…</div>
  return <div className="min-h-dvh bg-slate-50 text-slate-900">
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white shadow-sm">
      <div className="mx-auto flex max-w-screen-2xl items-center justify-between gap-3 px-4 py-3 lg:px-8">
        <Link href="/almacen" className="flex items-center gap-3 text-[#002855]"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#002855] text-white"><Boxes size={23}/></span><span><b className="block text-base">JRM Almacén</b><small className="text-slate-500">Operación WMS</small></span></Link>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Portal de Almacén">
          {visible.map(({href,label,icon:Icon}) => <Link key={href} href={href} aria-current={href === '/almacen' ? pathname === href ? 'page' : undefined : pathname.startsWith(href) ? 'page' : undefined} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${pathname === href || (href !== '/almacen' && pathname.startsWith(href)) ? 'bg-blue-50 text-[#002855]' : 'text-slate-600 hover:bg-slate-100'}`}><Icon size={17}/>{label}</Link>)}
        </nav>
        <div className="flex items-center gap-2">{hasTmsAccess&&<Link className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700" href="/">Ir al TMS</Link>}<span className="hidden rounded-full bg-blue-50 p-2 text-[#002855] sm:block"><ShieldCheck size={18}/></span></div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t border-slate-100 px-2 py-1 lg:hidden">{visible.map(({href,label})=><Link key={href} href={href} className="whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold text-[#002855]">{label}</Link>)}</nav>
    </header>
    <main className="mx-auto max-w-screen-2xl px-4 py-5 lg:px-8">{children}</main>
    <footer className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-500">JRM TMS · Portal de Almacén · Trazabilidad de operaciones</footer>
  </div>
}
