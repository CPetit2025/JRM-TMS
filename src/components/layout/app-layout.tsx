"use client"
import { Sidebar } from '@/components/layout/sidebar'
import { User, Menu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NotificationBanner } from './NotificationBanner'
import { NotificationBell } from './NotificationBell'
import { usePathname } from 'next/navigation'
import { AppUpdateNotice } from '@/components/AppUpdateNotice'
import { JrmAiAssistant } from '@/components/JrmAiAssistant'
import { NAV_SECTIONS, activeEntry, flatEntries } from '@/lib/nav/navConfig'
import { setSidebar, useSidebar } from '@/lib/nav/sidebarStore'

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState('operador')
  const [email, setEmail] = useState('')
  const pathname = usePathname()

  const sidebar = useSidebar()

  const getPageTitle = (path: string) => {
    // Título desde el menú: nombre de la pantalla y su sección (Almacén APT › Kardex)
    const nav = path && path !== '/' ? activeEntry(flatEntries(NAV_SECTIONS), path) : null
    if (nav?.section) return { title: nav.item.label, subtitle: `${nav.section.title}${nav.group ? ` › ${nav.group}` : ''}` }
    if (!path || path === '/') return { title: 'Dashboard Ejecutivo', subtitle: 'Resumen gerencial de operaciones' }
    if (path.includes('/contratos/servicios')) return { title: 'Servicios de Contrato', subtitle: 'Gestión de servicios asignados' }
    if (path.includes('/contratos')) return { title: 'Contratos y OTs', subtitle: 'Gestión de acuerdos comerciales' }
    if (path.includes('/solicitudes')) return { title: 'Solicitudes de Carga', subtitle: 'Requerimientos de transporte' }
    if (path.includes('/despacho')) return { title: 'Gestión de Despachos', subtitle: 'Asignación de unidades y planificación' }
    if (path.includes('/monitoreo')) return { title: 'Monitoreo GPS', subtitle: 'Seguimiento en campo' }
    if (path.includes('/torre-control')) return { title: 'Torre de Control JRM', subtitle: 'Vista general operativa' }
    if (path.includes('/clientes')) return { title: 'Directorio Clientes', subtitle: 'Gestión de cartera comercial' }
    
    const parts = path.split('/').filter(Boolean)
    if (parts.length > 0) {
      const mainTitle = parts[parts.length - 1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      return { title: mainTitle, subtitle: 'Módulo del Sistema' }
    }
    
    return { title: 'JRM TMS', subtitle: 'Sistema de Gestión de Transporte' }
  }

  const { title, subtitle } = getPageTitle(pathname)

  useEffect(() => {
    const storedRole = localStorage.getItem('userRole')
    if (storedRole) {
      setRole(storedRole)
    }
    
    const fetchUser = async () => {
      try {
        const { createClient } = await import('@/lib/supabase/client')
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (user && user.email) {
          setEmail(user.email)
        }
      } catch (err) {
        console.error(err)
      }
    }
    fetchUser()
  }, [])

  return (
    <div className="flex h-screen bg-slate-50">
      <JrmAiAssistant />
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-20 bg-white border-b border-slate-200 border-t-[3px] border-t-[#cf152d] flex items-center justify-between gap-3 px-4 lg:px-8 z-20 relative">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={() => setSidebar({ overlay: true })} aria-label="Mostrar menú" title="Mostrar menú (Ctrl + B)"
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-[#002855] ${sidebar.pinned ? 'lg:hidden' : ''}`}>
              <Menu className="h-5 w-5" />
            </button>
          <div className="min-w-0">
            {/* Sección del menú arriba, con la línea roja del login; la pantalla en grande */}
            <p className="flex items-center gap-2 truncate text-[11px] font-bold uppercase tracking-[0.14em] text-[#002855]">
              <span aria-hidden className="h-[3px] w-6 shrink-0 rounded bg-[#cf152d]" />{subtitle}</p>
            <h2 className="truncate text-xl font-black text-slate-900">{title}</h2>
          </div>
          </div>
          <div className="flex items-center gap-4">
            <AppUpdateNotice placement="header" />
            <NotificationBell />

            <div className="flex items-center gap-3 border-l border-slate-200 pl-4">
              <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold">
                <User className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700 capitalize">{role}</p>
                <p className="text-xs text-slate-500">{email || `${role}@jrm.com.pe`}</p>
              </div>
            </div>
          </div>
        </header>
        <div id="app-update-slot" />
        <NotificationBanner />
        <main className="relative z-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-8">
          {children}
        </main>
      </div>
    </div>
  )
}
