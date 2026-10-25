'use client'
import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, Download, Loader2, Mail, Send, Share2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { dayLabel, programacionPdf, programacionRange, type ProgRow } from '@/lib/tracking-programacion-pdf'

// Envío de la programación de transporte: PDF con los servicios elegidos y correo con destinatario, asunto y mensaje
// listos. «Compartir» adjunta el PDF (Outlook, Correo, WhatsApp); las demás opciones abren el correo y descargan el PDF.

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export function programacionFileName(rows: ProgRow[]) {
  const { from, to } = programacionRange(rows)
  return `JRM_Programacion_${from || 'servicios'}${to && to !== from ? `_al_${to}` : ''}.pdf`
}

export async function descargarProgramacion(rows: ProgRow[]) {
  download(await programacionPdf(rows), programacionFileName(rows))
}

export function ProgramacionEnvio({ rows, onClose }: { rows: ProgRow[]; onClose: () => void }) {
  const { from, to } = programacionRange(rows)
  const periodo = from ? (from === to ? `del ${dayLabel(from)}` : `del ${dayLabel(from)} al ${dayLabel(to)}`) : ''
  const fileName = programacionFileName(rows)
  const porDia = Object.entries(rows.reduce<Record<string, number>>((acc, r) => { acc[r.day] = (acc[r.day] || 0) + 1; return acc }, {}))
    .sort(([a], [b]) => a.localeCompare(b))
  const pendientes = rows.filter(r => !r.scheduled).length
  const [to_, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState(`Programación de transporte ${periodo}`.trim())
  const [body, setBody] = useState([
    'Estimados:',
    '',
    `Compartimos la programación de transporte ${periodo} (${rows.length} servicio${rows.length === 1 ? '' : 's'}):`,
    ...porDia.map(([day, n]) => `• ${dayLabel(day)}: ${n} servicio${n === 1 ? '' : 's'}`),
    ...(pendientes ? ['', `${pendientes} servicio${pendientes === 1 ? '' : 's'} aún sin ruta asignada: se programan según la fecha de atención solicitada.`] : []),
    '',
    'Adjuntamos el detalle en PDF (solicitud, OT, cliente, origen y destino, ruta, unidad y estado).',
    '',
    'Saludos cordiales,',
  ].join('\n'))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const ensurePdf = async () => {
    if (file) return file
    setBusy(true)
    try {
      const f = new File([await programacionPdf(rows)], fileName, { type: 'application/pdf' })
      setFile(f)
      return f
    } finally { setBusy(false) }
  }
  const canShare = typeof navigator !== 'undefined' && !!navigator.canShare
  const share = async () => {
    try {
      const f = await ensurePdf()
      if (!navigator.canShare?.({ files: [f] })) { download(f, fileName); toast.info('Este equipo no permite compartir archivos: se descargó el PDF'); return }
      await navigator.share({ files: [f], title: subject, text: body })
    } catch (e) { if ((e as Error).name !== 'AbortError') toast.error((e as Error).message) }
  }
  const openMail = async (kind: 'mailto' | 'gmail' | 'outlook') => {
    try { download(await ensurePdf(), fileName) } catch (e) { return toast.error('No se pudo generar el PDF: ' + (e as Error).message) }
    const q = (k: string, v: string) => (v ? `${k}=${encodeURIComponent(v)}` : '')
    const url = kind === 'gmail'
      ? `https://mail.google.com/mail/?view=cm&fs=1&${[q('to', to_), q('cc', cc), q('su', subject), q('body', body)].filter(Boolean).join('&')}`
      : kind === 'outlook'
        ? `https://outlook.office.com/mail/deeplink/compose?${[q('to', to_), q('cc', cc), q('subject', subject), q('body', body)].filter(Boolean).join('&')}`
        : `mailto:${encodeURIComponent(to_)}?${[q('cc', cc), q('subject', subject), q('body', body)].filter(Boolean).join('&')}`
    window.open(url, '_blank')
    toast.success('Se abrió el correo y se descargó el PDF: adjúntelo antes de enviar')
  }
  const copy = async () => { await navigator.clipboard.writeText(body); toast.success('Mensaje copiado') }

  const field = 'w-full rounded-lg border px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title="Enviar programación por correo" maxWidth="max-w-2xl">
      <div className="max-h-[78vh] space-y-3 overflow-y-auto pr-1 text-sm">
        <div className="grid gap-3 md:grid-cols-2">
          <label>Para<input className={field} value={to_} onChange={e => setTo(e.target.value)} placeholder="correo@cliente.com, otro@empresa.com" /></label>
          <label>CC<input className={field} value={cc} onChange={e => setCc(e.target.value)} placeholder="separe con comas" /></label>
        </div>
        <label className="block">Asunto<input className={field} value={subject} onChange={e => setSubject(e.target.value)} /></label>
        <label className="block">Mensaje<textarea className={`${field} text-xs`} rows={12} value={body} onChange={e => setBody(e.target.value)} /></label>
        <div className="rounded-lg border bg-slate-50 p-3">
          <div className="flex flex-wrap gap-2">
            {canShare && <button type="button" onClick={share} className="flex items-center gap-2 rounded-lg bg-[#002855] px-3 py-2 text-white"><Share2 className="h-4 w-4" />Compartir PDF (adjunto)</button>}
            <button type="button" onClick={() => openMail('outlook')} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Mail className="h-4 w-4" />Outlook web</button>
            <button type="button" onClick={() => openMail('gmail')} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Mail className="h-4 w-4" />Gmail</button>
            <button type="button" onClick={() => openMail('mailto')} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Send className="h-4 w-4" />Programa de correo</button>
            <button type="button" onClick={async () => download(await ensurePdf(), fileName)} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Download className="h-4 w-4" />Solo PDF</button>
            <button type="button" onClick={copy} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Copy className="h-4 w-4" />Copiar mensaje</button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {canShare ? '«Compartir» abre Outlook, Correo o WhatsApp con el PDF ya adjunto. ' : ''}
            {canShare ? 'Las otras opciones' : 'Estas opciones'} abren el correo con destinatario, asunto y mensaje listos y descargan el PDF <b>{fileName}</b> para adjuntarlo.
            {busy && <span className="ml-1 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />generando PDF…</span>}
            {file && !busy && <span className="ml-1 text-emerald-700">PDF listo.</span>}
          </p>
        </div>
      </div>
    </Modal>
  )
}
