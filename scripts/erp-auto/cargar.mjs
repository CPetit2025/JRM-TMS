// Robot de carga del ERP: entra al TMS con un usuario, abre /apt/datos, selecciona los dos Excel y pulsa «Aplicar carga y
// recalcular», igual que una persona (se reusan la lectura, las validaciones y todos los pasos de la pantalla).
// Uso: node cargar.mjs [--revisar] <Actualizable.xlsm> <StockBodega.xlsm>
//   Variables: TMS_URL (por defecto https://jrm-tms.vercel.app), TMS_USUARIO, TMS_CLAVE.
//   --revisar: lee los archivos en la pantalla y se detiene antes de aplicar (prueba sin cambiar datos).
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const revisar = args.includes('--revisar')
const archivos = args.filter(a => a !== '--revisar').map(a => resolve(a))
const url = (process.env.TMS_URL || 'https://jrm-tms.vercel.app').replace(/\/$/, '')
const { TMS_USUARIO: usuario, TMS_CLAVE: clave } = process.env
if (archivos.length !== 2 || !usuario || !clave) {
  console.error('Uso: node cargar.mjs [--revisar] <Actualizable> <StockBodega> (con TMS_USUARIO y TMS_CLAVE)')
  process.exit(2)
}

const MIN = 60_000
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
try {
  await page.goto(`${url}/login`)
  await page.locator('#login-username').fill(usuario)
  await page.locator('#login-password').fill(clave)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: MIN }).catch(async () => {
    const avisos = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])
    throw new Error(`No se pudo iniciar sesión: ${avisos.join(' · ') || 'sin respuesta'}`)
  })

  await page.goto(`${url}/apt/datos`)
  const input = page.locator('input[type=file]')
  await input.waitFor({ state: 'attached', timeout: 2 * MIN }).catch(() => {
    throw new Error('La pantalla /apt/datos no muestra la carga: el usuario no tiene permiso de carga del ERP')
  })
  const card = input.locator('xpath=../..')
  const error = card.locator('[role=alert]')
  const boton = card.getByRole('button', { name: /Aplicar carga y recalcular/ })

  await input.setInputFiles(archivos)
  await boton.or(error).first().waitFor({ timeout: 10 * MIN })
  if (await error.isVisible()) throw new Error(`Lectura: ${await error.innerText()}`)
  const filas = await card.locator('tr', { hasText: 'ERP' }).allInnerTexts()
  if (filas.length !== 2) throw new Error(`Se esperaban los dos archivos del ERP y la pantalla reconoció ${filas.length}`)
  console.log(filas.map(f => `Leído: ${f.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n'))
  if (revisar) { console.log('Revisión OK (no se aplicó nada)'); process.exit(0) }

  await boton.click()
  // Termina con el mensaje verde (p.bg-emerald-50) o con el aviso de error; el Actualizable completo tarda varios minutos
  const listo = card.locator('p.bg-emerald-50')
  await listo.or(error).first().waitFor({ timeout: 45 * MIN })
  if (await error.isVisible()) throw new Error(`Carga: ${await error.innerText()}`)
  console.log(`OK ${await listo.innerText()}`)
} catch (e) {
  // En qué paso quedó la pantalla (el texto que acompaña al indicador de carga)
  const paso = await page.locator('p:has(svg.animate-spin)').first().innerText({ timeout: 2000 }).catch(() => '')
  console.error(`ERROR ${e instanceof Error ? e.message : e}${paso ? ` · último paso: ${paso}` : ''}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
