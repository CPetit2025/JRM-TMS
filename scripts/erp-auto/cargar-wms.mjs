// Robot de carga del ERP en el WMS: entra al WMS con la cuenta del robot de ingresos, abre /almacen/actualizaciones, adjunta
// los dos Excel y pulsa «Aplicar carga», igual que una persona (fase 1 de docs/plan-wms-inventario-apt.md).
// Uso: node cargar-wms.mjs [--revisar] <Actualizable.xlsm> <StockBodega.xlsm>
//   Variables: WMS_URL (por defecto https://wms.jrmlogistica.app), WMS_USUARIO, WMS_CLAVE.
//   --revisar: inicia sesión y comprueba que la pantalla permite cargar, sin aplicar nada.
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const revisar = args.includes('--revisar')
const [actualizable, stock] = args.filter(a => a !== '--revisar').map(a => resolve(a))
const url = (process.env.WMS_URL || 'https://wms.jrmlogistica.app').replace(/\/$/, '')
const { WMS_USUARIO: usuario, WMS_CLAVE: clave } = process.env
if (!actualizable || !stock || !usuario || !clave) {
  console.error('Uso: node cargar-wms.mjs [--revisar] <Actualizable> <StockBodega> (con WMS_USUARIO y WMS_CLAVE)')
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
  await page.waitForURL(u => !u.pathname.endsWith('/login'), { timeout: MIN }).catch(() => {
    throw new Error('No se pudo iniciar sesión en el WMS: verifique la cuenta del robot')
  })
  await page.goto(`${url}/almacen/actualizaciones`, { waitUntil: 'domcontentloaded' })
  await page.locator('#erp-file-stock').waitFor({ state: 'attached', timeout: 2 * MIN }).catch(() => {
    throw new Error('La pantalla Actualizaciones no muestra la carga ERP: la cuenta del robot necesita permiso almacen-carga')
  })
  if (revisar) { console.log('Revisión WMS OK (no se aplicó nada)'); process.exit(0) }

  await page.locator('#erp-file-contratos').setInputFiles(actualizable)
  await page.locator('#erp-file-stock').setInputFiles(stock)
  await page.locator('#erp-apply').click()
  // Solo los mensajes de la página: Next.js también tiene un aviso de ruta con role=alert
  const listo = page.locator('p[role=status]')
  const error = page.locator('p[role=alert]')
  await listo.or(error).first().waitFor({ timeout: 45 * MIN })
  if (await error.isVisible()) throw new Error(`Carga WMS: ${await error.innerText()}`)
  console.log(`OK WMS ${await listo.innerText()}`)
} catch (e) {
  console.error(`ERROR ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
