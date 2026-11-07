# Solicitud de tercerización: formulario compacto y preparación manual

## Alcance e inspección

Se transforma `OutsourcingRequest`, abierto desde Acciones de `/despacho` y desde la ficha de `/despacho/tercerizaciones`. No existe un segundo formulario de registro. Se conserva el recurso oficial `public/logo-jrm.png`; no se usa el logo del bosquejo ni se modifica el branding global.

La relación sigue siendo `transport_outsourcing.request_id → transport_requests → contracts / clients`, con `dispatch_id` y los controles de reserva y cierre existentes. Se reutilizan `outsourcing_save`, `outsourcing_form_context`, `outsourcing_submit`, `outsourcing_review`, las políticas por sede y permisos, Storage privado `outsourcing`, las cotizaciones y los eventos. No se crean tablas, endpoints, migraciones ni un nuevo flujo presupuestal.

## Composición y validaciones

Encabezado e identificación horizontal; cuatro tarjetas en una cuadrícula 2 × 2: información general, transporte, recursos y condiciones operativas. Sin asistente, pestañas ni resumen lateral. Modal hasta 1.500 px, máximo 95dvh, encabezado y acciones fuera del contenido desplazable. En pantallas menores se permite el desplazamiento interno; en móvil se apilan las tarjetas.

Transporte conserva las cuatro filas del bosquejo. Bultos, restricciones y permisos se editan en Detalles técnicos, cerrado inicialmente. Las cinco filas de recursos muestran únicamente los controles compactos de los equipos seleccionados. Desmarcar conserva sus valores en `specification.service_drafts`, sin incluirlos en la validación ni en los documentos. Al seleccionar de nuevo se recuperan, también después de guardar y reabrir.

Carga y descarga tienen intervalos con fecha y hora (Lima), por lo que pueden cruzar días. Los textos de ventana se derivan de los intervalos, sin un segundo horario editable. Accesos, ámbito Lima/provincia, documentos por responsable y archivos se amplían en el detalle operativo. Se conservan las exigencias del validador y del RPC existentes; no se rellenan requisitos técnicos con textos genéricos.

Las unidades enteras no aceptan fracciones o negativos. Cuando tanto el peso como el volumen ocupan menos de 20 % de la capacidad conjunta declarada en dos o más unidades, se muestra una advertencia orientativa y se exige justificación de al menos diez caracteres. No se ajustan cantidades ni se acredita viabilidad. Se permite guardar borradores incompletos. Preparar exige resolver los errores críticos y verificar los documentos vinculados; existe una marca explícita para exigir archivos de referencia cuando corresponda. Los errores aparecen junto al campo, incluso en los detalles, y se pueden enfocar desde el resumen de errores.

## Preparación y confirmación de envío

1. Guardar borrador utiliza la función existente y conserva una fila por solicitud con control de versión.
2. Enviar a Compras **prepara**, sin enviar correo ni llamar a `outsourcing_submit`: valida, guarda, sube los archivos pendientes, comprueba su disponibilidad privada, genera el PDF ejecutivo y el anexo, y persiste `specification.preparation.state = PREPARED` en la revisión vigente.
3. El estado mostrado es **Preparada para envío**; la etapa operativa sigue siendo 0. El guardado existente registra usuario y fecha del servidor y una copia íntegra de la ficha en `transport_outsourcing_events`.
4. Se abre **Preparar correo para Compras**, con destinatarios corporativos ya acordados, asunto y mensaje editables. Copiar asunto, mensaje o correo completo no genera transición, notificación de recepción ni afirmación de entrega. El navegador informa si deniega el portapapeles; permite seleccionar el texto manualmente.
5. Cerrar la preparación guarda sus ediciones mediante el RPC existente. Al reabrir se recuperan. Cambiar cualquier dato técnico invalida la preparación y el borrador de correo; exige generar otra vez los documentos.
6. Posteriormente el solicitante puede registrar una **declaración de envío manual**: fecha/hora sin futuro, referencia, casilla explícita y confirmación. Solo entonces se llama al envío interno atómico existente (`outsourcing_submit`), con `confirmation_kind = USER_ATTESTED` y una nota que indica que **no hay verificación técnica de entrega**. Esa recepción interna permite continuar las ocho etapas de Compras ya instaladas.
7. La UI diferencia la declaración manual de los registros anteriores recibidos en la bandeja interna. Copiar, descargar, abrir la preparación o confirmar manualmente no se presentan como confirmación técnica de Outlook, entrega o lectura.

Los metadatos de preparación son información declarativa dentro de la ficha, no credenciales ni pruebas independientes del proveedor de correo. La identidad y fecha de cada evento las aporta el RPC existente, no el navegador. No se implementa envío automático ni se utiliza Microsoft Graph.

## Documentos

`outsourcing-document.ts` crea un modelo único sobre los datos cargados. `outsourcing-pdf.ts` usa jsPDF, sin capturar el modal:

- **Ejecutivo:** una página A4 horizontal, texto mínimo de 8 puntos, identificación, servicio, carga, tabla de recursos seleccionados, condiciones operativas, requisitos para cotización y archivos disponibles.
- **Anexo técnico:** documento separado con todos los campos técnicos, bultos, requisitos y referencias. Los textos amplios en el ejecutivo indican `[ver anexo]`; no se pierden en el anexo ni se reduce indefinidamente la fuente. El ejecutivo pide leer ambos juntos.
- Los archivos de referencia solo se enumeran si están vinculados. Los pendientes se distinguen; no se fusionan al PDF, ni se exponen sus rutas privadas o URLs firmadas.
- No se inventan tarifas, proveedores, aprobaciones o capacidades confirmadas. La cotización solicitada no constituye condiciones comerciales acordadas ni autorización de costos.
- El correo es breve, sigue el asunto solicitado `SOLICITUD DE TERCERIZACIÓN | RT-… | OT … | CLIENTE` y solo declara la ficha disponible cuando los documentos se generaron correctamente. Adjuntar los archivos en Outlook sigue siendo una acción manual.

## Verificación y entrega

- `node scripts/test-outsourcing-document.cjs`: PDF real de una página horizontal, seis secciones, anexo completo, texto extenso conservado, fechas, revisión, documentos pendientes/disponibles, escaping, destinatarios, estados, recuperación de recursos, justificación y archivos requeridos.
- `node scripts/test-outsourcing-wizard.cjs`: SQL real local con PGlite, preparación y edición sin transición ni recepción, historial con actor/fecha, confirmación sobre la misma fila y regresiones de revisiones, permisos y validación del backend.
- `node scripts/test-transport-outsourcing.cjs`: ocho etapas, cotizaciones, permisos, sede, concurrencia y conciliación económica.
- `node scripts/test-outsourcing-wizard-browser.cjs`: navegador Chromium con servidor Supabase de prueba local; controles reales, carga y borrador, cuatro tarjetas, detalles, conservación de recursos, errores, archivos, descarga de PDF, portapapeles, ediciones de correo, preparación sin envío, declaración manual explícita, permisos y capturas de escritorio/móvil.
- Typecheck, ESLint, guardas y compilación de Next.

Las capturas y documentos de ejemplo contienen fixtures locales. La verificación autenticada del flujo se realiza en ese entorno de prueba; no se insertan registros sintéticos en producción. La publicación de este cambio debe efectuarse únicamente en Vercel, sin ejecutar el trabajo de CI que aplica migraciones o actualiza cachés de la base de producción, conforme a la instrucción expresa de esta entrega de no alterar esa base.

### Comparación y archivos de esta entrega

En el ejemplo de 1536 × 1024, el modal mide 1500 px de ancho, las tarjetas superiores tienen unos 325 px de alto y las inferiores 331 px. La banda termina en y ≈ 928 y las acciones comienzan en y ≈ 934: se muestra la composición completa al 100 % de zoom. Se conservan la franja horizontal, cuatro columnas de dimensiones, tres totales de carga, filas compactas de recursos, condiciones en dos columnas y la banda inferior. Las diferencias operativas deliberadas son las fechas completas de los intervalos, la justificación de unidades y los detalles técnicos expandibles. El logo es exclusivamente el oficial del proyecto.

- Coordinación y persistencia: `src/components/despacho/OutsourcingRequest.tsx`.
- Secciones compactas (sustituye a `WizardSteps.tsx`): `src/components/despacho/outsourcing/RequestSections.tsx`.
- Preparación y copia (sustituye a `DocumentPreview.tsx`): `src/components/despacho/outsourcing/EmailPreparation.tsx`.
- Controles y estilos: `WizardFields.tsx`, `wizard.css`.
- Reglas, estados, documento y correo: `src/lib/outsourcing-form.ts`, `outsourcing-document.ts`, `outsourcing-pdf.ts`.
- Consulta e historial existentes: `src/app/(dashboard)/despacho/tercerizaciones/page.tsx`.
- Pruebas y fixtures: los comandos y archivos de la sección anterior.
