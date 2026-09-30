'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { Bot, Send, X, Mic, Square, Loader2, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useDriverNudges, type NudgeAction } from '@/components/ai/useDriverNudges'
import { toast } from 'sonner'
import { Capacitor } from '@capacitor/core'
import { toWav16k } from '@/lib/audio-wav'

type Context = {
  contractId?: string; vehiclePlate?: string; dispatchId?: string; status?: string; activeStep?: number
  userName?: string; driverName?: string; pending?: { checklist?: boolean; stops?: number; expenses?: number; failures?: number }
}
type Message = { from: 'user' | 'ai'; text: string }
type Site = { id: string; name: string }
type Proposal = { id: string; action_type?: string; payload: Record<string, unknown>; status?: string }
type OfficeLine = { label: string; value: string }
type SpeechResultEvent = {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}
type SpeechRecognitionLike = {
  continuous: boolean; interimResults: boolean; lang: string
  onresult: ((event: SpeechResultEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void; stop: () => void
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export function JrmAiAssistant() {
  const path = usePathname()
  const [enabled, setEnabled] = useState(false)
  const [profile, setProfile] = useState<{ name: string | null; isDriver: boolean }>({ name: null, isDriver: false })
  const router = useRouter()
  const { nudge, dismiss } = useDriverNudges(profile.isDriver && enabled)
  const [tip, setTip] = useState<string | null>(null)
  const [voiceOn, setVoiceOn] = useState(() => { try { return localStorage.getItem('jrm-ai-voice') !== 'off' } catch { return true } })
  const toggleVoice = () => setVoiceOn(on => { try { localStorage.setItem('jrm-ai-voice', on ? 'off' : 'on') } catch { /* sin almacenamiento */ } return !on })
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [inputOrigin, setInputOrigin] = useState<'ai_chat' | 'ai_voice'>('ai_chat')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Initialize SpeechRecognition if available
    if (typeof window !== 'undefined') {
      const speechWindow = window as Window & {
        SpeechRecognition?: SpeechRecognitionConstructor
        webkitSpeechRecognition?: SpeechRecognitionConstructor
      }
      const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition()
        recognitionRef.current.continuous = false
        recognitionRef.current.interimResults = true
        recognitionRef.current.lang = 'es-ES'

        recognitionRef.current.onresult = (event: SpeechResultEvent) => {
          let finalTranscript = ''

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript
            }
          }

          if (finalTranscript) {
            setQuestion(prev => (prev + ' ' + finalTranscript).trim())
            setInputOrigin('ai_voice')
          }
        }

        recognitionRef.current.onerror = (event: { error: string }) => {
          console.error('Speech recognition error', event.error)
          setListening(false)
        }

        recognitionRef.current.onend = () => {
          setListening(false)
        }
      }
    }
  }, [])

  // Dictado: el reconocimiento del navegador solo existe en Chrome de escritorio/Android; el WebView del APK no
  // lo trae. Ahí se graba con MediaRecorder y se transcribe en el servidor (/api/jrm-ai/transcribe).
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordTimer = useRef<number | null>(null)
  const [transcribing, setTranscribing] = useState(false)

  const stopRecording = () => {
    if (recordTimer.current) { window.clearTimeout(recordTimer.current); recordTimer.current = null }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
  }

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error(Capacitor.isNativePlatform() ? 'Actualiza la app de JRM para usar el micrófono.' : 'Este navegador no permite grabar audio.')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      toast.error(name === 'NotAllowedError' || name === 'SecurityError'
        ? (Capacitor.isNativePlatform() ? 'Permite el micrófono a JRM (Ajustes → Apps → JRM-TMS → Permisos) o actualiza la app.' : 'Permite el acceso al micrófono para dictar.')
        : 'No se pudo acceder al micrófono.')
      return
    }
    const chunks: Blob[] = []
    const recorder = new MediaRecorder(stream)
    recorderRef.current = recorder
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop())
      setListening(false)
      const raw = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      if (raw.size < 1500) return
      setTranscribing(true)
      try {
        let audio: Blob = raw
        try { audio = await toWav16k(raw) } catch { /* se envía el original si el navegador no lo decodifica */ }
        const body = new FormData()
        body.append('audio', audio, audio.type === 'audio/wav' ? 'voz.wav' : 'voz.webm')
        const response = await fetch('/api/jrm-ai/transcribe', { method: 'POST', body })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'No pude entender el audio.')
        const text = String(data.text || '').trim()
        if (!text) { toast.error('No se escuchó nada. Intenta de nuevo, más cerca del micrófono.'); return }
        void ask(text, 'ai_voice')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No pude entender el audio.')
      } finally { setTranscribing(false) }
    }
    recorder.start()
    setListening(true)
    recordTimer.current = window.setTimeout(stopRecording, 60_000)  // máximo 1 minuto
  }

  const toggleListen = () => {
    if (transcribing) return
    const useBrowserSpeech = recognitionRef.current && !Capacitor.isNativePlatform()
    if (listening) {
      if (useBrowserSpeech) recognitionRef.current?.stop(); else stopRecording()
      return
    }
    if (useBrowserSpeech) {
      try { recognitionRef.current?.start(); setListening(true) } catch { void startRecording() }
      return
    }
    void startRecording()
  }

  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [selected, setSelected] = useState<Context>({})
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState('')
  const [proposals, setProposals] = useState<Proposal[]>([])

  const updateProposalDescription = (id: string, description: string) => {
    setProposals(current => current.map(item => {
      if (item.id !== id) return item
      const currentData = item.payload.data && typeof item.payload.data === 'object'
        ? item.payload.data as Record<string, unknown> : {}
      return { ...item, payload: { ...item.payload, data: { ...currentData, description } } }
    }))
  }

  const currentPosition = () => new Promise<{ latitude: number; longitude: number } | null>(resolve => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(null), { enableHighAccuracy: true, timeout: 8_000, maximumAge: 15_000 },
    )
  })

  useEffect(() => {
    if (open && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [open, messages.length])

  useEffect(() => {
    // Otros módulos (p. ej. el Copiloto CMMS) pueden abrir el asistente con una pregunta precargada
    const openAssistant = (event: Event) => {
      setOpen(true)
      const q = (event as CustomEvent<{ question?: string }>).detail?.question
      if (q) setQuestion(q)
    }
    window.addEventListener('jrm:open-ai', openAssistant)
    return () => window.removeEventListener('jrm:open-ai', openAssistant)
  }, [])

  useEffect(() => {
    fetch('/api/jrm-ai', { cache: 'no-store' }).then(response => response.json())
      .then(data => {
        setEnabled(Boolean(data.enabled))
        setAvailable(Array.isArray(data.scopes) && data.scopes.length > 0)
        setSites(data.sites || [])
        setProfile({ name: typeof data.name === 'string' ? data.name : null, isDriver: Boolean(data.isDriver) })
      }).catch(() => setAvailable(false))
  }, [])

  useEffect(() => {
    const plate = path.match(/^\/mantenimiento\/flota\/([^/]+)$/)?.[1]
    setSelected(plate ? { vehiclePlate: decodeURIComponent(plate) } : {})
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<Context>).detail
      setSelected(detail || {})
    }
    window.addEventListener('jrm:context', listener)
    return () => window.removeEventListener('jrm:context', listener)
  }, [path])

  const suggestions = useMemo(() => {
    if (path.includes('/ruta') || selected.dispatchId) {
      if (selected.pending?.checklist) return ['Ayúdame con el checklist', '¿Qué ruta tengo asignada?', '¿Qué me falta antes de iniciar?']
      if (selected.status === 'EN RUTA') return ['¿Voy a tiempo para la siguiente parada?', 'Informar un retraso por tráfico', 'Notificar avería mecánica']
      return ['¿Qué ruta tengo asignada hoy?', '¿Cuántas paradas me faltan?']
    }
    if (path.includes('/contratos')) return ['Analiza este contrato', '¿Qué contratos tienen mayor riesgo?', '¿Cuánto costaría un flete de esta OT a Ate?']
    if (path.includes('/contratos/servicios')) return ['Registra un gasto de montacargas para una OT', '¿Qué gastos tiene la OT…?', 'Corrige el monto de un gasto']
    if (path.includes('/solicitudes')) return ['¿Qué solicitudes están observadas y por qué?', '¿Cuáles vencen en los próximos 3 días?', 'Reprograma una solicitud']
    if (path.includes('/caja')) return ['¿Qué gastos esperan aprobación?', '¿Qué anticipos están vencidos sin rendir?', '¿Alguna caja está bajo el mínimo?']
    if (path.includes('/maestros/tarifas')) return ['Cotiza un flete para una OT a un distrito', '¿Qué tarifas faltan para esta OT?']
    if (path.includes('/despacho/documentos')) return ['¿Qué despachos salen sin guía de remisión?', '¿Qué documentos de unidades o conductores vencen?']
    if (path.includes('/mantenimiento')) return ['¿Qué unidades están bloqueadas y por qué?', '¿Qué mantenimiento vence esta semana?', '¿Qué unidad cuesta más mantener?', '¿Cuál es la disponibilidad y el MTTR de los últimos 30 días?']
    if (path.includes('/despacho') || path.includes('/torre-control')) return ['¿Qué operaciones están retrasadas?', '¿Cuánto costaron los despachos de esta semana?', '¿Qué despachos no tienen guía cargada?']
    if (path.startsWith('/app')) return ['¿Tengo rutas asignadas?', '¿Qué tengo pendiente?', 'Quiero reportar una falla']
    return ['¿Qué debería preocuparme hoy?', 'Resume la operación de esta semana', '¿Qué solicitudes están observadas?', '¿Qué documentos vencen este mes?']
  }, [path, selected])

  // Burbuja de ayuda contextual (oficina): aparece unos segundos después de entrar a una pantalla, una vez por sesión
  useEffect(() => {
    if (!enabled || profile.isDriver || open) return
    let seenKey = ''
    try { seenKey = `jrm-ai-tip:${path}`; if (sessionStorage.getItem(seenKey)) return } catch { /* sin almacenamiento */ }
    const suggestion = suggestions[0]
    const show = window.setTimeout(() => {
      setTip(suggestion)
      try { sessionStorage.setItem(seenKey, '1') } catch { /* sin almacenamiento */ }
    }, 7000)
    const hide = window.setTimeout(() => setTip(null), 22000)
    return () => { window.clearTimeout(show); window.clearTimeout(hide) }
  }, [enabled, profile.isDriver, open, path, suggestions])

  // Aviso del conductor: vibra y lo dice en voz alta (manos libres) cuando aparece uno nuevo
  const announced = useRef('')
  useEffect(() => {
    if (!nudge || announced.current === nudge.key) return
    announced.current = nudge.key
    try { navigator.vibrate?.([200, 100, 200]) } catch { /* sin vibración */ }
    if (voiceOn && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(nudge.text)
      utterance.lang = 'es-PE'
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(utterance)
    }
  }, [nudge, voiceOn])

  const ask = async (value: string, origin: 'ai_chat' | 'ai_voice' = inputOrigin) => {
    const text = value.trim()
    if (!text || busy || !enabled) return
    const history = messages.slice(-12)
    setMessages(prev => [...prev, { from: 'user', text }])
    setQuestion('')
    setBusy(true)
    try {
      const response = await fetch('/api/jrm-ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, context: { path, ...selected, siteId: siteId || undefined, origin } }),
      })
      const data = await response.json()
      setMessages(prev => [...prev, { from: 'ai', text: response.ok ? data.answer : data.error || 'No pude completar la consulta.' }])
      if (response.ok && Array.isArray(data.proposals)) setProposals(prev => [...prev, ...data.proposals])
      setInputOrigin('ai_chat')
    } catch {
      setMessages(prev => [...prev, { from: 'ai', text: 'No hay conexión con JRM IA. Intenta de nuevo.' }])
    } finally { setBusy(false) }
  }

  const decide = async (item: Proposal, decision: 'confirm' | 'cancel') => {
    setBusy(true)
    try {
      const position = decision === 'confirm' && item.action_type === 'trip_action'
        ? await currentPosition() : null
      const response = await fetch('/api/jrm-ai/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: item.id, decision, payload: item.payload, action_type: item.action_type,
          latitude: position?.latitude, longitude: position?.longitude,
          device: { userAgent: navigator.userAgent.slice(0, 300) },
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo procesar la propuesta.')
      setProposals(prev => prev.map(proposal => proposal.id === item.id ? { ...proposal, status: decision } : proposal))
      setMessages(prev => [...prev, { from: 'ai', text: decision === 'confirm'
        ? `Listo${data.result?.status ? `: ${data.result.status}` : ', acción registrada.'}`
        : 'Propuesta cancelada; no se guardó nada.' }])
      if (decision === 'confirm') {
        window.dispatchEvent(new Event('jrm:trip-changed'))
        window.dispatchEvent(new CustomEvent('jrm:data-changed', { detail: { action: item.payload.kind || item.action_type } }))
      }
    } catch (error) {
      setMessages(prev => [...prev, { from: 'ai', text: error instanceof Error ? error.message : 'Error al procesar la propuesta.' }])
    } finally { setBusy(false) }
  }

  if (!available) return null
  const isMobile = path === '/app' || path.startsWith('/app/')
  const bubble = !open ? (nudge ? { text: nudge.text, actions: nudge.actions, key: nudge.key } : tip ? { text: tip, actions: [{ label: 'Preguntar', ask: tip }] as NudgeAction[], key: 'tip' } : null) : null
  const runAction = (action: NudgeAction, key: string) => {
    if (key === 'tip') setTip(null); else dismiss(key)
    if (action.href) { router.push(action.href); return }
    if (action.ask) { setOpen(true); void ask(action.ask) }
  }

  // En el inicio del app el botón no se muestra (ya hay una tarjeta "Copiloto IA"), salvo que haya un aviso
  if (!open && path === '/app' && !bubble) return null
  return (
    <div className={`fixed z-[80] ${isMobile ? 'bottom-[88px] right-3' : 'bottom-5 right-5'}`}>
      <style>{`
        @keyframes jrmFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
        @keyframes jrmWiggle { 0%,100% { transform: rotate(0) } 25% { transform: rotate(-12deg) } 75% { transform: rotate(12deg) } }
        @keyframes jrmPop { 0% { opacity: 0; transform: translateY(6px) scale(.96) } 100% { opacity: 1; transform: none } }
        .jrm-ai-fab { animation: jrmFloat 3.2s ease-in-out infinite }
        .jrm-ai-fab:hover svg, .jrm-ai-fab[data-alert="1"] svg { animation: jrmWiggle .6s ease-in-out 2 }
        .jrm-ai-bubble { animation: jrmPop .25s ease-out }
        @media (prefers-reduced-motion: reduce) { .jrm-ai-fab, .jrm-ai-fab svg, .jrm-ai-bubble { animation: none !important } }
      `}</style>
      {bubble && (
        <div role="status" className={`jrm-ai-bubble absolute bottom-full right-0 mb-3 w-[min(300px,calc(100vw-2rem))] rounded-2xl border p-3 text-sm shadow-xl ${nudge ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-slate-200 bg-white text-slate-800'}`}>
          <button type="button" aria-label="Descartar" onClick={() => (bubble.key === 'tip' ? setTip(null) : dismiss(bubble.key))}
            className="absolute right-1.5 top-1.5 rounded-full p-1 text-slate-400 hover:bg-black/5"><X className="h-3.5 w-3.5" /></button>
          <p className="pr-5 font-medium">{nudge ? '🚚 ' : '💡 '}{bubble.text}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {bubble.actions.map(action => <button key={action.label} type="button" onClick={() => runAction(action, bubble.key)}
              className="rounded-full bg-[#002855] px-3 py-1 text-xs font-semibold text-white hover:bg-[#003b78]">{action.label}</button>)}
          </div>
          <span className="absolute -bottom-1.5 right-5 h-3 w-3 rotate-45 border-b border-r bg-inherit" style={{ borderColor: 'inherit' }} />
        </div>
      )}
      {!open && <button type="button" onClick={() => { setOpen(true); setTip(null) }} aria-label="Abrir JRM IA" title="JRM IA · ¿En qué te ayudo?"
        data-alert={nudge ? '1' : '0'}
        className={`jrm-ai-fab relative flex items-center justify-center rounded-full bg-gradient-to-br from-[#002855] via-[#003b78] to-[#0a6cd6] text-white shadow-lg shadow-blue-900/30 ring-2 ring-white/80 transition-transform hover:scale-110 active:scale-95 ${isMobile ? 'h-12 w-12' : 'h-14 w-14'}`}>
        <span className="absolute inset-0 rounded-full bg-blue-400/40 animate-ping [animation-duration:2.6s]" aria-hidden />
        <Bot className={`relative ${isMobile ? 'h-6 w-6' : 'h-7 w-7'}`} />
        {nudge && <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-white bg-red-500" aria-label="Aviso pendiente" />}
      </button>}
      {open && (
        <>
          {/* Overlay for mobile bottom sheet */}
          {isMobile && <div className="fixed inset-0 bg-black/40 z-[90] backdrop-blur-sm" onClick={() => setOpen(false)} />}

          <section role="dialog" aria-label="Copiloto IA"
            className={isMobile
              ? "fixed bottom-0 left-0 right-0 z-[100] flex h-[85vh] w-full flex-col rounded-t-3xl border-t border-slate-200 bg-white text-slate-900 shadow-2xl transition-transform animate-in slide-in-from-bottom-full duration-300"
              : "flex h-[min(620px,calc(100vh-2.5rem))] w-[min(420px,calc(100vw-2.5rem))] flex-col rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl"
            }>

            {/* Drag Handle for Mobile */}
            {isMobile && (
              <div className="w-full flex justify-center pt-3 pb-1 bg-[#002855] rounded-t-3xl">
                <div className="w-12 h-1.5 bg-white/30 rounded-full" />
              </div>
            )}

            <header className={`flex items-center justify-between bg-[#002855] px-5 py-4 text-white shadow-sm ${!isMobile && 'rounded-t-2xl'}`}>
              <div className="flex items-center gap-3 font-black tracking-wide text-lg">
                <Bot className="h-6 w-6 text-blue-300" /> {isMobile ? 'JRM IA · Tu copiloto' : 'JRM IA'}
              </div>
              <div className="flex items-center gap-1.5">
                {profile.isDriver && <button type="button" onClick={toggleVoice} aria-label={voiceOn ? 'Silenciar avisos de voz' : 'Activar avisos de voz'} title={voiceOn ? 'Avisos por voz activados' : 'Avisos por voz desactivados'}
                  className="bg-white/10 hover:bg-white/20 p-1.5 rounded-full transition-colors">
                  {voiceOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </button>}
                {messages.length > 0 && <button type="button" aria-label="Nueva conversación" title="Nueva conversación" disabled={busy}
                  onClick={() => { setMessages([]); setProposals(current => current.filter(item => !item.status)) }}
                  className="bg-white/10 hover:bg-white/20 p-1.5 rounded-full transition-colors disabled:opacity-50">
                  <RotateCcw className="h-4 w-4" />
                </button>}
                <button type="button" aria-label="Cerrar JRM IA" onClick={() => setOpen(false)} className="bg-white/10 hover:bg-white/20 p-1.5 rounded-full transition-colors">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </header>
        <div className="bg-slate-50 border-b border-slate-200 px-5 py-2.5 text-xs text-slate-600 shadow-inner">
          <div className="flex flex-wrap gap-2 items-center">
            {selected.contractId && <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded-md font-bold">Contrato {selected.contractId.substring(0, 4)}...</span>}
            {selected.vehiclePlate && <span className="bg-orange-100 text-orange-800 px-2 py-0.5 rounded-md font-bold">Unidad {selected.vehiclePlate}</span>}
            {selected.dispatchId && <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded-md font-bold">Despacho Activo</span>}
          </div>
          {sites.length > 1 && <select aria-label="Sede" value={siteId} onChange={event => setSiteId(event.target.value)}
            className="mt-2 block w-full rounded-lg border border-slate-200 p-2 font-medium bg-white">
            <option value="">Todas mis sedes</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>}
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {!enabled && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            JRM IA está pendiente de configurar en el servidor. Solicita al administrador que configure GEMINI_API_KEY u OPENAI_API_KEY en el servidor.
          </p>}
          {enabled && messages.length === 0 && <>
            <div className="rounded-xl bg-blue-50 p-3 text-sm text-slate-700 shadow-sm border border-blue-100">
              <p className="font-bold text-[#002855]">Hola{(selected.userName || selected.driverName || profile.name) ? `, ${selected.userName || selected.driverName || profile.name}` : ''}. 👋</p>
              <p className="mt-1">{profile.isDriver
                ? 'Soy tu copiloto de viaje. Puedo consultar tu ruta y tus pendientes, y preparar reportes de retraso, incidencias, fallas o gastos para que solo los confirmes.'
                : 'Soy JRM IA. Consulto en tiempo real solicitudes, tarifas, despachos, documentos, caja, flota y mantenimiento según tus permisos. Pregúntame con tus palabras; recuerdo lo que conversamos.'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map(text => <button type="button" key={text} onClick={() => void ask(text)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-left text-xs hover:bg-slate-50">{text}</button>)}
            </div>
          </>}
          {messages.map((item, index) => <div key={index}
            className={`whitespace-pre-wrap rounded-xl p-3 text-sm ${item.from === 'user' ? 'ml-8 bg-blue-50' : 'mr-5 bg-slate-100'}`}>
            {item.text}
          </div>)}
          {proposals.map(item => {
            const data = item.payload.data && typeof item.payload.data === 'object' ? item.payload.data as Record<string, unknown> : item.payload
            const action = String(item.payload.action || item.action_type || 'ACCIÓN').replaceAll('_', ' ')
            if (item.action_type === 'office_action') {
              const lines = (Array.isArray(item.payload.lines) ? item.payload.lines : []) as OfficeLine[]
              return <div key={item.id} className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
                <p className="font-bold">{String(item.payload.title || 'Acción por confirmar')}</p>
                <dl className="mt-1.5 space-y-0.5">
                  {lines.map(line => <div key={line.label} className="flex gap-2"><dt className="w-28 shrink-0 text-slate-500">{line.label}</dt><dd className="font-medium text-slate-800">{line.value}</dd></div>)}
                </dl>
                {item.status ? <p className="mt-2 font-semibold">{item.status === 'confirm' ? 'Confirmado' : 'Cancelado'}</p> :
                  <div className="mt-3 flex gap-2">
                    <button type="button" disabled={busy} onClick={() => void decide(item, 'confirm')}
                      className="rounded bg-[#002855] px-3 py-2 text-white disabled:opacity-50">Confirmar y guardar</button>
                    <button type="button" disabled={busy} onClick={() => void decide(item, 'cancel')}
                      className="rounded border border-slate-300 px-3 py-2 disabled:opacity-50">Cancelar</button>
                  </div>}
              </div>
            }
            return <div key={item.id} className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-bold">Acción por confirmar</p>
            <p className="mt-1">Tipo: {action}</p>
            {item.payload.vehicle_plate ? <p>Unidad: {String(item.payload.vehicle_plate)}</p> : null}
            {item.payload.type ? <p>Mantenimiento: {String(item.payload.type)}</p> : null}
            {item.payload.reason ? <p>Motivo: {String(item.payload.reason)}</p> : null}
            {item.action_type === 'trip_action' && !item.status ? <label className="mt-2 block text-xs font-semibold text-slate-700">
              Detalle editable
              <textarea value={String(data.description || '')}
                onChange={event => updateProposalDescription(item.id, event.target.value.slice(0, 600))}
                className="mt-1 min-h-16 w-full rounded-lg border border-amber-300 bg-white p-2 text-sm font-normal" />
            </label> : data.description ? <p>Detalle: {String(data.description)}</p> : null}
            {data.amount ? <p>Monto: S/ {String(data.amount)}</p> : null}
            {data.severity ? <p>Severidad: {String(data.severity)}</p> : null}
            {item.payload.scheduled_date ? <p>Fecha: {String(item.payload.scheduled_date)}</p> : null}
            {item.status ? <p className="mt-2 font-semibold">{item.status === 'confirm' ? 'Confirmado' : 'Cancelado'}</p> :
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void decide(item, 'confirm')}
                  className="rounded bg-[#002855] px-3 py-2 text-white disabled:opacity-50">Confirmar</button>
                <button type="button" disabled={busy} onClick={() => void decide(item, 'cancel')}
                  className="rounded border border-slate-300 px-3 py-2 disabled:opacity-50">Cancelar</button>
              </div>}
          </div>})}
          {busy && <p className="text-sm text-slate-500">Consultando datos autorizados...</p>}
          <div ref={bottomRef} />
        </div>
        <form onSubmit={event => { event.preventDefault(); void ask(question) }} className="flex gap-2 border-t border-slate-100 p-4 bg-white rounded-b-3xl">
          <button
            type="button"
            onClick={toggleListen}
            disabled={!enabled || busy || transcribing}
            className={`rounded-full p-2.5 transition-colors disabled:opacity-50 ${listening ? 'bg-red-600 text-white animate-pulse' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            aria-label={listening ? 'Terminar y enviar el mensaje de voz' : 'Grabar mensaje de voz'}
          >
            {transcribing ? <Loader2 className="h-5 w-5 animate-spin" /> : listening ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <input type="text" value={question} onChange={event => setQuestion(event.target.value)}
            disabled={!enabled || busy} placeholder={transcribing ? "Transcribiendo tu mensaje..." : listening ? "Grabando… toca ■ para enviar" : "Escríbeme o toca el micrófono"}
            className="flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm focus:border-[#002855] focus:outline-none focus:ring-1 focus:ring-[#002855]" />
          <button type="submit" disabled={!enabled || busy || !question.trim()} aria-label="Enviar pregunta"
            className="rounded-full bg-[#002855] p-2.5 text-white shadow-md disabled:opacity-50 hover:bg-[#003b78] transition-colors">
            <Send className="h-5 w-5" />
          </button>
        </form>
      </section>
      </>)}
    </div>
  )
}
