# Solicitudes de tercerización dirigidas a Compras

Desde **Programación y Ruteo → Acciones → Solicitar tercerización**, Distribución/Transporte genera una ficha vinculada a la solicitud original. Existe una única tercerización por solicitud, protegida por restricción de base de datos. Guardar nuevamente exige la versión vigente y conserva un evento; una ficha enviada queda inmutable. La OT debe estar vinculada antes del envío y no puede cambiarse después.

La bandeja está en **Operación → Tercerizaciones · Compras** (`/despacho/tercerizaciones`). Incluye filtros por etapa y búsqueda por ST, OT, solicitud, responsable y destino. Muestra hasta 500 registros recientes. La ficha contiene datos generales, dimensiones útiles, capacidad, carga, embalaje, requisitos de ingreso, documentos, seguridad, ventanas y tiempo de operación. Los servicios complementarios tienen campos específicos: capacidad/altura/horas, capacidad/alcance/maniobra, capacidad/características, operarios/horario/actividades u otros recursos.

## Responsables y permisos

Asignar mediante Roles y Permisos; no se asignan privilegios automáticamente a usuarios existentes.

| Transición | Permiso de escritura |
|---|---|
| Crear/editar borrador y enviar a Compras | `despacho` |
| Iniciar cotización, registrar alternativas, proponer selección | `compras-tercerizaciones` |
| Aprobar adjudicación | `compras-aprobar` |
| Confirmar proveedores y despacho | `compras-tercerizaciones` |
| Registrar ejecución | `despacho` |
| Cerrar solicitud | `cierre-economico` |

Los mismos módulos con lectura permiten consulta; `control-presupuestal` también permite consultar. La sede limita todas las operaciones, incluidos archivos. La lectura de la bandeja y opciones devuelve solo los campos necesarios; Compras no necesita acceso general a todas las solicitudes, contratos o al maestro completo de proveedores.

## Cotización y evidencia

El flujo es: Solicitud generada → Enviada a Compras → En cotización → Pendiente de aprobación → Servicio adjudicado → Proveedor confirmado → Servicio ejecutado → Cerrado.

Se registran alternativas por servicio, con proveedor activo, total PEN incluyendo impuestos/adicionales, alcance, vigencia y archivo. Antes de solicitar aprobación se selecciona exactamente una alternativa para transporte y cada complemento. Puede haber proveedores distintos para cada servicio. La aprobación queda asociada a la selección y su versión; no se pueden alterar cotizaciones después de enviarlas a aprobación.

Cada transición requiere sustento y registra actor, fecha, estado y una copia de los datos/selección. El envío inicial permite adjunto opcional; las etapas posteriores exigen evidencia PDF, PNG o JPG de hasta 10 MB en un bucket privado. El historial no permite UPDATE ni DELETE al cliente. Los enlaces de descarga vencen en 120 segundos. Los cambios se notifican a la bandeja mediante Supabase Realtime, con actualización manual disponible.

## Relación con el presupuesto existente

La cotización/adjudicación **no mueve saldos**. Antes de confirmar al proveedor, Transporte programa la ruta usando los proveedores y costos adjudicados; esa programación aplica las reservas existentes de flete y servicios complementarios. La confirmación verifica que el despacho programado contenga la solicitud y que el proveedor y el costo de cada concepto coincidan con lo aprobado. Para rutas mixtas se exige el reparto del flete por solicitud. Stocka/transpaleta se imputa a `OTROS`, agrupándose con Otros si ambos usan el mismo proveedor para impedir doble conteo.

No se crea un segundo libro económico ni se suman nuevamente las reservas. La bandeja muestra el total contratado; el control presupuestal mantiene los movimientos originales y dispone de un acceso a Tercerizaciones. Durante la cotización el presupuesto puede cambiar; la disponibilidad definitiva se valida al programar con las reglas vigentes de tope y autorización.

Registrar ejecución requiere que Torre de Control haya liberado la ruta (`RETORNO_COMPLETADO`, `CIERRE_OPERATIVO`, `LIQUIDADO` o `CERRADO`). El cierre de la tercerización requiere cierre económico `CERRADO`, donde se aplican los costos finales y las autorizaciones de desviaciones existentes. No se programan unidades ni se liquidan servicios automáticamente desde Compras.

## Activación y validación

Aplicar `supabase/migrations/20261227090000_transport_outsourcing.sql` después de las migraciones existentes, y desplegar el código. La migración crea tres tablas con RLS, consultas/RPC con permisos y sede, bucket privado y publicación Realtime. No modifica montos ni registros históricos. Fue creada con el CLI y ordenada después de la última migración del repositorio, cuyas versiones llegan al 26 de diciembre de 2026.

Verificación local, sin conexión a producción:

- `node scripts/test-transport-outsourcing.cjs`: PostgreSQL aislado con PGlite; ocho etapas, evidencias, completitud, permisos separados, sede, versiones, unicidad y conciliación.
- `node scripts/test-transport-outsourcing-browser.cjs`: inicia Next y un servidor Supabase simulado local; prueba acceso desde Acciones, ficha/modal, campos de montacargas, envío a Compras y representación en escritorio/móvil. Requiere Playwright y Chromium; permite indicar `CHROMIUM_EXECUTABLE`.
- `npm run typecheck`, ESLint de archivos nuevos y `npm run check:guards`.

La verificación del navegador simula Auth, consultas y RPC. La prueba SQL ejecuta las funciones reales sobre un esquema aislado. La migración, Storage, Realtime y permisos deben verificarse en el entorno de despliegue; estas pruebas no demuestran que ya estén habilitados en producción.

### Vista previa de correo y ficha técnica PDF

En **Revisión y envío → Vista previa de correo y PDF** se revisa la plantilla profesional y se descarga el PDF generado con los datos actuales de la ficha. La vista previa es de consulta: no guarda, envía ni cambia la etapa. Un borrador se identifica como tal; los campos faltantes se muestran como pendientes. El documento incluye número de tercerización si existe, solicitud de transporte, OT, cliente, revisión, estado, vínculo al despacho, especificación completa, bultos, servicios, condiciones operativas y relación de archivos. No representa aprobación ni una orden de compra. Los archivos de referencia se enumeran, no se fusionan al PDF ni se exponen con rutas de Storage o enlaces públicos.

La plantilla HTML es descargable. Destinatarios: rruesta@jrmsac.com.pe y dramirez@jrmsac.com.pe. Copias: cpetit@jrmsac.com.pe, acamargo@jrmsac.com.pe y rsolis@jrmsac.com.pe. El remitente previsto es la cuenta Microsoft 365 autorizada del usuario que ejecute el envío; la vista no inventa una cuenta ni afirma haber enviado un correo.

**Límite actual:** falta autorizar la conexión Microsoft 365. No se ejecuta envío de correo ni se adjunta automáticamente un PDF a un mensaje externo. El PDF está disponible para previsualizar y descargar. «Enviar a Compras» conserva su función de registro y notificación interna. El futuro envío debe usar el mismo generador de PDF y la plantilla sobre la revisión persistida, con autorización delegada y estado de entrega real. Este cambio no requiere migración de base de datos.

Verificación: `node scripts/test-outsourcing-document.cjs` (requiere `pdftotext`), `node scripts/test-outsourcing-wizard-browser.cjs`, typecheck y lint. Los ejemplos de pruebas son fixtures locales; no representan datos consultados en producción.
