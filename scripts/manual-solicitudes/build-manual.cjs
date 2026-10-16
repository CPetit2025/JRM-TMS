const fs = require('fs'), path = require('path')
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')
const D = __dirname, img = n => 'data:image/png;base64,' + fs.readFileSync(path.join(process.env.IMG || path.join(D, 'img'), n + '.png')).toString('base64')
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../../public/jrm-logo-v2.png')).toString('base64')
const step = (n, title, image, body, note) => `<section class="step"><div class="step-h"><span class="n">${n}</span><h3>${title}</h3></div>
  <div class="body">${body}</div><figure><img src="${img(image)}"/></figure>${note ? `<p class="note">${note}</p>` : ''}</section>`
const today = new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Lima' })
const front = (cls, label, title, lead) => `<div class="chapter"><div class="front ${cls}"><span>${label}</span><h2>${title}</h2><p>${lead}</p></div>`
const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 16mm 14mm 18mm 14mm }
* { box-sizing: border-box } body { font-family: 'Inter','Segoe UI',Arial,sans-serif; color: #1e293b; font-size: 10.5pt; line-height: 1.5; margin: 0 }
h1,h2,h3 { color: #002855; margin: 0 } h2.t { font-size: 17pt; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 3px solid #c8102e }
.cover { height: 262mm; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always }
.cover .band { background: #002855; color: #fff; border-radius: 14px; padding: 36px 32px } .cover h1 { color: #fff; font-size: 30pt; line-height: 1.15 }
.cover .sub { font-size: 13pt; opacity: .9; margin-top: 10px } .cover .meta { color: #475569; font-size: 10pt } .cover img.logo { height: 56px }
.chips { display: flex; gap: 8px; margin-top: 16px } .chips span { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.35); border-radius: 999px; padding: 4px 12px; font-size: 10pt; font-weight: 600 }
.chapter { page-break-before: always } .lead { color: #475569; margin: 0 0 12px }
.front { border-radius: 12px; padding: 14px 18px; margin-bottom: 14px; color: #fff } .front span { font-size: 8.5pt; letter-spacing: 2px; font-weight: 700; opacity: .85 }
.front h2 { color: #fff; font-size: 19pt; margin: 2px 0 4px } .front p { margin: 0; opacity: .92 }
.f-ent { background: linear-gradient(135deg,#002855,#1d4ed8) } .f-rec { background: linear-gradient(135deg,#9a3412,#ea580c) } .f-pap { background: linear-gradient(135deg,#6b21a8,#a21caf) } .f-gen { background: linear-gradient(135deg,#0f172a,#334155) }
.step { break-inside: avoid; margin: 0 0 18px } .step-h { display: flex; align-items: center; gap: 10px; margin-bottom: 6px }
.step-h .n { width: 26px; height: 26px; border-radius: 50%; background: #002855; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 10pt; flex: none }
.f-rec ~ .step .n { background: #c2410c } .f-pap ~ .step .n { background: #86198f }
.step-h h3 { font-size: 12.5pt } .body p { margin: 4px 0 } .body ul { margin: 4px 0 6px 18px; padding: 0 } .body li { margin: 2px 0 }
figure { margin: 8px 0 0; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; background: #f8fafc } figure img { width: 100%; display: block }
.note { background: #eff6ff; border-left: 4px solid #2563eb; padding: 6px 10px; border-radius: 4px; font-size: 9.5pt; margin: 8px 0 0 }
.new { display: inline-block; background: #c8102e; color: #fff; font-size: 7.5pt; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6px 0 12px } th { background: #002855; color: #fff; text-align: left; padding: 6px 8px } td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; vertical-align: top }
td.k { font-weight: 600; color: #002855; width: 22% } .toc li { margin: 4px 0 } .muted { color: #64748b }
</style></head><body>
<div class="cover">
  <div><img class="logo" src="${logo}"/></div>
  <div class="band"><p style="margin:0 0 8px;letter-spacing:2px;font-size:9pt;opacity:.8">MANUAL DE USO · MÓDULO COMERCIAL</p>
    <h1>Solicitud de Transporte</h1><p class="sub">Registro paso a paso de los tres frentes de servicio, con alta de OT, clientes y proveedores sin salir de la ventana.</p>
    <div class="chips"><span>ENTREGA</span><span>RECOJO</span><span>PUNTO A PUNTO</span></div></div>
  <div class="meta"><p><b>Sistema:</b> JRM TMS · Control Tower &nbsp;·&nbsp; <b>Pantalla:</b> /solicitudes</p><p><b>Versión del manual:</b> 2.0 · ${today}</p>
  <p class="muted">Las imágenes son capturas de la pantalla real del sistema con datos de demostración (OT, clientes, proveedores y montos ficticios).</p></div>
</div>

<h2 class="t">Contenido</h2>
<ol class="toc"><li>Los tres frentes de servicio</li><li>Pantalla de solicitudes y ventana de registro</li><li><b>ENTREGA</b> · planta → cliente (con alta de OT y cliente)</li>
<li><b>RECOJO</b> · proveedor → planta (con alta de proveedor y punto de recojo)</li><li><b>PUNTO A PUNTO</b> · proveedor → destino externo</li>
<li>Acciones sobre una solicitud</li><li>Permisos y estados</li><li>Preguntas frecuentes</li></ol>
<div class="note"><b>Novedades de esta versión</b><span class="new">NUEVO</span><br>
• Registrar una <b>OT madre</b> y su <b>cliente</b> (RUC con SUNAT o extranjero) desde la misma ventana de Nueva solicitud.<br>
• La OT nueva queda seleccionada y su destino se carga solo en la entrega; la partida de transporte se puede fijar al crearla.<br>
• Proveedores y puntos de recojo también se registran sin salir de la ventana.</div>

<h2 class="t" style="margin-top:18px">1. Los tres frentes de servicio</h2>
<table><tr><th></th><th>ENTREGA</th><th>RECOJO</th><th>PUNTO A PUNTO</th></tr>
<tr><td class="k">Recorrido</td><td>Planta Chilca → cliente</td><td>Proveedor → Planta Chilca</td><td>Proveedor → destino externo</td></tr>
<tr><td class="k">Identificación</td><td>OT madre (obligatoria) y sus componentes</td><td>OC, OS o RQ (obligatoria); OT opcional</td><td>OC, OS o RQ (obligatoria); OT opcional</td></tr>
<tr><td class="k">Empresa</td><td>Cliente de la OT</td><td>Proveedor de origen</td><td>Proveedor de origen</td></tr>
<tr><td class="k">Origen</td><td>Planta Chilca (automático)</td><td>Punto de recojo del proveedor</td><td>Punto de recojo del proveedor</td></tr>
<tr><td class="k">Destino</td><td>Destino de la OT (automático)</td><td>Planta Chilca (automático)</td><td>Dirección que se indica</td></tr>
<tr><td class="k">Flete referencial</td><td>Según tarifario</td><td>Flota propia: sin valorizar flete</td><td>Según tarifario</td></tr>
<tr><td class="k">Alta sin salir</td><td>OT madre, cliente, subcontratos y errores</td><td>Proveedor y punto de recojo</td><td>Proveedor y punto de recojo</td></tr></table>

${front('f-gen', 'GENERAL', '2. Pantalla de solicitudes', 'Menú Comercial → Solicitud de Transporte.')}
${step(1, 'Listado y filtros', 'g-listado', `<ul><li>Pestañas por estado (<b>Todas, Pendientes, Aprobadas, Asignadas, Reprogramadas</b>) con su cantidad.</li>
<li>Buscador por OT, solicitud o dirección; filtros por fechas, tipo de servicio y estado.</li><li>La columna <b>Servicio</b> identifica el frente: Entrega OT, Recojo o Punto a punto.</li><li>El botón <b>+ Nueva Solicitud</b> abre el registro.</li></ul>`)}
${step(2, 'Ventana de registro', 'g-modal', `<p>Secciones numeradas a la izquierda; a la derecha el <b>Resumen</b> y la lista de lo que <b>falta</b> (un clic lleva a la sección). En la sección <b>1 · Servicio</b> se elige el frente: <b>Despacho</b> (entrega), <b>Recojo</b> o <b>Punto a punto</b>.</p>`, 'Mientras se llena, la solicitud se guarda como <b>borrador</b> en el equipo y se ofrece recuperarla al volver a abrir.')}
</div>

${front('f-ent', 'FRENTE 1', '3. ENTREGA · planta → cliente', 'Ejemplo: despacho a un cliente nuevo con una OT que aún no existe en el sistema.')}
${step(1, 'Servicio: Despacho', 'e-servicio', `<p>Elija <b>Despacho</b>, complete <b>Solicitante</b> y <b>Área</b>, y la <b>modalidad</b>: transporte gestionado por JRM o recojo por el cliente.</p>`)}
${step(2, '¿No existe la OT? Regístrela aquí', 'e-ot-nueva', `<p>Si la OT no aparece en el buscador, use <b>«¿No existe la OT? Regístrala aquí (con su cliente)»</b>: se abre <b>Nueva OT madre</b> dentro de la ventana. <span class="new">NUEVO</span></p>`)}
${step(3, 'Cliente nuevo con RUC (SUNAT)', 'e-cliente-sunat', `<ul><li><b>+ Nuevo cliente</b> → escriba el RUC → <b>SUNAT</b>: completa razón social y dirección fiscal y muestra el estado (ACTIVO / HABIDO).</li>
<li>Cliente del exterior: <b>Extranjero</b>, con país y documento tributario (sin SUNAT).</li><li><b>Registrar y usar en esta OT</b>. Si el RUC ya existía, se usa ese cliente.</li></ul>`)}
${step(4, 'Datos de la OT y partida', 'e-ot-datos', `<ul><li>Código único de la OT, cliente y destino (dirección, departamento, provincia y distrito).</li>
<li><b>Partida de transporte</b>: el 80 % queda para operación. Solo aparece a quien puede asignar partidas.</li><li><b>Registrar OT y usarla</b>.</li></ul>`, 'Sin partida, la solicitud quedará <b>Observada</b> hasta que Contratos la asigne.')}
${step(5, 'OT seleccionada y componentes', 'e-ot-seleccionada', `<p>Marque los <b>componentes incluidos</b> (OT madre, subcontratos, errores). Si falta uno, use <b>Registrar subcontrato</b> o <b>Registrar error</b>. Se muestra el saldo de la OT y el saldo proyectado.</p>`)}
${step(6, 'Origen y destino', 'e-ruta', `<p>Origen: Planta Chilca. Destino: el de la OT (puede elegir un <b>destino frecuente</b> o corregirlo).</p>`)}
${step(7, 'Fecha de atención', 'e-fecha', `<p>Fecha, hora (Lima), ventana horaria opcional y zona. Se indica la <b>anticipación mínima</b> y el primer horario permitido.</p>`)}
${step(8, 'Carga y documento', 'e-carga', `<p>Glosa de la carga, documento de referencia opcional y <b>costo referencial del flete</b> según tarifario (no condiciona la aprobación).</p>`)}
${step(9, 'Descarga especial', 'e-descarga', `<p>Indique si requiere montacargas, grúa, estiba u otros. Si es <b>Sí</b>, registre cada concepto con su costo estimado.</p>`)}
${step(10, 'Revisar y enviar', 'e-revisar', `<p>Con <b>TODO COMPLETO</b> y <b>Lista para enviar</b>, revise el resumen y pulse <b>Enviar solicitud</b>.</p>`)}
${step(11, 'Solicitud enviada', 'e-enviada', `<p>Mensaje <b>«Solicitud enviada correctamente»</b>; queda <b>Pendiente</b> de aprobación del Supervisor de Despacho.</p>`)}
</div>

${front('f-rec', 'FRENTE 2', '4. RECOJO · proveedor → planta', 'Ejemplo: recojo de materiales en el almacén de un proveedor, sustentado con una OC.')}
${step(1, 'Servicio: Recojo', 'r-servicio', `<p>Elija <b>Recojo</b>. Complete solicitante, área y modalidad. El destino será Planta Chilca.</p>`)}
${step(2, 'OT opcional', 'r-ot-opcional', `<p>En el recojo la OT es <b>opcional</b>: el servicio se identifica con OC, OS o RQ. Vincule una OT solo cuando corresponda.</p>`)}
${step(3, 'Buscar el proveedor', 'r-proveedor-buscar', `<p>En <b>Proveedor de origen</b>, despliegue el buscador y elija por razón social o RUC.</p>`)}
${step(4, 'Proveedor y punto de recojo', 'r-proveedor-elegido', `<p>Al elegir el proveedor se carga su <b>punto de recojo</b> (si tiene uno, se elige solo) y con él la dirección de origen.</p>`)}
${step(5, 'Nuevo punto de recojo', 'r-nuevo-punto', `<p>Si el proveedor recoge en otro lugar, use <b>Nuevo punto</b>: nombre, dirección y distrito (contacto opcional) → <b>Registrar y usar</b>.</p>`)}
${step(6, 'Nuevo proveedor', 'r-nuevo-proveedor', `<p>Si el proveedor no existe, use <b>+ Nuevo proveedor</b>: RUC, razón social, categoría y contacto; puede registrar en el mismo paso su punto de recojo → <b>Registrar y seleccionar</b>.</p>`)}
${step(7, 'Origen y destino', 'r-ruta', `<p>Origen: el punto del proveedor. Destino: Planta Chilca. Indique peso y volumen estimados si los conoce.</p>`)}
${step(8, 'Fecha de atención', 'r-fecha', `<p>Fecha y hora en que el proveedor entrega la carga (hora de Lima) y ventana horaria opcional.</p>`)}
${step(9, 'Carga y documento obligatorio', 'r-carga-oc', `<p>Glosa y <b>documento de referencia obligatorio</b>: OC, OS o RQ con su número. El recojo con flota propia no valoriza flete; si se contrata un tercero, el supervisor valida su costo al programar.</p>`)}
${step(10, 'Descarga especial', 'r-descarga', `<p>Indique si la descarga en planta requiere montacargas, grúa u otros.</p>`)}
${step(11, 'Revisar y enviar', 'r-revisar', `<p>El resumen muestra <b>Recojo hacia planta</b>, la referencia, el proveedor y la ruta. Pulse <b>Enviar solicitud</b>.</p>`)}
${step(12, 'Solicitud enviada', 'r-enviada', `<p>La solicitud queda <b>Pendiente</b> de aprobación y aparece en el listado como <b>Recojo</b> con su OC/OS/RQ.</p>`)}
</div>

${front('f-pap', 'FRENTE 3', '5. PUNTO A PUNTO · proveedor → destino externo', 'Ejemplo: traslado directo del proveedor a un almacén de obra, sustentado con una OS.')}
${step(1, 'Servicio: Punto a punto', 'p-servicio', `<p>Elija <b>Punto a punto</b>: la carga no pasa por planta. Complete solicitante, área y modalidad.</p>`)}
${step(2, 'Proveedor de origen', 'p-proveedor', `<p>Elija el proveedor y su punto de recojo. Igual que en el recojo, puede registrar un <b>Nuevo proveedor</b> o un <b>Nuevo punto</b> sin salir de la ventana.</p>`)}
${step(3, 'Origen y destino externo', 'p-ruta', `<p>El origen se completa con el punto del proveedor. Escriba la <b>dirección de destino</b> (departamento, provincia y distrito) o elija un <b>destino frecuente</b>.</p>`)}
${step(4, 'Fecha de atención', 'p-fecha', `<p>Fecha y hora de atención (Lima) y ventana horaria opcional.</p>`)}
${step(5, 'Carga y documento obligatorio', 'p-carga-os', `<p>Glosa y <b>OC, OS o RQ obligatoria</b>. Se calcula el <b>costo referencial del flete</b>; el supervisor aprueba los costos contra la OC/OS/RQ y la ruta debe respetar el monto autorizado.</p>`)}
${step(6, 'Descarga especial', 'p-descarga', `<p>Indique si el punto de destino requiere montacargas, grúa, estiba u otros.</p>`)}
${step(7, 'Revisar y enviar', 'p-revisar', `<p>El resumen muestra <b>Entrega de punto a punto</b>, la referencia, el proveedor y la ruta. Pulse <b>Enviar solicitud</b>.</p>`)}
${step(8, 'Solicitud enviada', 'p-enviada', `<p>La solicitud queda <b>Pendiente</b> de aprobación del Supervisor de Despacho.</p>`)}
</div>

${front('f-gen', 'GENERAL', '6. Acciones sobre una solicitud', 'Botón ⋯ de cada fila; las opciones dependen del estado y del rol.')}
${step(1, 'Menú de acciones', 'g-acciones', `<ul><li><b>Aprobar / Rechazar</b> (Supervisor de Despacho).</li><li><b>Editar</b> mientras no esté asignada a una ruta.</li>
<li><b>Duplicar como nueva</b>: usa la solicitud como plantilla.</li><li><b>Reprogramar</b> (nueva fecha y causa) y <b>Cancelar servicio</b>.</li></ul><p>El ícono del ojo abre el detalle y la trazabilidad.</p>`)}
</div>

<div class="chapter"><h2 class="t">7. Permisos y estados</h2>
<table><tr><th>Acción</th><th>Quién puede hacerlo</th></tr>
<tr><td>Registrar solicitudes (los tres frentes)</td><td>Usuarios con permiso «Solicitudes»</td></tr>
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
<h2 class="t" style="margin-top:14px">8. Preguntas frecuentes</h2>
<p><b>No veo el enlace «¿No existe la OT?».</b> Su rol no tiene permiso para registrar OT. Pida el alta a Contratos o el permiso «OT» o «Clientes».</p>
<p><b>La OT nueva quedó sin partida.</b> La solicitud quedará Observada hasta que Contratos registre la partida en <b>Contratos y OTs</b>.</p>
<p><b>¿Recojo o punto a punto?</b> Si la carga llega a Planta Chilca es <b>Recojo</b>; si va del proveedor directamente a otro lugar es <b>Punto a punto</b>.</p>
<p><b>El recojo no muestra flete.</b> Con flota propia el recojo no valoriza flete; si se contrata un tercero, el supervisor valida su costo al programar la ruta.</p>
<p><b>SUNAT no responde.</b> Complete la razón social a mano y guarde; el RUC queda registrado igual.</p>
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
