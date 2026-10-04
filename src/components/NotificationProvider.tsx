"use client"
import { useCallback, useEffect, useState, createContext, useContext } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

// Notificaciones.
//   Web (role="admin" en el layout del panel): avisos dirigidos por permiso desde la base (notif_list), en tiempo real
//   (tabla notifications, filtrada por RLS) y con lectura por usuario. Ver migración 20261004120000.
//   App (conductor / operario): avisos locales de su ruta y sus anticipos, como antes.

export type NotifCategoria = 'TRANSPORTE' | 'DESPACHO' | 'CAJA' | 'MANTENIMIENTO' | 'CUMPLIMIENTO'
export type NotifItem = {
  id: number; created_at: string; evento: string; categoria: NotifCategoria; severidad: 'crit' | 'warn' | 'info'
  titulo: string; cuerpo: string | null; link: string | null; leida: boolean; para_mi: boolean
}
export type NotifFeed = { items: NotifItem[]; no_leidas: number; por_categoria: Partial<Record<NotifCategoria, number>>; silenciadas: NotifCategoria[] }
export const NOTIF_CATEGORIAS: Array<{ id: NotifCategoria; label: string }> = [
  { id: 'TRANSPORTE', label: 'Transporte' }, { id: 'DESPACHO', label: 'Despacho' }, { id: 'CAJA', label: 'Caja' },
  { id: 'MANTENIMIENTO', label: 'Mantenimiento' }, { id: 'CUMPLIMIENTO', label: 'Cumplimiento' },
]

export type AppNotification = {
  id: string
  title: string
  message: string
  time: Date
  read: boolean
}

type NotificationContextType = {
  notifications: AppNotification[]
  unreadCount: number
  markAllAsRead: () => void
  // Web: avisos por permiso
  feed: NotifFeed | null
  markRead: (ids: number[]) => Promise<void>
  setMuted: (categoria: NotifCategoria, muted: boolean) => Promise<void>
  reload: () => void
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount: 0,
  markAllAsRead: () => {},
  feed: null,
  markRead: async () => {},
  setMuted: async () => {},
  reload: () => {},
})

export const useNotifications = () => useContext(NotificationContext)

type NotificationProviderProps = {
  role: 'admin' | 'driver' | 'operario'
  children?: React.ReactNode
}

export default function NotificationProvider({ role, children }: NotificationProviderProps) {
  const [supabase] = useState(() => createClient())
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [feed, setFeed] = useState<NotifFeed | null>(null)

  const loadFeed = useCallback(async () => {
    const { data, error } = await supabase.rpc('notif_list', { p_categoria: null, p_limit: 100 })
    if (!error && data?.success) setFeed({ items: data.items ?? [], no_leidas: data.no_leidas ?? 0, por_categoria: data.por_categoria ?? {}, silenciadas: data.silenciadas ?? [] })
  }, [supabase])
  const markRead = useCallback(async (ids: number[]) => {
    await supabase.rpc('notif_mark_read', { p_ids: ids })
    await loadFeed()
  }, [supabase, loadFeed])
  const setMuted = useCallback(async (categoria: NotifCategoria, muted: boolean) => {
    await supabase.rpc('notif_set_pref', { p_categoria: categoria, p_silenciada: muted })
    await loadFeed()
  }, [supabase, loadFeed])

  const addNotification = (title: string, message: string) => {
    setNotifications(prev => [{
      id: Math.random().toString(36).substr(2, 9),
      title,
      message,
      time: new Date(),
      read: false
    }, ...prev].slice(0, 20)) // Keep last 20
  }

  const markAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
    if (role === 'admin') void supabase.rpc('notif_mark_read', { p_ids: null }).then(() => loadFeed())
  }

  useEffect(() => {
    let driverData: any = null
    if (role === 'driver') {
      const stored = localStorage.getItem('jrm_driver')
      if (stored) {
        try {
          driverData = JSON.parse(stored)
        } catch (e) {}
      }
    }

    const playNotification = (type: 'admin' | 'driver') => {
      try {
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext
        if (!AudioContext) return
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        
        osc.connect(gain)
        gain.connect(ctx.destination)
        
        if (type === 'admin') {
          osc.type = 'sine'
          osc.frequency.setValueAtTime(800, ctx.currentTime)
          osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1)
          gain.gain.setValueAtTime(0, ctx.currentTime)
          gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05)
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)
          osc.start(ctx.currentTime)
          osc.stop(ctx.currentTime + 0.5)
        } else {
          osc.type = 'square'
          osc.frequency.setValueAtTime(400, ctx.currentTime)
          osc.frequency.setValueAtTime(800, ctx.currentTime + 0.15)
          osc.frequency.setValueAtTime(400, ctx.currentTime + 0.3)
          osc.frequency.setValueAtTime(800, ctx.currentTime + 0.45)
          gain.gain.setValueAtTime(0, ctx.currentTime)
          gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.05)
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8)
          osc.start(ctx.currentTime)
          osc.stop(ctx.currentTime + 0.8)
          
          if ("vibrate" in navigator) {
            navigator.vibrate([200, 100, 200, 100, 400])
          }
        }
      } catch (e) {
        console.error('Audio API failed:', e)
      }
    }

    const channel = supabase.channel('system_notifications')

    // Web: avisos dirigidos por permiso (la base solo entrega las filas que el usuario puede ver)
    let timer: number | undefined
    let first: number | undefined
    if (role === 'admin') {
      first = window.setTimeout(() => void loadFeed(), 0)
      timer = window.setInterval(() => void loadFeed(), 60000)
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          const n = payload.new as Partial<NotifItem>
          void loadFeed()
          if (n.severidad === 'crit' || n.severidad === 'warn') {
            playNotification('admin')
            const show = n.severidad === 'crit' ? toast.error : toast.info
            show(n.titulo || 'Nuevo aviso', { description: n.cuerpo || undefined, duration: n.severidad === 'crit' ? 10000 : 6000 })
          }
        }
      )
    }

    // Conductor: respuesta de Caja a su anticipo (RLS: solo los suyos)
    if (role === 'driver') {
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'trip_advances' },
        (payload) => {
          const amount = `S/ ${Number(payload.new.amount || 0).toFixed(2)}`
          if (payload.new.status === 'ENTREGADO') {
            playNotification('driver')
            addNotification('ANTICIPO ENTREGADO', `${amount} (${payload.new.payment_method || ''})`)
            toast.success('ANTICIPO ENTREGADO', { description: `${amount} por ${payload.new.payment_method || 'caja'}`, duration: 10000 })
          } else if (payload.new.status === 'ANULADO' && payload.new.cancel_reason !== 'Retirada por el conductor') {
            addNotification('ANTICIPO NO ATENDIDO', payload.new.cancel_reason || '')
            toast.error('Solicitud de anticipo anulada', { description: payload.new.cancel_reason || '', duration: 10000 })
          }
        }
      )
    }

    if (role === 'driver' && driverData) {
      const driverFullName = `${driverData.first_name} ${driverData.last_name}`
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'dispatches', filter: `driver_name=eq.${driverFullName}` },
        (payload) => {
          playNotification('driver')
          addNotification('NUEVA RUTA ASIGNADA', `Unidad: ${payload.new.vehicle_plate}. Dirígete al Checklist.`)
          toast.success(`NUEVA RUTA ASIGNADA`, {
            description: `Unidad: ${payload.new.vehicle_plate}. Dirígete al Checklist.`,
            duration: 10000
          })
        }
      )
      
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'dispatches', filter: `driver_name=eq.${driverFullName}` },
        (payload) => {
          if (payload.new.status === 'PROGRAMADO' && payload.old.status !== 'PROGRAMADO') {
            playNotification('driver')
            addNotification('RUTA ACTUALIZADA', 'Se ha reprogramado tu ruta asignada.')
            toast.success(`RUTA ACTUALIZADA`, {
              description: `Se ha reprogramado tu ruta asignada.`,
              duration: 10000
            })
          }
        }
      )
    }

    channel.subscribe()

    return () => {
      if (timer) window.clearInterval(timer)
      if (first) window.clearTimeout(first)
      supabase.removeChannel(channel)
    }
  }, [role, supabase, loadFeed])

  const unreadCount = role === 'admin' ? (feed?.no_leidas ?? 0) : notifications.filter(n => !n.read).length

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, markAllAsRead, feed, markRead, setMuted, reload: () => void loadFeed() }}>
      {children}
    </NotificationContext.Provider>
  )
}
