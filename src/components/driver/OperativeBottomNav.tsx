'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Bell, ClipboardCheck, History, Home, Map, Truck, User } from 'lucide-react'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

export function OperativeBottomNav() {
  const path = usePathname()
  const { trip, pending, driver, user } = useActiveTrip()
  const [storedDriver, setStoredDriver] = useState(false)
  useEffect(() => {
    const initial = window.setTimeout(() => setStoredDriver(Boolean(localStorage.getItem('jrm_driver'))), 0)
    return () => window.clearTimeout(initial)
  }, [])
  const isDriver = Boolean(driver || user?.employee_type === 'CONDUCTOR' || storedDriver)
  const centerHref = isDriver ? (pending.checklist && trip ? '/app/checklist' : trip ? '/app/ruta' : '/app/viajes') : '/app/tareo'
  const CenterIcon = isDriver ? (pending.checklist && trip ? ClipboardCheck : trip ? Map : Truck) : ClipboardCheck
  const centerLabel = isDriver ? (pending.checklist && trip ? 'Checklist' : trip ? 'Ruta' : 'Viajes') : 'Tareo'
  const items = [
    { href: '/app', label: 'Inicio', icon: Home },
    { href: '/app/actividades', label: 'Actividades', icon: History },
    { href: centerHref, label: centerLabel, icon: CenterIcon, center: true },
    { href: '/app/alertas', label: 'Alertas', icon: Bell },
    { href: '/app/perfil', label: 'Perfil', icon: User },
  ]

  return <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
    <ul className="mx-auto grid h-[68px] max-w-lg grid-cols-5 items-end px-1 pb-1">
      {items.map(item => {
        const active = path === item.href || (item.href !== '/app' && path.startsWith(item.href))
        const Icon = item.icon
        return <li key={`${item.label}-${item.href}`} className="flex justify-center">
          <Link href={item.href} className={`flex min-w-14 flex-col items-center gap-0.5 text-[10px] font-semibold ${active ? 'text-[#002855]' : 'text-slate-500'}`}>
            <span className={item.center ? '-mt-5 rounded-full border-4 border-slate-50 bg-[#f8c400] p-3 text-[#002855] shadow-lg' : 'rounded-lg p-1.5'}>
              <Icon className={item.center ? 'h-6 w-6' : 'h-5 w-5'} />
            </span>
            <span>{item.label}</span>
          </Link>
        </li>
      })}
    </ul>
  </nav>
}
