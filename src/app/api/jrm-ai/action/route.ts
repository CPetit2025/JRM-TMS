import { NextResponse } from 'next/server'
import { getAiIdentity } from '@/lib/ai/auth'

export async function POST(request: Request) {
  const identity = await getAiIdentity()
  if (!identity) return NextResponse.json({ error: 'Sesión no autorizada.' }, { status: 401 })
  let body: {
    id?: string; decision?: string; payload?: Record<string, unknown>
    latitude?: number; longitude?: number; device?: Record<string, unknown>
  }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 }) }
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id) || !['confirm', 'cancel'].includes(body.decision || '')) {
    return NextResponse.json({ error: 'Propuesta o decisión inválida.' }, { status: 400 })
  }
  if ((body.latitude != null && (!Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90)) ||
      (body.longitude != null && (!Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180))) {
    return NextResponse.json({ error: 'Ubicación inválida.' }, { status: 400 })
  }
  let result: { data: unknown; error: { message: string } | null }
  if (body.decision === 'confirm') {
    const { data: proposal, error: proposalError } = await identity.supabase.from('ai_action_proposals')
      .select('action_type').eq('id', body.id).eq('user_id', identity.userId).single()
    if (proposalError) return NextResponse.json({ error: 'Propuesta no encontrada.' }, { status: 404 })
    if (proposal?.action_type === 'trip_action') {
       result = await identity.supabase.rpc('ai_confirm_trip_action', {
         p_proposal_id: body.id,
         p_confirmed_payload: body.payload || null,
         p_lat: body.latitude ?? null,
         p_lon: body.longitude ?? null,
         p_device: body.device || {},
       })
    } else {
       result = await identity.supabase.rpc('ai_confirm_maintenance', { p_proposal_id: body.id })
    }
  } else {
    result = await identity.supabase.rpc('ai_cancel_action_proposal', { p_proposal_id: body.id })
  }
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 403 })
  return NextResponse.json({ result: result.data }, { headers: { 'Cache-Control': 'no-store' } })
}
