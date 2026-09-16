import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const ruc = searchParams.get('ruc')

  if (!ruc || ruc.length !== 11) {
    return NextResponse.json({ error: 'RUC inválido' }, { status: 400 })
  }

  try {
    const response = await fetch(`https://api.apis.net.pe/v1/ruc?numero=${ruc}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Error from SUNAT API:', errorText)
      return NextResponse.json(
        { error: 'RUC no encontrado o error en el servicio de SUNAT' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error: any) {
    console.error('Error fetching RUC:', error)
    return NextResponse.json({ error: 'Error interno del servidor al consultar SUNAT' }, { status: 500 })
  }
}
