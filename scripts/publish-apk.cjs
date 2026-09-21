const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createClient } = require('@supabase/supabase-js')
const dotenv = require('dotenv')

const root = path.resolve(__dirname, '..')
const localEnv = path.join(root, '.env.local')
if (fs.existsSync(localEnv)) {
  const local = dotenv.parse(fs.readFileSync(localEnv))
  for (const [name, value] of Object.entries(local)) {
    if (!process.env[name]) process.env[name] = value
  }
}

const version = process.env.JRM_ANDROID_VERSION_NAME || '1.0.3'
const build = Number(process.env.JRM_ANDROID_VERSION_CODE || '4')
const bucket = 'jrm-android-installers'
const name = `jrm-tms-${version}-${build}.apk`
const file = path.join(root, 'artifacts', 'android', name)
const metadataFile = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'output-metadata.json')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.')
  if (!/^\d+$/.test(String(build)) || build < 1 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error('Versión o número de build Android inválido.')
  }
  if (!fs.existsSync(file) || !fs.existsSync(metadataFile)) {
    throw new Error('Primero genera el APK release con npm run build:apk.')
  }
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
  const output = metadata.elements?.[0]
  if (metadata.applicationId !== 'com.jrm.tms' || metadata.variantName !== 'release' ||
      output?.versionCode !== build || output?.versionName !== version) {
    throw new Error('La versión real del APK no coincide con la versión a publicar.')
  }

  const apk = fs.readFileSync(file)
  if (apk.length < 100_000 || apk.length > 20 * 1024 * 1024) throw new Error('Tamaño de APK inesperado.')
  const sha256 = createHash('sha256').update(apk).digest('hex')
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: existing, error: existingError } = await client.from('app_versions')
    .select('id,version,build_number').eq('platform', 'android').eq('channel', 'stable')
    .eq('status', 'published').order('build_number', { ascending: false }).limit(1).maybeSingle()
  if (existingError) throw existingError
  if (existing && (existing.version === version || existing.build_number >= build)) {
    throw new Error('La versión o el número de build ya está publicado.')
  }

  const { data: buckets, error: bucketsError } = await client.storage.listBuckets()
  if (bucketsError) throw bucketsError
  if (!buckets.some(item => item.id === bucket)) {
    const { error: createError } = await client.storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: 20 * 1024 * 1024,
      allowedMimeTypes: ['application/vnd.android.package-archive'],
    })
    if (createError) throw createError
  }
  const objectPath = `${version}/${build}/${sha256.slice(0, 16)}/${name}`
  let uploadError
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await client.storage.from(bucket).upload(objectPath, apk, {
      contentType: 'application/vnd.android.package-archive',
      cacheControl: '31536000',
      upsert: false,
    })
    // A previous attempt may have uploaded the file before failing to register the release.
    // The public download is hashed below before this existing object is accepted.
    if (!error || String(error.statusCode) === '409') {
      uploadError = null
      break
    }
    uploadError = error
    const status = Number(error.statusCode || error.status)
    if (status >= 400 && status < 500) break
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000))
  }
  if (uploadError) throw uploadError

  const publicUrl = client.storage.from(bucket).getPublicUrl(objectPath, { download: name }).data.publicUrl
  const response = await fetch(publicUrl, { redirect: 'manual' })
  if (response.status !== 200) throw new Error(`La URL pública no devuelve 200: ${response.status}`)
  const downloadedHash = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')
  if (downloadedHash !== sha256) throw new Error('El APK descargado no coincide con el original.')

  const { error: releaseError } = await client.from('app_versions').insert({
    platform: 'android', channel: 'stable', version, build_number: build,
    release_notes: process.env.JRM_ANDROID_RELEASE_NOTES ||
      'Primera versión Android firmada de JRM-TMS. Incluye identidad JRM y actualización verificada.',
    mandatory: false, installer_url: publicUrl, artifact_sha256: sha256,
    status: 'published',
  })
  if (releaseError) throw releaseError
  console.log(`Versión Android ${version} (${build}) publicada.`)
  console.log(`Descarga: ${publicUrl}`)
  console.log(`SHA-256: ${sha256}`)
}

main().catch(error => {
  console.error(`No se publicó el APK: ${error.message}`)
  process.exitCode = 1
})
