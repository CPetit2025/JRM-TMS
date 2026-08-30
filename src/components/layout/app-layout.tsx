"use client"
import { Sidebar } from '@/components/layout/sidebar'
import { Bell, User, Check, Clock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNotifications } from '@/components/NotificationProvider'

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState('operador')
  const [showNotifications, setShowNotifications] = useState(false)
  const { notifications, unreadCount, markAllAsRead } = useNotifications()

  useEffect(() => {
    const storedRole = localStorage.getItem('userRole')
    if (storedRole) {
      setRole(storedRole)
    }
  }, [])

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-8 z-20 relative">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Torre de Control JRM</h2>
            <p className="text-sm text-slate-500">Vista general operativa</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="relative">
              <button 
                onClick={() => {
                  setShowNotifications(!showNotifications)
                  if (!showNotifications && unreadCount > 0) markAllAsRead()
                }}
                className="p-2 text-slate-400 hover:text-slate-600 transition-colors relative"
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white animate-pulse"></span>
                )}
              </button>
              
              {showNotifications && (
                <div className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 shadow-xl rounded-xl overflow-hidden flex flex-col z-50 max-h-[400px]">
                  <div className="p-3 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                    <h3 className="font-bold text-slate-800 text-sm">Notificaciones</h3>
                    <button 
                      onClick={markAllAsRead} 
                      className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" /> Marcar leídas
                    </button>
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {notifications.length === 0 ? (
                      <div className="p-6 text-center text-slate-400 text-sm">
                        No hay notificaciones recientes
                      </div>
                    ) : (
                      <ul className="divide-y divide-slate-100">
                        {notifications.map(n => (
                          <li key={n.id} className={`p-3 hover:bg-slate-50 transition-colors ${!n.read ? 'bg-blue-50/30' : ''}`}>
                            <p className="font-bold text-sm text-slate-800 mb-0.5">{n.title}</p>
                            <p className="text-xs text-slate-600 mb-2">{n.message}</p>
                            <span className="text-[10px] text-slate-400 flex items-center gap-1">
                              <Clock className="w-3 h-3" /> 
                              {n.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
            
            <div className="flex items-center gap-3 border-l border-slate-200 pl-4">
              <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold">
                <User className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700 capitalize">{role}</p>
                <p className="text-xs text-slate-500">{role}@jrm.com.pe</p>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-8 relative z-0">
          {children}
        </main>
      </div>
    </div>
  )
}
