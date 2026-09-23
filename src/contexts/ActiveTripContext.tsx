'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type TripStop = {
  transport_request_id: string
  sequence_order: number | null
  status: string
  request_number: string | null
  request_type: string | null
  pickup_address: string | null
  delivery_address: string | null
  required_date: string | null
  document_number: string | null
  document_type: string | null
  leg_actual_km: number | null
  leg_gps_complete: boolean | null
}

export type ActiveTrip = {
  id: string
  dispatch_number: string
  vehicle_plate: string | null
  status: string
  scheduled_departure: string | null
  actual_distance_km: number | null
  last_lat: number | null
  last_lon: number | null
  last_gps_at: string | null
  contract: null | {
    id: string
    code: string
    status: string
    destination_address: string | null
    client: null | { id: string; name: string; phone: string | null }
  }
  stops: TripStop[]
}

export type TripSummary = {
  id: string; dispatch_number: string; vehicle_plate: string | null; status: string
  scheduled_departure: string | null; contract_code?: string | null
  destination_address?: string | null; origin?: string | null; destination?: string | null
  created_at?: string; actual_distance_km?: number | null
}

export type DriverAlert = { level: 'success' | 'info' | 'warning' | 'error'; code: string; message: string }
export type DriverPortalSummary = {
  upcoming: TripSummary[]; recent: TripSummary[]; alerts: DriverAlert[]
  stats: { completed_30d: number; open_failures: number; pending_expenses: number }
  as_of?: string
}

export type ActiveTripContextValue = {
  user: null | { id: string; first_name: string; last_name: string; phone?: string | null; employee_type: string; document_id?: string | null }
  driver: null | {
    id: string; document_number: string; first_name: string; last_name: string
    phone: string | null; license_number: string | null; license_category: string | null
    license_expiration: string | null
  }
  trip: ActiveTrip | null
  pending: { checklist?: boolean; stops?: number; expenses?: number; failures?: number }
  summary: DriverPortalSummary
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const empty: ActiveTripContextValue = {
  user: null, driver: null, trip: null, pending: {},
  summary: { upcoming: [], recent: [], alerts: [], stats: { completed_30d: 0, open_failures: 0, pending_expenses: 0 } },
  loading: true, error: null,
  refresh: async () => {},
}

const ActiveTripContext = createContext<ActiveTripContextValue>(empty)
const cacheKey = 'jrm_active_trip_context_v1'

export function ActiveTripProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), [])
  const [state, setState] = useState<Omit<ActiveTripContextValue, 'refresh'>>({ ...empty })

  const refresh = useCallback(async () => {
    const [contextResult, summaryResult] = await Promise.all([
      supabase.rpc('get_active_trip_context'), supabase.rpc('get_driver_portal_summary'),
    ])
    const { data, error } = contextResult
    if (error) {
      const { data: auth } = await supabase.auth.getUser()
      const [profileResult, driverResult] = auth.user ? await Promise.all([
        supabase.from('profiles').select('id, first_name, last_name, phone, employee_type, document_id').eq('id', auth.user.id).maybeSingle(),
        supabase.from('drivers').select('id, document_number, first_name, last_name, phone, license_number, license_category, license_expiration').eq('profile_id', auth.user.id).eq('is_active', true).maybeSingle(),
      ]) : [{ data: null }, { data: null }]
      const profile = profileResult.data
      const fallbackDriver = driverResult.data
      const summary = summaryResult.error ? empty.summary : summaryResult.data as DriverPortalSummary
      setState({ user: profile ? { ...profile, employee_type: profile.employee_type || 'CONDUCTOR' } : null,
        driver: fallbackDriver, trip: null, pending: {}, summary, loading: false,
        error: `No se pudo cargar el viaje: ${error.message}` })
      return
    }
    const next = data as Omit<ActiveTripContextValue, 'summary' | 'loading' | 'error' | 'refresh'>
    const summary = summaryResult.error ? empty.summary : summaryResult.data as DriverPortalSummary
    setState({ ...next, summary, loading: false, error: summaryResult.error?.message || null })
    localStorage.setItem(cacheKey, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('jrm:context', { detail: {
      userName: next.user?.first_name,
      driverName: next.driver?.first_name,
      pending: next.pending,
      ...(next.trip ? {
        dispatchId: next.trip.id,
        vehiclePlate: next.trip.vehicle_plate || undefined,
        contractId: next.trip.contract?.id,
        status: next.trip.status,
        scheduledDeparture: next.trip.scheduled_departure,
        stops: next.trip.stops,
      } : {}),
    } }))
  }, [supabase])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener('jrm:trip-changed', onFocus)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('jrm:trip-changed', onFocus)
    }
  }, [refresh])

  return <ActiveTripContext.Provider value={{ ...state, refresh }}>{children}</ActiveTripContext.Provider>
}

export function useActiveTrip() {
  return useContext(ActiveTripContext)
}
