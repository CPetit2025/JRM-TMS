'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Camera, CheckCircle2, Loader2, MapPin, Truck } from 'lucide-react'

// Página para el chofer de un transportista tercero: sin cuenta ni app. Marca la salida y registra cada entrega con
// la foto de la guía firmada. Todo pasa por /api/tercero/[token]; el enlace vale solo para su viaje.

type Parada = { request_id: string; orden: number; solicitud: string; destino: string | null; contacto: string | null; documento: string | null
  estado: string; entregado_at: string | null; recibido_por: string | null }
type Info = { success: boolean; error?: string
  despacho?: { numero: string; estado: string; placa: string; conductor: string | null; transportista: string | null; salida_programada: string | null; salida_at: string | null }
  paradas?: Parada[] }

const hora = (d: string | null) => d ? new Date(d).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

// Las fotos del celular pesan varios MB: se reducen a 1600 px en JPG antes de enviarlas
async function comprimir(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.8))
    return blob || file
  } catch { return file }
}

export default function EntregaTerceroPage() {
  const { token } = useParams<{ token: string }>()
  const [info, setInfo] = useState<Info | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [abierta, setAbierta] = useState<string | null>(null)
  const [recibido, setRecibido] = useState('')
  const [nota, setNota] = useState('')
  const [foto, setFoto] = useState<File | null>(null)

  const [version, setVersion] = useState(0)
  const load = useCallback(() => setVersion(v => v + 1), [])
  useEffect(() => {
    let cancel = false
    fetch(`/api/tercero/${token}`, { cache: 'no-store' }).then(r => r.json())
      .then((j: Info) => { if (!cancel) setInfo(j) })
      .catch(() => { if (!cancel) setInfo({ success: false, error: 'Sin conexión. Intente de nuevo.' }) })
    return () => { cancel = true }
  }, [token, version])

  const enviar = async (key: string, body: FormData, ok: string) => {
    setBusy(key); setMsg(null)
    try {
      const r = await fetch(`/api/tercero/${token}`, { method: 'POST', body })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'No se pudo registrar')
      setMsg({ ok: true, text: ok })
      load()
      return true
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'No se pudo registrar' })
      return false
    } finally { setBusy(null) }
  }

  const salida = () => {
    const f = new FormData(); f.set('accion', 'salida')
    void enviar('salida', f, 'Salida registrada. ¡Buen viaje!')
  }

  const entregar = async (requestId: string) => {
    if (!foto) { setMsg({ ok: false, text: 'Tome la foto de la guía firmada' }); return }
    const f = new FormData()
    f.set('accion', 'entrega'); f.set('request_id', requestId); f.set('recibido_por', recibido); f.set('nota', nota)
    f.set('foto', new File([await comprimir(foto)], 'entrega.jpg', { type: 'image/jpeg' }))
    if (await enviar('entrega', f, 'Entrega registrada. Gracias.')) { setAbierta(null); setFoto(null); setRecibido(''); setNota('') }
  }

  if (!info) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-8 h-8 animate-spin text-[#002855]" /></div>

  const d = info.despacho
  const paradas = info.paradas || []
  const enRuta = d && ['EN_CURSO', 'EN RUTA'].includes(d.estado)
  const hechas = paradas.filter(p => p.estado === 'ENTREGADO').length

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="bg-[#002855] text-white px-4 py-4">
        <div className="max-w-md mx-auto flex items-center gap-3">
          <Truck className="w-7 h-7 shrink-0" />
          <div>
            <div className="text-xs opacity-80">JRM · Registro de entrega</div>
            <div className="font-bold">{d ? `Viaje ${d.numero}` : 'Enlace de entrega'}</div>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4 space-y-4">
        {!info.success || !d ? (
          <div className="bg-white rounded-xl border p-5 text-center text-slate-600">{info.error || 'El enlace no es válido.'}</div>
        ) : (
          <>
            <div className="bg-white rounded-xl border p-4 text-sm space-y-1">
              <div><span className="text-slate-500">Placa:</span> <b>{d.placa}</b></div>
              <div><span className="text-slate-500">Chofer:</span> {d.conductor || '—'}{d.transportista ? ` · ${d.transportista}` : ''}</div>
              <div><span className="text-slate-500">Salida programada:</span> {hora(d.salida_programada)}</div>
              {d.salida_at && <div><span className="text-slate-500">Salió:</span> <b>{hora(d.salida_at)}</b></div>}
              <div><span className="text-slate-500">Entregas:</span> <b>{hechas} de {paradas.length}</b></div>
            </div>

            {msg && <div className={`rounded-xl p-3 text-sm font-medium ${msg.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>{msg.text}</div>}

            {d.estado === 'PROGRAMADO' && (
              <button onClick={salida} disabled={!!busy}
                className="w-full py-4 rounded-xl bg-[#002855] text-white text-lg font-bold flex items-center justify-center gap-2 disabled:opacity-60">
                {busy === 'salida' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Truck className="w-5 h-5" />}Ya salí
              </button>
            )}

            <div className="space-y-3">
              {paradas.map(p => (
                <div key={p.request_id} className="bg-white rounded-xl border p-4">
                  <div className="flex items-start gap-2">
                    <MapPin className={`w-5 h-5 shrink-0 mt-0.5 ${p.estado === 'ENTREGADO' ? 'text-emerald-600' : 'text-red-500'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-800">Parada {p.orden}{p.documento ? ` · Guía ${p.documento}` : ''}</div>
                      <div className="text-sm text-slate-600">{p.destino || '—'}</div>
                      {p.contacto && <div className="text-xs text-slate-500">{p.contacto}</div>}
                    </div>
                  </div>
                  {p.estado === 'ENTREGADO' ? (
                    <div className="mt-2 text-sm text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" />Entregado {hora(p.entregado_at)}{p.recibido_por ? ` · ${p.recibido_por}` : ''}</div>
                  ) : enRuta && abierta !== p.request_id ? (
                    <button onClick={() => { setAbierta(p.request_id); setMsg(null) }} className="mt-3 w-full py-3 rounded-lg bg-emerald-600 text-white font-bold">Registrar entrega</button>
                  ) : enRuta ? (
                    <div className="mt-3 space-y-2">
                      <label className="block">
                        <span className="text-sm text-slate-700">Foto de la guía firmada</span>
                        <input type="file" accept="image/*" capture="environment" onChange={e => setFoto(e.target.files?.[0] || null)}
                          className="mt-1 block w-full text-sm file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-slate-100" />
                      </label>
                      <input value={recibido} onChange={e => setRecibido(e.target.value)} placeholder="¿Quién recibió?" maxLength={120} className="w-full border rounded-lg px-3 py-2.5" />
                      <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Observación (opcional)" maxLength={200} className="w-full border rounded-lg px-3 py-2.5" />
                      <div className="flex gap-2">
                        <button onClick={() => setAbierta(null)} className="flex-1 py-3 rounded-lg bg-slate-100 font-semibold">Cancelar</button>
                        <button onClick={() => void entregar(p.request_id)} disabled={!!busy} className="flex-[2] py-3 rounded-lg bg-emerald-600 text-white font-bold flex items-center justify-center gap-2 disabled:opacity-60">
                          {busy === 'entrega' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Camera className="w-5 h-5" />}Enviar entrega
                        </button>
                      </div>
                    </div>
                  ) : <div className="mt-2 text-xs text-slate-400">Marque primero la salida.</div>}
                </div>
              ))}
            </div>
            {d.estado === 'ENTREGADO' && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center text-emerald-800 font-semibold">Todas las entregas están registradas. ¡Gracias!</div>}
          </>
        )}
      </main>
    </div>
  )
}
