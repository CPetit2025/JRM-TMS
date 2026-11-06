// Carga el único Actualizable APT de ingresos en el portal WMS usando el flujo
// de la pantalla. --revisar valida login y lectura sin mutar la base.
// Uso: node cargar.mjs [--revisar] <entrada.xlsx>
// Variables: WMS_URL, WMS_USUARIO y WMS_CLAVE.
import { chromium } from 'playwright-core'
import { basename, resolve } from 'node:path'

const args = process.argv.slice(2)
const revisar = args.includes('--revisar')
const archivos = args.filter(arg => arg !== '--revisar').map(resolve)
const url = (process.env.WMS_URL || '').replace(/\/$/, '')
const { WMS_USUARIO: usuario, WMS_CLAVE: clave } = process.env
if (archivos.length !== 1 || !usuario || !clave || !url) {
  console.error('Uso: node cargar.mjs [--revisar] <entrada.xlsx> (con WMS_URL, WMS_USUARIO y WMS_CLAVE)')
  process.exit(2)
}
const parsedUrl = new URL(url)
if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname === 'jrm-tms.vercel.app'
    || !parsedUrl.hostname.includes('git-feature-warehouse-wms-portal') || !parsedUrl.hostname.endsWith('.vercel.app')) {
  console.error('Por seguridad, el robot solo permite el preview WMS de la rama feature/warehouse-wms-portal; no apunta a producción.')
  process.exit(2)
}

const MIN = 60_000
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
try {
  await page.goto(`${url}/almacen/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('#login-username').fill(usuario)
  await page.locator('#login-password').fill(clave)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(u => !u.pathname.endsWith('/login'), { timeout: MIN }).catch(async () => {
    const avisos = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])
    throw new Error(`No se pudo iniciar sesión WMS: ${avisos.join(' · ') || 'verifique credenciales, aprobación y permiso WMS de carga'}`)
  })

  await page.goto(`${url}/almacen/apt/datos`, { waitUntil: 'domcontentloaded' })
  const input = page.locator('input[type=file]').first()
  await input.waitFor({ state: 'attached', timeout: 2 * MIN }).catch(() => {
    throw new Error('No aparece la carga del Actualizable APT: revise acceso y permiso WMS de actualización.')
  })
  const boton = page.getByRole('button', { name: /Aplicar carga y recalcular|Reanudar carga/ })
  const panel = input.locator('xpath=ancestor::label/..')
  const alerta = panel.locator('[role=alert]')
  await input.setInputFiles(archivos[0])
  await boton.or(alerta).first().waitFor({ timeout: 10 * MIN })
  const nombre = basename(archivos[0])
  if (await alerta.isVisible()) throw new Error(`Lectura del Actualizable APT: ${await alerta.innerText()}`)
  const fila = page.locator('tr').filter({ hasText: nombre }).first()
  await fila.waitFor({ state: 'visible', timeout: MIN }).catch(() => {})
  const resumen = await fila.innerText().catch(() => '')
  if (!resumen || !/Entradas/.test(resumen) || !/Entrada ALM PT/i.test(resumen)) {
    throw new Error(`El portal no confirmó la hoja «Entrada ALM PT» de ${nombre}. Revise la vista previa; no se aplicó nada.`)
  }
  console.log(`Leído: ${resumen.replace(/\s+/g, ' ').slice(0, 240)}`)
  if (revisar) { console.log('Revisión OK: login y lectura correctos; no se aplicó la carga.'); process.exit(0) }

  await boton.click()
  const listo = page.locator('p.bg-emerald-50').filter({ hasText: /filas aplicadas|cargad|actualizad/i }).first()
  await listo.or(alerta).first().waitFor({ timeout: 45 * MIN })
  if (await alerta.isVisible()) throw new Error(`Carga WMS: ${await alerta.innerText()}`)
  console.log(`OK ${await listo.innerText()}`)
} catch (error) {
  const paso = await page.locator('p:has(svg.animate-spin)').first().innerText({ timeout: 2000 }).catch(() => '')
  console.error(`ERROR ${error instanceof Error ? error.message : error}${paso ? ` · último paso: ${paso}` : ''}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
