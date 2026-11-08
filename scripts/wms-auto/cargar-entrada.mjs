// Carga únicamente C:\\WMS\\entrada.xlsx en la fuente de Recepción WMS.
// Usa la página dedicada de etiquetas; no accede a Inventario multi-almacén.
import { resolve } from 'node:path'

const args=process.argv.slice(2), revisar=args.includes('--revisar')
const files=args.filter(x=>x!=='--revisar').map(x=>resolve(x))
const url=(process.env.WMS_URL||'').replace(/\/$/,'')
const {WMS_USUARIO:user,WMS_CLAVE:password}=process.env
if(files.length!==1||!url||!user||!password){console.error('Uso: node cargar-entrada.mjs [--revisar] <entrada.xlsx> (WMS_URL, WMS_USUARIO y WMS_CLAVE)');process.exit(2)}
const host=new URL(url).hostname
// Solo sitios WMS (producción, staging o el preview de la rama); nunca el TMS
const wmsHost=host==='wms.jrmlogistica.app'||/^jrm-wms(-staging)?(-[a-z0-9-]+)?\.vercel\.app$/.test(host)
 ||(host.includes('git-feature-warehouse-wms-portal')&&host.endsWith('.vercel.app'))
if(!wmsHost){console.error('Por seguridad, el robot solo carga en el WMS (wms.jrmlogistica.app, jrm-wms o su preview); el TMS queda bloqueado.');process.exit(2)}
const { chromium } = await import('playwright-core')
const browser=await chromium.launch({channel:'msedge',headless:true}), page=await browser.newPage()
try{
 await page.goto(url+'/almacen/login',{waitUntil:'domcontentloaded'})
 await page.locator('#login-username').fill(user);await page.locator('#login-password').fill(password);await page.locator('button[type=submit]').click()
 await page.waitForURL(u=>!u.pathname.endsWith('/login'),{timeout:60000}).catch(()=>{throw new Error('No se pudo iniciar sesión WMS; verifique cuenta aprobada y permisos.')})
 await page.goto(url+'/almacen/apt/etiquetado',{waitUntil:'domcontentloaded'})
 const input=page.locator('input[type=file]').first();await input.waitFor({state:'attached',timeout:60000})
 await input.setInputFiles(files[0])
 if(revisar){console.log('Revisión OK: acceso a la importación de ingresos WMS. No se aplicaron cambios.');process.exitCode=0}
 else{
  const button=page.locator('#wms-receipt-import')
  await button.waitFor({state:'visible',timeout:60000});await button.click()
  // Solo dentro de <main>: Next.js agrega en cada página un aviso de ruta vacío con role=alert
  const status=page.locator('main [role=status]'),alert=page.locator('main [role=alert]')
  await status.or(alert).first().waitFor({timeout:10*60000})
  if(await alert.isVisible())throw new Error(await alert.innerText())
  const message=await status.innerText()
  if(!/importad|ya estaba importado/i.test(message))throw new Error('La pantalla no confirmó la importación: '+message)
  console.log('OK '+message)
 }
}catch(e){console.error('ERROR '+(e instanceof Error?e.message:e));process.exitCode=1}
finally{await browser.close()}
