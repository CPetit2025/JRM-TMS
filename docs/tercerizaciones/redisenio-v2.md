# Solicitud de tercerización · asistente v2

## Inspección e integración conservada

El formulario original es `src/components/despacho/OutsourcingRequest.tsx`, abierto desde la columna Acciones de `/despacho`. Guardaba una ficha JSON plana por `outsourcing_save` y derivaba a `/despacho/tercerizaciones` para enviar. La bandeja ya tenía cotizaciones, aprobación, confirmación de proveedor y conciliación con el despacho; el rediseño conserva ese circuito y las ocho etapas.

Relaciones: `transport_outsourcing.request_id` → `transport_requests` → `contracts` (OT) y cliente; `dispatch_id` → `dispatches`; cotizaciones en `transport_outsourcing_quotes`, auditoría en `transport_outsourcing_events`, adjuntos privados en Storage `outsourcing`. Se conserva la unicidad por solicitud, el control de sede, versiones y los permisos `despacho`, `compras-tercerizaciones`, `compras-aprobar` y `cierre-economico`. No se asignan permisos nuevos a personas ni se modifican saldos.

La fecha requerida, direcciones, responsable, cliente y OT provienen del TMS. Se precargan peso declarado y volumen conocido. Las cantidades de productos no se convierten automáticamente en cantidades de bultos; el usuario declara ese detalle. Ninguno de los datos del bosquejo se utiliza como valor predeterminado en producción.

## Implementación por pestaña

1. **Información general:** fecha/hora Lima, recojo, entrega, responsable, puntos intermedios editables y ordenables. Precarga real. Prioridad sincronizada entre identificación y resumen. Conserva puntos de fichas anteriores y admite No aplica.
2. **Transporte y carga:** tipo de unidad y Otros, cantidad de unidades, dimensiones útiles y capacidad por unidad, consolidados de carga, embalaje, permisos, sujeción, protección y restricciones. Tabla de bultos con agregar, editar, retirar, peso unitario y dimensiones. Totales calculados visibles y aplicación explícita con confirmación; no sobrescribe silenciosamente el TMS. Cantidades enteras, capacidad conjunta, peso/volumen y coherencia con los bultos.
3. **Servicios complementarios:** cinco opciones condicionales, confirmación explícita de ausencia de recursos, cantidades, capacidades, alturas/alcances, ubicaciones, fechas, horarios, duración, operadores, maniobra, izaje, piso, seguridad y requisitos particulares según servicio. Conserva los campos anteriores. La capacidad nominal de grúa no equivale a aprobación de viabilidad.
4. **Condiciones operativas:** ventanas con inicio/fin y zona Lima, indicaciones originales, duración, restricciones de horario, planta/obra, destino Lima/Provincia/Otro, particularidades y restricciones técnicas condicionales, documentación por proveedor/unidad/conductor/operadores/personal, EPP, inducciones e instrucciones. Los requisitos declarados no se muestran como documentos verificados.
5. **Revisión y envío:** tarjetas compactas de las cuatro categorías y validación final, botones Editar, errores con sección concreta, adjuntos múltiples, confirmación de envío y respuesta real. Los archivos solo admiten PDF/JPG/PNG, hasta 10 MB cada uno.

Estado compartido entre pestañas, borradores parciales, reapertura tanto desde Acciones como desde la bandeja, navegación por pestaña/Anterior/Siguiente, protección de cambios no guardados al cerrar y salir de la página, bloqueo durante escrituras y prevención de doble envío. El progreso representa secciones válidas, no visitas; la quinta está completa cuando las verificaciones finales pasan, sin exigir un envío previo.

## Esquema y API: necesidad y compatibilidad

Migración `20261228090000_outsourcing_wizard_v2.sql`:

- Agrega `review_status` (`ACTIVE`, `OBSERVED`, `CANCELLED`) y `revision` al requerimiento, y `spec_revision` a las cotizaciones. Son columnas con valores predeterminados compatibles, sin reescribir fichas históricas.
- La especificación JSON conserva sus claves originales y añade `schema_version`, paquetes, puntos, adjuntos, cantidades, ventanas y requisitos detallados. Fechas persistidas con desplazamiento `-05:00`; presentación `dd/mm/aaaa hh:mm`.
- Añade `outsourcing_v2_validate` (interno), `outsourcing_submit` (validar, guardar y enviar en una transacción), `outsourcing_review` y `outsourcing_form_context` (lectura acotada para reabrir desde Compras).
- Conserva las firmas de `outsourcing_save`, `outsourcing_transition` y `outsourcing_add_quote`; implementaciones anteriores pasan a funciones internas `_v1` sin acceso de clientes. El validador impide omitir nuevos requisitos desde llamadas directas.
- El envío registra la recepción en la bandeja, el actor y la fecha de manera atómica. Utiliza también el mecanismo real de campana `notif_emit`, con regla `TERCERIZACION_ENVIADA` y deduplicación por solicitud/revisión; respeta las preferencias existentes. No simula correo, orden de compra ni autorización financiera.
- Compras puede observar antes de adjudicar (etapas 1–2; en pendiente de aprobación, el permiso de aprobación). Vuelve al mismo borrador observado y aumenta la revisión técnica. Las cotizaciones anteriores permanecen, pero no pueden seleccionarse para adjudicar la revisión nueva.
- La cancelación está disponible antes de confirmar proveedor/despacho, por el permiso que administra cada etapa. Una confirmación con compromisos operativos debe resolverse por el circuito existente de despacho; no se anula ni libera presupuesto desde este formulario.
- RLS de las tablas permanece vigente. La política de alta de adjuntos añade la barrera de cancelación; los adjuntos previos siguen disponibles para consulta. La OT continúa protegida durante observaciones/cancelación. No se abren permisos generales sobre solicitudes o contratos a Compras.

Las solicitudes ya enviadas conservan sus etapas y son consultables; sus campos nuevos no se inventan. Los borradores anteriores se normalizan al abrir y requieren completar los datos nuevos antes de enviar. La aprobación de cotización sigue separada de las reglas de autorización de gasto y cierre económico existentes.

## Fidelidad visual y captura

Composición contrastada con la imagen adjunta del usuario en viewport **1536 × 1024**: modal centrado, encabezado con marca JRM del bosquejo en SVG, separador/título/subtítulo/estado/cierre, identificación horizontal, cinco pestañas en una fila, dos columnas y barra inferior fija. En escritorio el resumen se mantiene mediante posición sticky mientras se recorre el formulario. En móvil se permite reorganización y desplazamiento de pestañas.

La medición final de la suite queda en `geometry.json` junto a las capturas de `/workspace/artifacts/tercerizacion-v2`. La primera revisión midió modal de **1516 × 992 px**, formulario **982 px**, resumen **470 px** y separación **22 px**, con ambas columnas comenzando en **y ≈ 379 px**. Se corrigieron anchos, márgenes, altura del encabezado, fecha localizada, icono informativo, progreso y barra de acciones después de inspeccionar la captura. No se afirma identidad píxel a píxel: tipografía, glifos del logo SVG y controles nativos pueden diferir del bosquejo.

## Archivos y comprobación

- Orquestación/modal: `OutsourcingRequest.tsx`.
- Campos, pestañas y diseño compartido: `outsourcing/WizardFields.tsx`, `WizardSteps.tsx`, `wizard.css`.
- Modelo, precarga, normalización, cálculos, progreso y validación: `src/lib/outsourcing-form.ts`; tipos existentes ampliados en `outsourcing.ts`.
- Bandeja: `/despacho/tercerizaciones/page.tsx`, con apertura del asistente, consulta completa, observación y cancelación por permisos.
- Nueva marca del bosquejo: `public/jrm-wordmark.svg`.
- Pruebas: `test-outsourcing-wizard.cjs`, `test-outsourcing-wizard-browser.cjs` y fixtures aislados. Las pruebas SQL de base y v2 quedan añadidas a la verificación de PR. El comando anterior `test-transport-outsourcing-browser.cjs` deriva a la suite nueva para conservar el punto de entrada de regresión.

Ejecutar:

```sh
node scripts/test-outsourcing-wizard.cjs
node scripts/test-transport-outsourcing.cjs
node scripts/test-outsourcing-wizard-browser.cjs
npm run typecheck
npm run check:guards
npm run build
```

La suite SQL usa PostgreSQL aislado (PGlite) y funciones reales. Verifica campos, cantidades, fechas, capacidad, paquetes, servicios, recepción, duplicados, transacción atómica, revisión, cotizaciones históricas, cancelación, permisos y sede. La suite de navegador usa Chromium real con Auth/API simulados y fixtures del bosquejo; verifica apertura, controles, persistencia/reapertura, navegación, múltiples puntos/unidades/bultos/servicios, resumen, progreso, envío, doble clic, errores, permisos, escritorio/móvil y geometría. Las pruebas simuladas no se presentan como operaciones de negocio ejecutadas en producción.

## Publicación y recuperación

Aplicar mediante el pipeline aprobado a la base TMS `eojfsbogysifxrlrnjvx`, nunca a WMS; después desplegar el commit verificado en el proyecto Vercel `jrm-tms`. La entrega incluye migración, compilación, verificación del despliegue y prueba SQL reversible del módulo en la base destino, sin dejar solicitudes de prueba.

La migración no destruye tablas ni información anterior. Ante un problema se prefiere corregir hacia adelante; una restauración de frontend debe mantener las columnas y auditoría nuevas, y los cambios de funciones deben realizarse mediante una migración correctiva. No ejecutar una eliminación de columnas o revisiones como rollback si ya existen solicitudes v2.

Limitaciones deliberadas: no verifica automáticamente documentos declarados ni viabilidad técnica; no envía correo externo, no adjudica ni compromete presupuesto desde el asistente; la recepción real es la bandeja de Compras y la campana existente. La bandeja mantiene el límite previo de 500 registros recientes. La cancelación posterior a confirmación requiere resolver el despacho y sus compromisos por el proceso existente.

## Ajuste posterior: modal compacto al 100 % de zoom

La referencia de 1536 × 1024 no representaba el alto útil de un navegador de portátil con barras y escalado de Windows. El modal de escritorio pasa a ancho máximo 1240 px, altura natural con límite de viewport y márgenes exteriores. Se compactan encabezado, identificación, pestañas, tarjetas, controles, resumen y acciones; las ventanas bajas reciben una densidad adicional. No se aplica `zoom` ni una transformación para reducir el contenido.

La regresión de navegador comprueba el primer paso completo sin desplazamiento interno al 100 % de zoom, los márgenes del modal, el resumen y el pie visible en 1536 × 864, 1366 × 768, 1280 × 720, 1366 × 650 y 1100 × 650. Los pasos largos conservan desplazamiento central y las acciones accesibles. Este ajuste es exclusivamente visual: no añade migraciones ni cambia datos o permisos.
