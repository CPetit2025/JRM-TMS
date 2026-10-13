'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Truck, ShieldCheck, Loader2, CalendarDays, Route } from 'lucide-react'
import { toast } from 'sonner'
import { DeliveryTable } from '@/components/delivery/DeliveryTable'
import { TrackingCalendar } from '@/components/tracking/TrackingCalendar'
import { RouteDay } from '@/components/tracking/RouteDay'
import type { PortalRow } from '@/lib/tracking-portal'
import { limaDay, monthDays, type PortalRequest } from '@/lib/tracking-calendar'

const sessionKey = (token: string) => `jrm:tracking-access:${token}`
const invalidAccess = (message: string) => /acceso revocado|código de acceso incorrecto|PIN incorrecto|(?:enlace|acceso).*(?:vencido|expirado|inválido|no válido)|tracking link is invalid, expired, or incorrect PIN/i.test(message)
function saveAccess(token: string, pin: string | null) {
  try {
    if (pin) window.sessionStorage.setItem(sessionKey(token), pin)
    else window.sessionStorage.removeItem(sessionKey(token))
  } catch { /* Browsers may disable storage; server validation still works. */ }
}

export default function TrackingPage() {
  const { token: routeToken } = useParams()
  const token = String(routeToken || '')
  const currentToken = useRef(token)
  const authAttempt = useRef(0)
  const invalidateAuth = useCallback(() => { authAttempt.current++ }, [])
  const [restoring, setRestoring] = useState(true)
  const [restoreRetry, setRestoreRetry] = useState(false)
  const [pin, setPin] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [verifiedToken, setVerifiedToken] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [trackingData, setTrackingData] = useState<{ mode: 'permanent' | 'legacy'; planning_date?: string; rows: PortalRow[]; requests: PortalRequest[]; error?:string; limited?:boolean; label?:string|null } | null>(null)
  const [month, setMonth] = useState(() => limaDay(new Date().toISOString()).slice(0,7))
  const range = useMemo(() => { const days=monthDays(month); return {p_from:days[0],p_to:days[41]} },[month])
  const rangeRef = useRef(range)
  useEffect(() => { rangeRef.current = range }, [range])
  const [activeTab, setActiveTab] = useState<'calendar' | 'route'>('calendar')
  const [routeDay, setRouteDay] = useState(() => limaDay(new Date().toISOString()))
  const changeRouteDay = (day: string) => { setRouteDay(day); if (day < range.p_from || day > range.p_to) setMonth(day.slice(0, 7)) }
  
  const supabase = useMemo(() => createClient(), [])
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState('')
  const [version, setVersion] = useState(0)
  // Each link has its own tab-scoped credential. Never show cached operational data
  // before the server confirms the access is still valid.
  useEffect(() => {
    let cancelled = false
    currentToken.current = token
    const invalidateAttempt = () => { authAttempt.current++ }
    invalidateAttempt()
    const restore = async () => {
      await Promise.resolve()
      if (cancelled) return
      setIsAuthenticated(false); setTrackingData(null); setRefreshError('')
      setRestoring(true); setRestoreRetry(false); setPin(''); setIsLoading(false)
      let saved = ''
      try { saved = window.sessionStorage.getItem(sessionKey(token)) || '' } catch { /* Storage unavailable. */ }
      if (!/^(?:[A-Z0-9]{4}|[0-9]{8})$/.test(saved)) {
        saveAccess(token, null); setRestoring(false); return
      }
      setPin(saved)
      try {
        const { data, error } = await supabase.rpc('get_public_tracking_portal_info', { p_token: token, p_pin: saved, ...rangeRef.current })
        if (cancelled) return
        if (error || data?.error) throw new Error(data?.error || error?.message || 'No se pudo validar el acceso.')
        if (!data || (data.mode !== 'permanent' && data.mode !== 'legacy')) throw new Error('No se pudo verificar la respuesta del seguimiento.')
        setTrackingData(data); setUpdatedAt(new Date().toISOString())
        setActiveTab(data?.mode === 'permanent' ? 'calendar' : 'route')
        setVerifiedToken(token); setIsAuthenticated(true); setRestoreRetry(false); setRefreshError('')
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : ''
        if (invalidAccess(message)) { saveAccess(token, null); setPin(''); setRefreshError('El acceso cambió o ya no está disponible. Ingresa un código vigente.') }
        else { setRestoreRetry(true); setRefreshError('No se pudo verificar tu acceso. Puedes reintentar sin volver a ingresar el código.') }
      } finally { if (!cancelled) setRestoring(false) }
    }
    void restore()
    return () => { cancelled = true; invalidateAttempt() }
    // Range changes are handled by the authenticated refresh, not a new sign-in.
  }, [token, supabase, invalidateAuth])

  useEffect(() => {
    if (!isAuthenticated || verifiedToken !== token) return
    let cancelled = false
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('get_public_tracking_portal_info', { p_token: token, p_pin: pin, ...range })
        if (cancelled) return
        if (error || data?.error) throw new Error(data?.error || error?.message || 'No se pudo actualizar el seguimiento.')
        if (!data || (data.mode !== 'permanent' && data.mode !== 'legacy')) throw new Error('No se pudo verificar la respuesta del seguimiento.')
        setTrackingData(data); setUpdatedAt(new Date().toISOString()); setRefreshError('')
      } catch (err) {
        if (cancelled) return
        if (invalidAccess(err instanceof Error ? err.message : '')) {
          saveAccess(token, null); setIsAuthenticated(false); setTrackingData(null); setPin('')
          setRefreshError('El acceso cambió o ya no está disponible. Ingresa un código vigente.')
        } else setRefreshError('No se pudo actualizar el seguimiento. Conservamos la última información verificada.')
      }
    }
    void load(); const timer = window.setInterval(load, 15000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [isAuthenticated, verifiedToken, token, pin, supabase, version, range])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pin.length !== 4 && pin.length !== 8) {
      toast.error('El código tiene 4 caracteres (letras y números); los enlaces anteriores usan 8 dígitos')
      return
    }

    const attempt = ++authAttempt.current
    setIsLoading(true)
    try {
      const { data, error } = await supabase.rpc('get_public_tracking_portal_info', {
        p_token: token, p_pin: pin, ...range
      })

      if (currentToken.current !== token || attempt !== authAttempt.current) return
      if (error || data?.error) throw new Error(data?.error || error?.message || 'No se pudo validar el acceso.')
      if (!data || (data.mode !== 'permanent' && data.mode !== 'legacy')) throw new Error('No se pudo verificar la respuesta del seguimiento.')
      saveAccess(token, pin)
      setRestoreRetry(false)

      setTrackingData(data); setUpdatedAt(new Date().toISOString()); setRefreshError('')
      setActiveTab(data?.mode === 'permanent' ? 'calendar' : 'route')
      setVerifiedToken(token); setIsAuthenticated(true)
      toast.success('Acceso autorizado')
    } catch (err) {
      if (currentToken.current !== token || attempt !== authAttempt.current) return
      if (invalidAccess(err instanceof Error ? err.message : '')) { saveAccess(token, null); setRestoreRetry(false) }
      toast.error(err instanceof Error ? err.message : 'PIN incorrecto, enlace expirado o inválido.')
    } finally {
      if (currentToken.current === token && attempt === authAttempt.current) setIsLoading(false)
    }
  }

  if (restoring || (isAuthenticated && verifiedToken !== token)) return <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50" role="status"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /><p className="text-sm text-slate-600">Verificando tu acceso…</p></div>

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <div className="flex flex-col items-center justify-center mb-6">
            <img src="/logo-jrm.png" alt="JRM Logo" className="h-12 mb-4 object-contain drop-shadow-sm" />
            <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center">
              <ShieldCheck className="w-8 h-8" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center text-slate-800 mb-2">Planificación y Seguimiento de Transporte</h1>
          <p className="text-center text-slate-500 mb-8">
            Ingrese el código recibido para consultar el calendario y las operaciones autorizadas.
          </p>
          
          <form onSubmit={handleAuth} className="space-y-6">
            {refreshError && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{refreshError}</p>}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2 text-center">
                Código de Acceso
              </label>
              <input
                type="text"
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="pin-help"
                className="w-full text-center text-3xl tracking-widest p-4 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="••••"
                required
              />
              <p id="pin-help" className="mt-2 text-center text-xs text-slate-500">4 letras o números (no distingue mayúsculas). Los enlaces anteriores usan 8 dígitos.</p>
            </div>
            
            <button
              type="submit"
              disabled={isLoading || (pin.length !== 4 && pin.length !== 8)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white p-4 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : restoreRetry ? 'Reintentar acceso' : 'Ver Planificación'}
            </button>
          </form>
          
          <p className="text-center text-xs text-slate-400 mt-8">
            Acceso de consulta protegido. El administrador puede revocarlo o cambiar su código.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      {/* Header Público */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-stretch justify-between gap-3 py-3 sm:min-h-16 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <img src="/logo-jrm.png" alt="JRM" className="h-8 shrink-0 object-contain" />
              <div className="hidden h-6 w-px bg-slate-300 sm:block"></div>
              <Truck className="hidden w-5 h-5 text-blue-600 sm:block" />
              <span className="font-bold text-base leading-snug sm:text-lg text-slate-800">Planificación y Seguimiento de Transporte</span>
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-end"><button className="rounded-lg border px-3 py-2 text-xs text-slate-600" onClick={() => {authAttempt.current++;saveAccess(token, null);setIsAuthenticated(false);setPin('');setTrackingData(null);setRefreshError('');setRestoreRetry(false)}}>Salir</button><div className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium border border-blue-200">
              {trackingData?.planning_date ? new Date(`${trackingData?.planning_date}T00:00:00`).toLocaleDateString('es-PE') : trackingData?.label || 'Portal de seguimiento'}
            </div></div>
          </div>
          
          {/* Navegación de Pestañas */}
          <div className="mt-2 flex overflow-x-auto border-t border-slate-200">
            {([
              ...(trackingData?.mode === 'permanent' ? [{ key: 'calendar', label: 'Calendario', icon: CalendarDays }] : []),
              { key: 'route', label: 'Ruta del día', icon: Route },
            ] as const).map(tab => <button key={tab.key} onClick={() => setActiveTab(tab.key as 'calendar' | 'route')}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-4 text-xs font-medium transition-colors sm:px-6 sm:text-sm ${activeTab === tab.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'}`}>
              <tab.icon className="h-4 w-4" />{tab.label}
            </button>)}
          </div>
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6">
        {activeTab === 'calendar' && trackingData?.mode === 'permanent' && <div className="space-y-6">
          {trackingData.limited && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Hay más solicitudes. Consulta un período más específico o solicita un acceso acotado.</p>}
          <TrackingCalendar month={month} onMonth={setMonth} requests={trackingData.requests || []} rows={trackingData.rows || []} access={{ token: String(token), pin }} />
        </div>}
        {(activeTab === 'route' || (activeTab === 'calendar' && trackingData?.mode !== 'permanent')) && (trackingData?.mode === 'permanent'
          ? <RouteDay rows={trackingData.rows || []} day={routeDay} onDay={changeRouteDay} access={{ token: String(token), pin }} refreshedAt={updatedAt} error={refreshError} onRefresh={() => setVersion(v => v + 1)} />
          : <DeliveryTable rows={trackingData?.rows || []} error={refreshError} refreshedAt={updatedAt} onRefresh={() => setVersion(v => v + 1)} />)}

      </div>
    </div>
  )
}
