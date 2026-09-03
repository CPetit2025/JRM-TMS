"use client"
import { useEffect, useState, createContext, useContext } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

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
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount: 0,
  markAllAsRead: () => {}
})

export const useNotifications = () => useContext(NotificationContext)

type NotificationProviderProps = {
  role: 'admin' | 'driver' | 'operario'
  children?: React.ReactNode
}

export default function NotificationProvider({ role, children }: NotificationProviderProps) {
  const supabase = createClient()
  const [notifications, setNotifications] = useState<AppNotification[]>([])

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

    if (role === 'admin') {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'transport_requests' },
        (payload) => {
          playNotification('admin')
          addNotification(`Nueva Solicitud: ${payload.new.department}`, 'Se ha creado una nueva solicitud de transporte.')
          toast.info(`Nueva Solicitud: ${payload.new.department}`, {
            description: `Se ha creado una nueva solicitud de transporte.`
          })
        }
      )
      
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'vehicle_maintenance_records' },
        (payload) => {
          playNotification('admin')
          addNotification(`Falla en Unidad: ${payload.new.vehicle_plate}`, payload.new.description)
          toast.error(`⚠️ Falla en Unidad: ${payload.new.vehicle_plate}`, {
            description: payload.new.description,
            duration: 8000
          })
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
      supabase.removeChannel(channel)
    }
  }, [role, supabase])

  const unreadCount = notifications.filter(n => !n.read).length

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, markAllAsRead }}>
      {children}
    </NotificationContext.Provider>
  )
}
