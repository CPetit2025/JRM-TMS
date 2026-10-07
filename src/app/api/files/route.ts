import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
  const params = new URL(request.url).searchParams
  const bucket = params.get('bucket') || ''
  const path = params.get('path') || ''
  if (!['evidence', 'signatures'].includes(bucket) || !path || path.length > 1024 || path.startsWith('/') || path.split('/').some(segment => !segment || segment === '..' || segment === '.') || /[\\\x00-\x1f]/.test(path)) {
    return NextResponse.json({ error: 'Archivo inválido' }, { status: 400, headers })
  }
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Inicie sesión para ver el archivo' }, { status: 401, headers })
  // No service-role client: creation of the signed URL enforces the viewer's Storage policies.
  const { data, error } = await session.storage.from(bucket).createSignedUrl(path, 120)
  if (error || !data?.signedUrl) return NextResponse.json({ error: 'Sin acceso a este archivo' }, { status: 403, headers })
  return NextResponse.redirect(data.signedUrl, { status: 302, headers })
}
