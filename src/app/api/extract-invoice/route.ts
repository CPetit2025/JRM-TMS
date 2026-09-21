import { NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
import { getAiIdentity, reserveAiRequest } from '@/lib/ai/auth'
import { writeAiAudit } from '@/lib/ai/audit'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const identity = await getAiIdentity()
  if (!identity) return NextResponse.json({ error: 'Sesión no autorizada.' }, { status: 401 })

  const staffAllowed = ['caja-gastos', 'mantenimiento-ot', 'caja-liquidaciones']
    .some(module => identity.canRead(module))
  let driverAllowed = false
  if (identity.employeeType === 'CONDUCTOR') {
    const { data: driver } = await identity.supabase.from('drivers')
      .select('id').eq('profile_id', identity.userId).eq('is_active', true).maybeSingle()
    driverAllowed = Boolean(driver)
  }
  if (!staffAllowed && !driverAllowed) {
    return NextResponse.json({ error: 'Sin permiso para analizar comprobantes.' }, { status: 403 })
  }

  const provider = process.env.AI_PROVIDER === 'gemini' ? 'gemini' : 'openai'
  const apiKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY
  if (!apiKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'El servicio IA no está configurado.' }, { status: 503 })

  const modelName = provider === 'gemini' ? (process.env.GEMINI_OCR_MODEL || 'gemini-1.5-flash')
    : (process.env.OPENAI_OCR_MODEL || 'gpt-4o')
  let reserved = false
  let recorded = false
  let inputTokens = 0
  let outputTokens = 0

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5_000_000) {
      return NextResponse.json({ error: 'Envía una imagen JPG, PNG o WebP de hasta 5 MB.' }, { status: 400 })
    }
    if (!await reserveAiRequest(identity.supabase, 'ocr')) {
      return NextResponse.json({ error: 'Límite de consultas IA alcanzado. Intenta más tarde.' }, { status: 429 })
    }
    reserved = true

    const image = Buffer.from(await file.arrayBuffer()).toString('base64')
    const prompt = 'Extrae de este comprobante un JSON con supplier_name, supplier_ruc, document_type, document_number, amount (número) y description. No incluyas texto adicional.'
    let content: string
    if (provider === 'gemini') {
      const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName })
      const result = await model.generateContent([prompt, { inlineData: { data: image, mimeType: file.type } }])
      content = result.response.text()
    } else {
      const result = await new OpenAI({ apiKey }).chat.completions.create({
        model: modelName,
        response_format: { type: 'json_object' },
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${file.type};base64,${image}` } },
        ] }],
      })
      content = result.choices[0]?.message.content || '{}'
      inputTokens = result.usage?.prompt_tokens || 0
      outputTokens = result.usage?.completion_tokens || 0
    }
    const parsed = JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim())
    await writeAiAudit({ user_id: identity.userId, scope: 'ocr', model: modelName,
      input_tokens: inputTokens, output_tokens: outputTokens, status: 'completed' })
    recorded = true
    return NextResponse.json(parsed, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Error en extracción IA:', error)
    if (reserved && !recorded) await writeAiAudit({ user_id: identity.userId, scope: 'ocr',
      model: modelName, input_tokens: inputTokens, output_tokens: outputTokens, status: 'failed' })
      .catch(auditError => console.error('No se pudo auditar OCR:', auditError))
    return NextResponse.json({ error: 'No se pudo procesar el comprobante.' }, { status: 500 })
  }
}
