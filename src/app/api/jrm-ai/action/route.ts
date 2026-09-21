import { NextResponse } from 'next/server'
import { getAiIdentity } from '@/lib/ai/auth'

export async function POST(request: Request) {
  const identity = await getAiIdentity()
  if (!identity) return NextResponse.json({ error: 'Sesión no autorizada.' }, { status: 401 })
  let body: { id?: string; decision?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 }) }
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id) || !['confirm', 'cancel'].includes(body.decision || '')) {
    return NextResponse.json({ error: 'Propuesta o decisión inválida.' }, { status: 400 })
  }
  const result = body.decision === 'confirm'
    ? await identity.supabase.rpc('ai_confirm_maintenance', { p_proposal_id: body.id })
    : await identity.supabase.rpc('ai_cancel_action_proposal', { p_proposal_id: body.id })
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 403 })
  return NextResponse.json({ result: result.data }, { headers: { 'Cache-Control': 'no-store' } })
}
