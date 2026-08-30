import { NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File
    const provider = request.headers.get('x-ai-provider')
    const apiKey = request.headers.get('x-ai-key')

    if (!file) {
      return NextResponse.json({ error: 'No se envió ninguna imagen.' }, { status: 400 })
    }

    if (!apiKey) {
      return NextResponse.json({ error: 'No se configuró una API Key en la plataforma.' }, { status: 401 })
    }

    const imageBuffer = Buffer.from(await file.arrayBuffer())
    const base64Image = imageBuffer.toString('base64')
    const mimeType = file.type || 'image/jpeg'

    const prompt = `Extrae la siguiente información de esta factura o boleta de gastos:
1. Razón Social del Proveedor (supplier_name)
2. RUC del Proveedor (supplier_ruc)
3. Tipo de Documento (document_type: FACTURA, BOLETA, TICKET o NOTA)
4. Número de Documento (document_number)
5. Monto Total (amount)
6. Descripción breve del gasto (description)

Devuelve ÚNICAMENTE un objeto JSON válido con las claves: "supplier_name", "supplier_ruc", "document_type", "document_number", "amount" (como número), y "description". No incluyas markdown ni explicaciones adicionales.`

    let extractedData = null

    if (provider === 'gemini') {
      const genAI = new GoogleGenerativeAI(apiKey)
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: base64Image,
            mimeType
          }
        }
      ])
      let text = result.response.text()
      text = text.replace(/```json/g, '').replace(/```/g, '').trim()
      extractedData = JSON.parse(text)
    } else {
      const openai = new OpenAI({ apiKey })
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ]
      })
      let text = response.choices[0].message.content || '{}'
      text = text.replace(/```json/g, '').replace(/```/g, '').trim()
      extractedData = JSON.parse(text)
    }

    return NextResponse.json(extractedData)

  } catch (error: any) {
    console.error('Error en extracción IA:', error)
    return NextResponse.json({ error: error.message || 'Error procesando el comprobante.' }, { status: 500 })
  }
}
