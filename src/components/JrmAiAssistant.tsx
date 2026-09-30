'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { Bot, Send, X, Mic, Square, Loader2, RotateCcw } from 'lucide-react'
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
    if (path.includes('/solicitudes')) return ['¿Qué solicitudes están observadas y por qué?', '¿Cuáles vencen en los próximos 3 días?', '¿Qué solicitudes esperan aprobación?']
    if (path.includes('/caja')) return ['¿Qué gastos esperan aprobación?', '¿Qué anticipos están vencidos sin rendir?', '¿Alguna caja está bajo el mínimo?']
    if (path.includes('/maestros/tarifas')) return ['Cotiza un flete para una OT a un distrito', '¿Qué tarifas faltan para esta OT?']
    if (path.includes('/despacho/documentos')) return ['¿Qué despachos salen sin guía de remisión?', '¿Qué documentos de unidades o conductores vencen?']
    if (path.includes('/mantenimiento')) return ['¿Qué unidades están bloqueadas y por qué?', '¿Qué mantenimiento vence esta semana?', '¿Qué unidad cuesta más mantener?', '¿Cuál es la disponibilidad y el MTTR de los últimos 30 días?']
    if (path.includes('/despacho') || path.includes('/torre-control')) return ['¿Qué operaciones están retrasadas?', '¿Cuánto costaron los despachos de esta semana?', '¿Qué despachos no tienen guía cargada?']
    if (path.startsWith('/app')) return ['¿Tengo rutas asignadas?', '¿Qué tengo pendiente?', 'Quiero reportar una falla']
    return ['¿Qué debería preocuparme hoy?', 'Resume la operación de esta semana', '¿Qué solicitudes están observadas?', '¿Qué documentos vencen este mes?']
  }, [path, selected])

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
          id: item.id, decision, payload: item.payload,
          latitude: position?.latitude, longitude: position?.longitude,
          device: { userAgent: navigator.userAgent.slice(0, 300) },
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo procesar la propuesta.')
      setProposals(prev => prev.map(proposal => proposal.id === item.id ? { ...proposal, status: decision } : proposal))
      setMessages(prev => [...prev, { from: 'ai', text: decision === 'confirm'
        ? `Acción confirmada y registrada${data.result?.status ? `: ${data.result.status}` : '.'}`
        : 'Propuesta cancelada.' }])
      if (decision === 'confirm') window.dispatchEvent(new Event('jrm:trip-changed'))
    } catch (error) {
      setMessages(prev => [...prev, { from: 'ai', text: error instanceof Error ? error.message : 'Error al procesar la propuesta.' }])
    } finally { setBusy(false) }
  }

  if (!available) return null
  const isMobile = path === '/app' || path.startsWith('/app/')

  // Botón flotante compacto (solo ícono). En el inicio del app no se muestra: ya hay una tarjeta "Copiloto IA".
  if (!open && path === '/app') return null
  return (
    <div className={`fixed z-[80] ${isMobile ? 'bottom-[88px] right-3' : 'bottom-5 right-5'}`}>
      {!open && <button type="button" onClick={() => setOpen(true)} aria-label="Abrir JRM IA" title="JRM IA"
        className={`flex items-center justify-center rounded-full bg-gradient-to-br from-[#002855] to-[#004b99] text-white shadow-lg ring-2 ring-white/70 transition-transform hover:scale-105 active:scale-95 ${isMobile ? 'h-11 w-11 opacity-90' : 'h-12 w-12'}`}>
        <Bot className={isMobile ? 'h-5 w-5' : 'h-6 w-6'} />
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
