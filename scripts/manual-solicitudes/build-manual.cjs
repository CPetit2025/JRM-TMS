const fs = require('fs'), path = require('path')
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')
const D = __dirname, img = n => 'data:image/png;base64,' + fs.readFileSync(path.join(process.env.IMG || path.join(D, 'img'), n + '.png')).toString('base64')
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../../public/jrm-logo-v2.png')).toString('base64')
const step = (n, title, image, body, note) => `<section class="step"><div class="step-h"><span class="n">${n}</span><h3>${title}</h3></div>
  <div class="body">${body}</div><figure><img src="${img(image)}"/></figure>${note ? `<p class="note">${note}</p>` : ''}</section>`
const today = new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Lima' })
const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 16mm 14mm 18mm 14mm }
* { box-sizing: border-box } body { font-family: 'Inter','Segoe UI',Arial,sans-serif; color: #1e293b; font-size: 10.5pt; line-height: 1.5; margin: 0 }
h1,h2,h3 { color: #002855; margin: 0 } h2 { font-size: 17pt; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 3px solid #c8102e }
.cover { height: 262mm; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always }
.cover .band { background: #002855; color: #fff; border-radius: 14px; padding: 36px 32px } .cover h1 { color: #fff; font-size: 30pt; line-height: 1.15 }
.cover .sub { font-size: 13pt; opacity: .9; margin-top: 10px } .cover .meta { color: #475569; font-size: 10pt } .cover img.logo { height: 56px }
.chapter { page-break-before: always } .lead { color: #475569; margin: 0 0 12px }
.step { break-inside: avoid; margin: 0 0 18px } .step-h { display: flex; align-items: center; gap: 10px; margin-bottom: 6px }
.step-h .n { width: 26px; height: 26px; border-radius: 50%; background: #002855; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 10pt; flex: none }
.step-h h3 { font-size: 12.5pt } .body p { margin: 4px 0 } .body ul { margin: 4px 0 6px 18px; padding: 0 } .body li { margin: 2px 0 }
figure { margin: 8px 0 0; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; background: #f8fafc } figure img { width: 100%; display: block }
.note { background: #eff6ff; border-left: 4px solid #2563eb; padding: 6px 10px; border-radius: 4px; font-size: 9.5pt; margin: 8px 0 0 }
.warn { background: #fffbeb; border-left: 4px solid #d97706; padding: 6px 10px; border-radius: 4px; font-size: 9.5pt }
.new { display: inline-block; background: #c8102e; color: #fff; font-size: 7.5pt; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6px 0 12px } th { background: #002855; color: #fff; text-align: left; padding: 6px 8px } td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; vertical-align: top }
.toc li { margin: 4px 0 } .muted { color: #64748b }
</style></head><body>
<div class="cover">
  <div><img class="logo" src="${logo}"/></div>
  <div class="band"><p style="margin:0 0 8px;letter-spacing:2px;font-size:9pt;opacity:.8">MANUAL DE USO · MÓDULO COMERCIAL</p>
    <h1>Solicitud de Transporte</h1><p class="sub">Cómo registrar una solicitud paso a paso, incluido el alta de OT, clientes y proveedores sin salir de la ventana.</p></div>
  <div class="meta"><p><b>Sistema:</b> JRM TMS · Control Tower &nbsp;·&nbsp; <b>Pantalla:</b> /solicitudes</p><p><b>Versión del manual:</b> 1.0 · ${today}</p>
  <p class="muted">Las imágenes son capturas de la pantalla real del sistema con datos de demostración (OT, clientes y montos ficticios).</p></div>
</div>

<h2>Contenido</h2>
<ol class="toc"><li>Pantalla de solicitudes</li><li>Nueva solicitud de entrega (paso a paso, con alta de OT y cliente)</li><li>Recojo desde proveedor (alta de proveedor y punto de recojo)</li><li>Acciones sobre una solicitud</li><li>Permisos y estados</li><li>Preguntas frecuentes</li></ol>
<div class="note"><b>Novedades de esta versión</b><span class="new">NUEVO</span><br>
• Registrar una <b>OT madre</b> y su <b>cliente</b> (RUC con SUNAT o extranjero) desde la misma ventana de Nueva solicitud.<br>
• La OT nueva queda seleccionada y su destino se carga solo en la entrega.<br>
• La partida de transporte se puede fijar al crear la OT (solo quien tiene permiso para asignar partidas).</div>

<div class="chapter"><h2>1. Pantalla de solicitudes</h2><p class="lead">Menú <b>Comercial → Solicitud de Transporte</b>.</p>
${step(1, 'Listado y filtros', '01-listado', `<ul><li>Pestañas por estado: <b>Todas, Pendientes, Aprobadas, Asignadas, Reprogramadas</b>, con su cantidad.</li>
<li>Buscador por OT, número de solicitud o dirección; filtros por fechas, tipo de servicio y estado.</li>
<li>Cada fila muestra fecha de solicitud y de atención, tipo de servicio, OT o referencia (OC/OS/RQ), solicitante, empresa, punto de atención y estado.</li>
<li>El botón <b>+ Nueva Solicitud</b> abre el registro.</li></ul>`)}</div>

<div class="chapter"><h2>2. Nueva solicitud de entrega</h2><p class="lead">Ejemplo: despacho desde Planta Chilca a un cliente nuevo, con una OT que todavía no existe en el sistema.</p>
${step(1, 'Abrir la ventana de registro', '02-modal-nuevo', `<p>La ventana tiene seis secciones numeradas a la izquierda y, a la derecha, el <b>Resumen</b> y la lista de lo que <b>falta</b>. Al hacer clic en un pendiente, la ventana va a esa sección.</p>`, 'Mientras se llena, la solicitud se guarda como <b>borrador</b> en el equipo: si se cierra por error, al volver a abrir se ofrece recuperarla.')}
${step(2, 'Servicio', '03-servicio', `<ul><li>Elija el tipo: <b>Despacho</b> (planta → cliente), <b>Recojo</b> (proveedor → planta) o <b>Punto a punto</b>.</li>
<li>Solicitante y <b>Área / departamento</b>.</li><li><b>Modalidad</b>: transporte gestionado por JRM o recojo por el cliente.</li></ul>`)}
${step(3, '¿No existe la OT? Regístrela aquí', '04-ot-nueva-formulario', `<p>Si al buscar la OT no aparece, use el enlace <b>«¿No existe la OT? Regístrala aquí (con su cliente)»</b>. Se abre el formulario <b>Nueva OT madre</b> dentro de la misma ventana. <span class="new">NUEVO</span></p>`)}
${step(4, 'Cliente nuevo con RUC (SUNAT)', '05-cliente-nuevo-sunat', `<ul><li>Si el cliente no está en la lista, pulse <b>+ Nuevo cliente</b>.</li>
<li>Escriba el RUC y pulse <b>SUNAT</b>: se completan la razón social y la dirección fiscal y se muestra el estado (ACTIVO / HABIDO).</li>
<li>Para un cliente del exterior elija <b>Extranjero</b>: país y documento tributario de su país (sin SUNAT).</li>
<li>Pulse <b>Registrar y usar en esta OT</b>. Si el RUC ya existía, se usa ese cliente: no se duplica.</li></ul>`)}
${step(5, 'Datos de la OT', '06-ot-nueva-completa', `<ul><li><b>Código de la OT</b> (único en el sistema), <b>cliente</b> y <b>dirección de destino</b> con departamento, provincia y distrito.</li>
<li><b>Partida de transporte (S/)</b>: el 80 % queda disponible para operación. Solo aparece para quien puede asignar partidas.</li>
<li>Pulse <b>Registrar OT y usarla</b>.</li></ul>`, 'Si la OT se registra <b>sin partida</b>, la solicitud quedará <b>Observada</b> hasta que Contratos asigne la partida de transporte.')}
${step(6, 'OT seleccionada y componentes', '07-ot-seleccionada', `<ul><li>La OT queda seleccionada con su cliente, destino y saldo.</li>
<li>Marque los <b>componentes incluidos</b> (OT madre, subcontratos o errores). Si falta uno, use <b>Registrar subcontrato</b> o <b>Registrar error</b>.</li>
<li>El resumen muestra el saldo de la OT raíz, el costo estimado y el saldo proyectado.</li></ul>`)}
${step(7, 'Origen y destino', '08-origen-destino', `<p>El origen es Planta Chilca y el destino se completa con el de la OT. Puede elegir un <b>destino frecuente</b> o corregir la dirección. Indique peso y volumen estimados si los conoce.</p>`)}
${step(8, 'Fecha de atención', '09-fecha', `<p>Fecha, hora (Lima) y ventana horaria opcional. Según la zona de entrega, el sistema muestra la <b>anticipación mínima</b> y el primer horario permitido.</p>`)}
${step(9, 'Carga y documento', '10-carga', `<ul><li>Escriba la <b>glosa</b> (descripción de la carga).</li><li>Documento de referencia opcional (OC, OS o RQ).</li>
<li>El <b>costo referencial del flete</b> se calcula con el tarifario: no condiciona la solicitud; el flete real se define al armar la ruta.</li></ul>`)}
${step(10, 'Descarga especial', '11-descarga', `<p>Indique si la entrega requiere montacargas, grúa, estiba u otros. Si responde <b>Sí</b>, registre cada concepto con su costo estimado.</p>`)}
${step(11, 'Revisar y enviar', '12-modal-completo', `<p>Cuando el panel muestra <b>TODO COMPLETO</b> y la barra inferior dice <b>Lista para enviar</b>, revise el resumen y pulse <b>Enviar solicitud</b>.</p>`)}
${step(12, 'Solicitud enviada', '13-enviada', `<p>Aparece el mensaje <b>«Solicitud enviada correctamente»</b> y la solicitud pasa al listado como <b>Pendiente</b> de aprobación del Supervisor de Despacho.</p>`)}
</div>

<div class="chapter"><h2>3. Recojo desde proveedor</h2><p class="lead">En <b>Recojo</b> y <b>Punto a punto</b> aparece la sección <b>Proveedor de origen</b>.</p>
${step(1, 'Proveedor de origen', '14-recojo-proveedor', `<p>Busque el proveedor por razón social o RUC y elija el <b>punto de recojo</b>. Si el punto no existe, use <b>Nuevo punto</b>.</p>`)}
${step(2, 'Registrar un proveedor nuevo', '15-nuevo-proveedor', `<ul><li>Pulse <b>+ Nuevo proveedor</b>: RUC, razón social, categoría y contacto.</li>
<li>Puede registrar en el mismo paso su <b>punto de recojo</b> (dirección y distrito).</li><li>Pulse <b>Registrar y seleccionar</b>: queda elegido en la solicitud.</li></ul>`)}
${step(3, 'Documento de referencia obligatorio', '17-recojo-referencia', `<p>El recojo se identifica con <b>OC, OS o RQ</b> y su número. Vincular una OT es opcional en este tipo de servicio.</p>`)}
</div>

<div class="chapter"><h2>4. Acciones sobre una solicitud</h2>
${step(1, 'Menú de acciones', '18-acciones', `<p>El botón <b>⋯</b> de cada fila muestra las acciones permitidas según su estado y su rol:</p>
<ul><li><b>Aprobar / Rechazar</b> (Supervisor de Despacho).</li><li><b>Editar</b> mientras no esté asignada a una ruta.</li>
<li><b>Duplicar como nueva</b>: usa la solicitud como plantilla.</li><li><b>Reprogramar</b> (nueva fecha y causa) y <b>Cancelar servicio</b>.</li></ul>
<p>El ícono del ojo abre el detalle y la trazabilidad de la solicitud.</p>`)}
</div>

<div class="chapter"><h2>5. Permisos y estados</h2>
<table><tr><th>Acción</th><th>Quién puede hacerlo</th></tr>
<tr><td>Registrar solicitudes</td><td>Usuarios con permiso «Solicitudes»</td></tr>
<tr><td>Registrar OT madre y cliente desde la solicitud</td><td>Administrador, Administrador de Contratos y usuarios con permiso «OT» o «Clientes»</td></tr>
<tr><td>Fijar la partida de transporte al crear la OT</td><td>Administrador o usuarios con «Contratos y OTs» con escritura</td></tr>
<tr><td>Registrar proveedor y punto de recojo</td><td>Quien registra la solicitud de recojo o punto a punto</td></tr>
<tr><td>Aprobar o rechazar</td><td>Supervisor de Despacho</td></tr>
<tr><td>Reprogramar</td><td>Supervisor de Despacho, Despacho o Administrador de Contratos de la OT</td></tr></table>
<table><tr><th>Estado</th><th>Significado</th></tr>
<tr><td>Pendiente</td><td>Registrada, espera la aprobación del Supervisor de Despacho.</td></tr>
<tr><td>Observada</td><td>Falta partida u OT con fondos: Contratos debe completarla.</td></tr>
<tr><td>Aprobada</td><td>Lista para que Despacho arme la ruta.</td></tr>
<tr><td>Asignada / En tránsito</td><td>Incluida en una ruta / la unidad está en camino.</td></tr>
<tr><td>Reprogramada</td><td>Con nueva fecha; vuelve a Despacho para programarse.</td></tr>
<tr><td>Entregada</td><td>Servicio cumplido con su guía aprobada.</td></tr>
<tr><td>Rechazada / Cancelada</td><td>No se atenderá.</td></tr></table>

<h2 style="margin-top:14px">6. Preguntas frecuentes</h2>
<p><b>No veo el enlace «¿No existe la OT?».</b> Su rol no tiene permiso para registrar OT. Pida el alta a Contratos o solicite el permiso «OT» o «Clientes».</p>
<p><b>La OT nueva quedó sin partida.</b> Es normal si su rol no asigna partidas. La solicitud quedará Observada hasta que Contratos registre la partida en <b>Contratos y OTs</b>.</p>
<p><b>SUNAT no responde.</b> Complete la razón social a mano y guarde; el RUC queda registrado igual.</p>
<p><b>El código de OT ya existe.</b> El sistema no permite duplicados: busque la OT en el buscador en lugar de crearla.</p>
<p><b>Cerré la ventana sin enviar.</b> Al abrir <b>Nueva Solicitud</b> se ofrece recuperar el borrador guardado en el equipo.</p>
</div></body></html>`
fs.writeFileSync(path.join(process.env.IMG || path.join(D, 'img'), 'manual.html'), html)
;(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] }); const p = await b.newPage()
  await p.setContent(html, { waitUntil: 'load' })
  await p.pdf({ path: process.argv[2], format: 'A4', printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="font-size:8px;color:#64748b;width:100%;padding:0 14mm;display:flex;justify-content:space-between"><span>JRM TMS · Manual de Solicitud de Transporte</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>',
    margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' } })
  await b.close(); console.log('PDF listo')
})()
