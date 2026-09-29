import { GoogleGenerativeAI } from '@google/generative-ai'
import { NextResponse } from 'next/server'
import { getAiIdentity, reserveAiRequest } from '@/lib/ai/auth'

// Dictado por voz del Copiloto: el app graba el audio (el WebView de Android no trae reconocimiento de voz),
// lo envía aquí y recibe el texto. Gemini (el mismo modelo del Copiloto) o, si solo hay clave de OpenAI, su transcripción.

export const runtime = 'nodejs'
const MAX_BYTES = 8 * 1024 * 1024
const PROMPT = 'Transcribe literalmente lo que dice la persona en este audio, en español. Devuelve solo el texto transcrito, sin comillas ni comentarios. Si no se entiende nada, devuelve una cadena vacía.'

export async function POST(request: Request) {
  const identity = await getAiIdentity()
  if (!identity) return NextResponse.json({ error: 'Inicia sesión para usar el dictado.' }, { status: 401 })
  let form: FormData
  try { form = await request.formData() } catch { return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 }) }
  const audio = form.get('audio')
  if (!(audio instanceof Blob) || audio.size === 0) return NextResponse.json({ error: 'No se recibió audio.' }, { status: 400 })
  if (audio.size > MAX_BYTES) return NextResponse.json({ error: 'El audio es muy largo: máximo 1 minuto.' }, { status: 413 })
  const mimeType = (audio.type || 'audio/wav').split(';')[0]
  if (!mimeType.startsWith('audio/')) return NextResponse.json({ error: 'Formato de audio no válido.' }, { status: 400 })
  if (!await reserveAiRequest(identity.supabase, 'copilot')) {
    return NextResponse.json({ error: 'Límite de consultas IA alcanzado. Intenta más tarde.' }, { status: 429 })
  }

  try {
    let text = ''
    if (process.env.GEMINI_API_KEY) {
      const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: process.env.GEMINI_AI_MODEL || 'gemini-2.5-flash' })
      const data = Buffer.from(await audio.arrayBuffer()).toString('base64')
      const result = await model.generateContent([{ inlineData: { mimeType, data } }, { text: PROMPT }])
      text = result.response.text()
    } else if (process.env.OPENAI_API_KEY) {
      const body = new FormData()
      body.append('file', audio, `voz.${mimeType.split('/')[1] || 'wav'}`)
      body.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe')
      body.append('language', 'es')
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body,
      })
      if (!response.ok) throw new Error(`OpenAI ${response.status}`)
      text = String((await response.json()).text || '')
    } else {
      return NextResponse.json({ error: 'JRM IA no está configurada en el servidor.' }, { status: 503 })
    }
    return NextResponse.json({ text: text.trim().replace(/^["“]|["”]$/g, '').slice(0, 1200) })
  } catch (error) {
    console.error('Transcripción JRM IA:', error)
    return NextResponse.json({ error: 'No pude entender el audio. Intenta de nuevo o escribe tu mensaje.' }, { status: 502 })
  }
}
