import { getActiveSession } from '@/lib/server/active-session'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const session = await getActiveSession()
  if (!session) return NextResponse.json({ error: 'Sesión no autorizada' }, { status: 401 })
  if (!["clientes", "ot", "solicitudes"].some(module => session.canRead(module))) return NextResponse.json({ error: 'Sin permiso para esta consulta' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const ruc = searchParams.get('ruc')

  if (!ruc || !/^\d{11}$/.test(ruc)) {
    return NextResponse.json({ error: 'RUC inválido' }, { status: 400 })
  }

  try {
    const response = await fetch(`https://api.apis.net.pe/v1/ruc?numero=${ruc}`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: 'RUC no encontrado o error en el servicio de SUNAT' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error fetching RUC:', error)
    return NextResponse.json({ error: 'Error interno del servidor al consultar SUNAT' }, { status: 500 })
  }
}
