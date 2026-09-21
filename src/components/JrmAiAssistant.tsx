'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Bot, Send, X } from 'lucide-react'

type Context = { contractId?: string; vehiclePlate?: string; dispatchId?: string }
type Message = { from: 'user' | 'ai'; text: string }
type Site = { id: string; name: string }
type Proposal = { id: string; payload: { vehicle_plate: string; type: string; reason: string; scheduled_date: string }; status?: string }

export function JrmAiAssistant() {
  const path = usePathname()
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [selected, setSelected] = useState<Context>({})
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState('')
  const [proposals, setProposals] = useState<Proposal[]>([])

  useEffect(() => {
    fetch('/api/jrm-ai', { cache: 'no-store' }).then(response => response.json())
      .then(data => {
        setEnabled(Boolean(data.enabled))
        setSites(data.sites || [])
      }).catch(() => setEnabled(false))
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
    if (path.includes('/contratos')) return ['Analiza este contrato', '¿Qué contratos tienen mayor riesgo?']
    if (path.includes('/mantenimiento')) return ['¿Qué unidades requieren atención?', 'Muéstrame las fallas pendientes']
    if (path.includes('/despacho') || path.includes('/torre-control')) return ['¿Qué operaciones están retrasadas?', '¿Cuánto costaron los despachos de esta semana?']
    return ['¿Qué debería preocuparme hoy?', 'Resume la operación de esta semana']
  }, [path])

  const ask = async (value: string) => {
    const text = value.trim()
    if (!text || busy) return
    setMessages(prev => [...prev, { from: 'user', text }])
    setQuestion('')
    setBusy(true)
    try {
      const response = await fetch('/api/jrm-ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context: { path, ...selected, siteId: siteId || undefined } }),
      })
      const data = await response.json()
      setMessages(prev => [...prev, { from: 'ai', text: response.ok ? data.answer : data.error || 'No pude completar la consulta.' }])
      if (response.ok && Array.isArray(data.proposals)) setProposals(prev => [...prev, ...data.proposals])
    } catch {
      setMessages(prev => [...prev, { from: 'ai', text: 'No hay conexión con JRM IA. Intenta de nuevo.' }])
    } finally { setBusy(false) }
  }

  const decide = async (id: string, decision: 'confirm' | 'cancel') => {
    setBusy(true)
    try {
      const response = await fetch('/api/jrm-ai/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo procesar la propuesta.')
      setProposals(prev => prev.map(item => item.id === id ? { ...item, status: decision } : item))
      setMessages(prev => [...prev, { from: 'ai', text: decision === 'confirm'
        ? `Mantenimiento registrado. Orden: ${data.result?.maintenance_order_id || 'creada'}.`
        : 'Propuesta cancelada.' }])
    } catch (error) {
      setMessages(prev => [...prev, { from: 'ai', text: error instanceof Error ? error.message : 'Error al procesar la propuesta.' }])
    } finally { setBusy(false) }
  }

  if (!enabled) return null
  return (
    <div className="fixed bottom-5 right-5 z-[80]">
      {!open && <button type="button" onClick={() => setOpen(true)} aria-label="Abrir JRM IA"
        className="flex items-center gap-2 rounded-full bg-[#002855] px-4 py-3 font-bold text-white shadow-xl hover:bg-[#003b78]">
        <Bot className="h-5 w-5" /> JRM IA
      </button>}
      {open && <section role="dialog" aria-label="JRM IA"
        className="flex h-[min(620px,calc(100vh-2.5rem))] w-[min(420px,calc(100vw-2.5rem))] flex-col rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl">
        <header className="flex items-center justify-between rounded-t-2xl bg-[#002855] px-4 py-3 text-white">
          <div className="flex items-center gap-2 font-bold"><Bot className="h-5 w-5" /> JRM IA</div>
          <button type="button" aria-label="Cerrar JRM IA" onClick={() => setOpen(false)}><X className="h-5 w-5" /></button>
        </header>
        <div className="border-b border-slate-100 px-4 py-2 text-xs text-slate-600">
          <span>Pantalla: {path}</span>
          {selected.contractId && <span className="ml-2 font-semibold">Contrato seleccionado</span>}
          {selected.vehiclePlate && <span className="ml-2 font-semibold">Unidad {selected.vehiclePlate}</span>}
          {selected.dispatchId && <span className="ml-2 font-semibold">Despacho seleccionado</span>}
          {sites.length > 1 && <select aria-label="Sede" value={siteId} onChange={event => setSiteId(event.target.value)}
            className="mt-2 block w-full rounded border border-slate-200 p-1">
            <option value="">Todas mis sedes</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>}
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {messages.length === 0 && <>
            <p className="text-sm text-slate-600">Pregunta por datos reales de la operación.</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map(text => <button type="button" key={text} onClick={() => void ask(text)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-left text-xs hover:bg-slate-50">{text}</button>)}
            </div>
          </>}
          {messages.map((item, index) => <div key={index}
            className={`whitespace-pre-wrap rounded-xl p-3 text-sm ${item.from === 'user' ? 'ml-8 bg-blue-50' : 'mr-5 bg-slate-100'}`}>
            {item.text}
          </div>)}
          {proposals.map(item => <div key={item.id} className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-bold">Mantenimiento por confirmar</p>
            <p>Unidad: {item.payload.vehicle_plate}</p>
            <p>Tipo: {item.payload.type}</p>
            <p>Motivo: {item.payload.reason}</p>
            <p>Fecha: {item.payload.scheduled_date}</p>
            {item.status ? <p className="mt-2 font-semibold">{item.status === 'confirm' ? 'Confirmado' : 'Cancelado'}</p> :
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void decide(item.id, 'confirm')}
                  className="rounded bg-[#002855] px-3 py-2 text-white disabled:opacity-50">Confirmar</button>
                <button type="button" disabled={busy} onClick={() => void decide(item.id, 'cancel')}
                  className="rounded border border-slate-300 px-3 py-2 disabled:opacity-50">Cancelar</button>
              </div>}
          </div>)}
          {busy && <p className="text-sm text-slate-500">Consultando datos autorizados...</p>}
        </div>
        <form onSubmit={event => { event.preventDefault(); void ask(question) }} className="flex gap-2 border-t border-slate-100 p-3">
          <input aria-label="Pregunta para JRM IA" value={question} onChange={event => setQuestion(event.target.value)}
            maxLength={1200} placeholder="Escribe tu pregunta..."
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button type="submit" disabled={busy || !question.trim()} aria-label="Enviar pregunta"
            className="rounded-lg bg-[#002855] p-2 text-white disabled:opacity-50"><Send className="h-5 w-5" /></button>
        </form>
      </section>}
    </div>
  )
}
