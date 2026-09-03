"use client"

import { ReactNode, useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ClipboardCheck, Map, DollarSign, LogOut, Wrench, User, PlayCircle, Clock } from 'lucide-react'
import GPSGuard from '@/components/driver/GPSGuard'
import NotificationProvider from '@/components/NotificationProvider'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function OperativeLayout({ children }: { children: ReactNode }) {
  const [userName, setUserName] = useState('Usuario')
  const [employeeType, setEmployeeType] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()
  const router = useRouter()

  useEffect(() => {
    const fetchUser = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      
      // Fallback a localStorage por ahora si no hay sesión real
      if (!session) {
        const driverData = localStorage.getItem('jrm_driver')
        if (driverData) {
          try {
            const parsed = JSON.parse(driverData)
            setUserName(`${parsed.first_name} ${parsed.last_name}`)
            setEmployeeType('CONDUCTOR') // Legacy fallback
          } catch (e) {}
        }
        setLoading(false)
        return
      }

      // Obtener perfil
      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, employee_type')
        .eq('id', session.user.id)
        .single()

      if (profile) {
        setUserName(`${profile.first_name} ${profile.last_name}`)
        setEmployeeType(profile.employee_type || 'ADMINISTRATIVO')
      }
      setLoading(false)
    }

    fetchUser()
  }, [])

  const handleLogout = async () => {
    localStorage.removeItem('jrm_driver')
    await supabase.auth.signOut()
    router.push('/app/login')
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-slate-50">Cargando...</div>

  const isDriver = employeeType === 'CONDUCTOR'
  const isOperative = employeeType === 'OPERARIO' || employeeType === 'ADMINISTRATIVO' // Por ahora para pruebas

  return (
    <GPSGuard>
      <NotificationProvider role={isDriver ? "driver" : "operario"} />
      <div className="flex flex-col min-h-screen bg-slate-50 text-slate-900 pb-16">
      {/* Top Header */}
      <header className="bg-[#002855] text-white p-4 sticky top-0 z-10 shadow-md flex justify-between items-center">
        <div>
          <Image 
            src="/jrm-logo-v2.png" 
            alt="JRM Logo" 
            width={80} 
            height={25} 
            className="object-contain mb-1"
          />
          <p className="text-[10px] text-blue-200 uppercase tracking-widest font-bold">
            Portal {employeeType || 'Operativo'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-bold">{userName}</p>
          </div>
          <button onClick={handleLogout} className="p-2 bg-white/10 rounded-full hover:bg-white/20 transition-colors">
            <LogOut className="w-5 h-5 text-white" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>

      {/* Bottom Navigation */}
      <nav className="bg-white border-t border-slate-200 fixed bottom-0 w-full z-10 safe-area-pb">
        <ul className="grid grid-cols-5 items-end px-1 pb-1 pt-2 relative min-h-[60px]">
          
          {isDriver && (
            <>
              <li className="flex justify-center col-start-1">
                <Link href="/app/checklist" className="flex flex-col items-center text-slate-500 hover:text-[#002855] focus:text-[#002855] transition-colors">
                  <ClipboardCheck className="w-6 h-6 mb-1" />
                  <span className="text-[10px] font-semibold">Checklist</span>
                </Link>
              </li>
              
              <li className="flex justify-center col-start-2">
                <Link href="/app/perfil" className="flex flex-col items-center text-slate-500 hover:text-[#002855] focus:text-[#002855] transition-colors">
                  <User className="w-6 h-6 mb-1" />
                  <span className="text-[10px] font-semibold">Perfil</span>
                </Link>
              </li>
              
              <li className="absolute left-1/2 -translate-x-1/2 -top-5 flex justify-center">
                <Link href="/app/ruta" className="flex flex-col items-center text-[#002855] drop-shadow-md hover:-translate-y-1 transition-transform">
                  <div className="bg-[#002855] text-white p-3 rounded-full shadow-lg border-4 border-slate-50">
                    <Map className="w-6 h-6" />
                  </div>
                  <span className="text-[10px] font-bold mt-1 bg-white/80 px-2 rounded-full">Ruta Activa</span>
                </Link>
              </li>

              <li className="flex justify-center col-start-4">
                <Link href="/app/gastos" className="flex flex-col items-center text-slate-500 hover:text-[#002855] focus:text-[#002855] transition-colors">
                  <DollarSign className="w-6 h-6 mb-1" />
                  <span className="text-[10px] font-semibold">Gastos</span>
                </Link>
              </li>
              
              <li className="flex justify-center col-start-5">
                <Link href="/app/fallas" className="flex flex-col items-center text-slate-500 hover:text-[#002855] focus:text-[#002855] transition-colors">
                  <Wrench className="w-6 h-6 mb-1 text-orange-500" />
                  <span className="text-[10px] font-semibold">Fallas</span>
                </Link>
              </li>
            </>
          )}

          {isOperative && !isDriver && (
            <>
              <li className="flex justify-center col-start-2">
                <Link href="/app/actividades" className="flex flex-col items-center text-slate-500 hover:text-[#002855] focus:text-[#002855] transition-colors">
                  <Clock className="w-6 h-6 mb-1" />
                  <span className="text-[10px] font-semibold">Mi Jornada</span>
                </Link>
              </li>
              
              <li className="absolute left-1/2 -translate-x-1/2 -top-5 flex justify-center">
                <Link href="/app/tareo" className="flex flex-col items-center text-[#002855] drop-shadow-md hover:-translate-y-1 transition-transform">
                  <div className="bg-[#002855] text-white p-3 rounded-full shadow-lg border-4 border-slate-50">
                    <PlayCircle className="w-6 h-6" />
                  </div>
                  <span className="text-[10px] font-bold mt-1 bg-white/80 px-2 rounded-full">Nuevo Tareo</span>
                </Link>
              </li>

              <li className="flex justify-center col-start-4">
                <Link href="/app/perfil" className="flex flex-col items-center text-slate-500 hover:text-[#002855] focus:text-[#002855] transition-colors">
                  <User className="w-6 h-6 mb-1" />
                  <span className="text-[10px] font-semibold">Perfil</span>
                </Link>
              </li>
            </>
          )}

        </ul>
      </nav>
    </div>
    </GPSGuard>
  )
}
