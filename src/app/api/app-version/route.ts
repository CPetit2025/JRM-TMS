import { createClient } from '@/lib/supabase/server'
import { webBuildId, webVersion } from '@/lib/app-version'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const releases = await Promise.all(['web', 'android'].map(async platform => {
    const { data, error } = await supabase.from('app_versions')
      .select('id, platform, channel, version, build_number, web_build_id, release_date, release_notes, mandatory, mandatory_after, minimum_supported_version, minimum_supported_build, installer_url, artifact_sha256')
      .eq('status', 'published')
      .eq('channel', 'stable')
      .eq('platform', platform)
      .order('release_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) console.error(`No se pudo leer la versión ${platform}:`, error.message)
    return data || null
  }))
  return Response.json({ webBuildId, webVersion, web: releases[0], android: releases[1] }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
