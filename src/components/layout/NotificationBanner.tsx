"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, Info, X } from 'lucide-react'

export function NotificationBanner() {
  const supabase = createClient()
  const [alerts, setAlerts] = useState<{ id: string, message: string, type: 'warning' | 'error' | 'info' }[]>([])
  const [isVisible, setIsVisible] = useState(true)

  useEffect(() => {
    fetchAlerts()
    
    // Optional: set up realtime if you want it to refresh automatically, 
    // but for now a fetch on mount and interval is safer for complex queries.
    const interval = setInterval(fetchAlerts, 60000) // refresh every 1 min
    return () => clearInterval(interval)
  }, [])

  const fetchAlerts = async () => {
    try {
      const newAlerts: any[] = []
      const today = new Date()
      const thirtyDaysFromNow = new Date()
      thirtyDaysFromNow.setDate(today.getDate() + 30)

      // 1. Fetch Failures
      const { data: failures } = await supabase
        .from('vehicle_failures')
        .select('id, vehicle_plate, description')
        .eq('status', 'ABIERTO')
      
      failures?.forEach(f => {
        newAlerts.push({
          id: `f-${f.id}`,
          message: `Falla Abierta: Unidad ${f.vehicle_plate} - ${f.description.substring(0, 50)}...`,
          type: 'error'
        })
      })

      // 2. Fetch Expiring Vehicles
      const { data: vehicles } = await supabase
        .from('vehicles')
        .select('plate, soat_expiration, technical_review_expiration')
        .neq('status', 'INACTIVO')

      vehicles?.forEach(v => {
        if (v.soat_expiration) {
          const soatDate = new Date(v.soat_expiration)
          if (soatDate < today) newAlerts.push({ id: `v-soat-${v.plate}`, message: `SOAT Vencido: Unidad ${v.plate}`, type: 'error' })
          else if (soatDate <= thirtyDaysFromNow) newAlerts.push({ id: `v-soat-${v.plate}`, message: `SOAT por vencer (${soatDate.toLocaleDateString()}): Unidad ${v.plate}`, type: 'warning' })
        }
        if (v.technical_review_expiration) {
          const rtDate = new Date(v.technical_review_expiration)
          if (rtDate < today) newAlerts.push({ id: `v-rt-${v.plate}`, message: `Rev. Técnica Vencida: Unidad ${v.plate}`, type: 'error' })
          else if (rtDate <= thirtyDaysFromNow) newAlerts.push({ id: `v-rt-${v.plate}`, message: `Rev. Técnica por vencer (${rtDate.toLocaleDateString()}): Unidad ${v.plate}`, type: 'warning' })
        }
      })

      // 3. Fetch Expiring Driver Licenses
      const { data: drivers } = await supabase
        .from('drivers')
        .select('id, first_name, last_name, license_expiration')
        .eq('is_active', true)
        
      drivers?.forEach(d => {
        if (d.license_expiration) {
          const licDate = new Date(d.license_expiration)
          const name = `${d.first_name} ${d.last_name}`
          if (licDate < today) newAlerts.push({ id: `d-lic-${d.id}`, message: `Licencia Vencida: Conductor ${name}`, type: 'error' })
          else if (licDate <= thirtyDaysFromNow) newAlerts.push({ id: `d-lic-${d.id}`, message: `Licencia por vencer (${licDate.toLocaleDateString()}): Conductor ${name}`, type: 'warning' })
        }
      })

      // Limit to 3 most critical to avoid flooding UI
      setAlerts(newAlerts.sort((a, b) => a.type === 'error' ? -1 : 1).slice(0, 3))
    } catch (e) {
      console.error(e)
    }
  }

  if (alerts.length === 0 || !isVisible) return null

  return (
    <div className="bg-amber-100 border-b border-amber-200 w-full z-10 px-6 py-2 flex flex-col sm:flex-row gap-2 justify-between items-start sm:items-center shadow-sm">
      <div className="flex flex-col gap-1 w-full max-w-5xl">
        {alerts.map(a => (
          <div key={a.id} className="flex items-center gap-2 text-sm font-medium">
            {a.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            ) : (
              <Info className="w-4 h-4 text-amber-600 shrink-0" />
            )}
            <span className={a.type === 'error' ? 'text-red-800' : 'text-amber-800'}>
              {a.message}
            </span>
          </div>
        ))}
      </div>
      <button 
        onClick={() => setIsVisible(false)}
        className="p-1 hover:bg-amber-200 rounded-full transition-colors shrink-0 text-amber-700"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
