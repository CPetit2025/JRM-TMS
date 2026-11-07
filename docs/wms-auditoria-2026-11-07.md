# Auditoría e integración WMS — 7 de noviembre de 2026

## Alcance y evidencia de partida

Repositorio CPetit2025/JRM-TMS. PR #475 abierto: rama WMS en `99b8fa36e82409cd37c18b4689c1e9e3df40121f`. PR #485 fusionado en master, commit `369ffd3ca9d574a933e8498b87b4b4379d5ffb17`. El despliegue TMS `42347216456` constaba exitoso antes de esta ejecución; este trabajo no lo lanzó ni modificó su configuración. Las protecciones de #485 existían en master pero aún no estaban integradas en la rama WMS. Se incorporan sólo sus archivos necesarios en la candidata, sin modificar deploy-production.yml.

El checkout principal tenía cambios ajenos sin confirmar. Se conservó intacto y se creó `/workspace/jrm-wms-audit`, rama `codex/wms-integration-audit`. El estado remoto se volvió a consultar; las afirmaciones de turnos anteriores no se utilizaron como evidencia de despliegue.

## Matriz de auditoría

| Componente | Estado actual | Hallazgo y riesgo | Acción y evidencia |
|---|---|---|---|
| Autenticación | Parcialmente implementado | Cuenta y permisos dependen del proyecto configurado; falta probar cuentas reales WMS | Modo WMS, login propio, proxy y guardas coherentes con JRM_APP; regresión de sesiones ejecutada |
| Base de datos | Parcialmente implementado | El historial incluye esquema legado local de compatibilidad; no es un paquete mínimo WMS | Migración nueva transaccional probada en PostgreSQL descartable; instalación remota condicionada a preflight |
| Recepción | Implementado sin pruebas suficientes | Bandeja y modal existen; sesión operativa real Staging no validada | Se corrigen revisiones obsoletas, filtros locales, datos físicos y respuesta de generación persistida |
| Importación ERP | Implementado y probado en motor local | Cambios de origen podían afectar el significado de etiquetas emitidas | Fuente independiente, hash, rollback, revisión y bloqueo de fuentes etiquetadas |
| Validación física | Implementado y probado en motor local | Sólo comparaba cantidad ERP, no revisión completa del origen | Snapshot del origen, motivo al cambiar conteo, cliente resuelto persistido y filtro de sitio |
| Generación LPN | Implementado y probado en motor local | Reintentos podían modificar paquetes existentes; sólo división uniforme | RPC de cantidades distintas, bloqueo transaccional, códigos secuenciales, reintento idempotente, conservación de cantidades |
| Etiquetado | Implementado y probado en Chromium/PDF | Contenedor fijo imprimía sólo una página de lotes múltiples; se marcaba impresión antes de salir | Altura de flujo, una página por etiqueta, confirmación posterior e idempotencia; impresora física pendiente |
| Robot Windows | Implementado sin prueba Windows | Sitio preview TMS permitido; nombre del botón obsoleto | Destinos WMS exactos, selector corregido, tres intentos, hash ligado al sitio; instalación local pendiente |
| Vercel | Bloqueado por dependencia externa hasta auditar configuración real | Falta confirmar proyectos, claves y permisos de servicio | Auditoría de metadatos y preflight anteriores a cualquier escritura |
| GitHub Actions | Parcialmente implementado | Migraba antes de verificar Vercel y leía una rama móvil en dos jobs | SHA congelado, validación previa, guardas exactas, evidencia y aprobación expresa para producción |

## Pruebas locales verificadas

- TypeScript: `npm run typecheck` sin errores.
- `test-supabase-target.cjs`: referencias exactas, URL HTTPS, contradicción URL/ref, cruces WMS/TMS y entorno equivocado.
- `test-wms-capacitor.cjs`: configuración efectiva de ambos sabores móviles; WMS usa su dominio, TMS conserva host, identidad e inicio. No certifica instalación de un APK.
- `test-app-session.cjs`: regresiones TMS/operativos y WMS bloqueando rutas/API TMS antes de leer perfiles.
- `test-wh-wms.cjs`: 52 guardas estructurales. Son pruebas de presencia de contratos de implementación; no sustituyen pruebas funcionales.
- `test-wms-receipt-excel.cjs`: XLSX real, hoja/columnas, columna Z, ceros iniciales, hash y entradas inválidas. Las tres copias disponibles de entrada.xlsx tienen 189 filas válidas cada una y cero clientes detectados. No se importaron en una base remota.
- `test-wms-receipt-transactions.cjs`: ejecuta tablas y cuerpos RPC reales en PGlite (motor PostgreSQL descartable). Importación idéntica, rechazo atómico, diferencias, 900=8×100+75+25, diez códigos únicos, reintentos, revisión obsoleta, RLS de lectura por sitio, denegación anónima/escritura directa, confirmación/reimpresión e inyección de fallo a mitad del lote. No es una prueba de concurrencia de dos servidores remotos.
- `test-wms-print.cjs`: JSX y CSS reales de vista previa, Chromium y pdfinfo/pdftotext: una etiqueta produce una página 432×288 puntos; diez etiquetas producen diez páginas. Código de barras presente y cantidad negra/negrita; no certifica escáner ni impresora física.
- ESLint sobre archivos WMS/proxy/config modificados: sin errores tras corregir efectos; quedan advertencias por imágenes de etiqueta y otras advertencias de navegación/imagen existentes en componentes compartidos.

Las pruebas usan fixtures exclusivamente en motores y navegador locales de prueba. No generan recepciones ficticias en Producción. Los artefactos PDF e imagen se generan en `artifacts/wms-audit/` y el workflow los conserva como evidencia.

## Separación efectiva

JRM_APP=wms-staging|wms-production activa la guarda de #485 y el modo de rutas WMS en Next. Producción sólo admite `glecgvomkaqmkfkhtxhi`; Staging sólo `rquujukgtturdlkuzgdc`. Las variables públicas se derivan de JRM_APP y no se depende de una segunda bandera que pueda omitirse. Las API TMS no están disponibles en el sitio WMS; sólo GET app-version queda permitido. Los proyectos Vercel deben ser exclusivos, sin integración Git que salte el pipeline. No se cambia ninguna variable del proyecto jrm-tms.

Las consultas de contratos en SQL son consultas al catálogo local de la base WMS, no una conexión automática a TMS. No existe todavía sincronización en vivo TMS→WMS validada. La primera fase puede recibir cliente desde Excel o captura manual auditada. No se afirma que Despacho reciba solicitudes nuevas de TMS sin esa integración.

## Directorios de migración separados

Las trece migraciones WMS existentes se trasladan sin cambiar su contenido a `supabase/wms/migrations/`, conservando nombres y versiones; la nueva migración también vive allí. El directorio `supabase/migrations/` utilizado por TMS no contiene migraciones WMS. El preparador WMS copia temporalmente sus archivos al plan del runner sólo después de validar app y proyecto WMS, rechaza colisiones de versiones y no sobrescribe archivos distintos. Las pruebas verifican que TMS y proyectos erróneos se rechazan antes de copiar. Las barreras C55 de las tablas WMS se siguen verificando mediante `check-wms-migrations.cjs`, no se omiten por moverlas de directorio.

También se evita servir páginas WMS en el sitio TMS: se rechazan antes de abrir su cliente Supabase. El inventario `/apt` de TMS conserva su enrutamiento de master; no se redirige a WMS. Esto corrige una diferencia de la rama funcional respecto de Producción y tiene regresión explícita.

## Migración y recuperación

La nueva migración `20261226150000_wms_receipt_transaction_integrity.sql` agrega snapshots, secuencia y RPC; conserva códigos y cantidades ya emitidos. Requiere el esquema WMS anterior. No se ha aplicado en Producción. El runner Supabase conserva el historial; no ejecutar el SQL manualmente sin revisar el plan. El workflow comprueba destino y configuración Vercel antes de migrar, instala sólo pendientes en la base WMS verificada y despliega el mismo SHA validado.

El historial completo existente incluye tablas/funciones de compatibilidad y tareas programadas locales. No hay evidencias de enlaces HTTP/dblink a la base TMS en esas migraciones, pero el bootstrap completo de una base vacía debe validarse en un entorno descartable o Staging antes de autorizar Producción. No se sustituye por una copia de datos de TMS.

Ante fallo transaccional, se conserva el estado anterior. Ante fallo de despliegue, mantener el deployment WMS previo; no revertir cantidades ni borrar eventos. Antes de Producción deben confirmarse un respaldo de WMS y su restauración en una base aislada, con un punto temporal y responsable identificados. La disponibilidad real de backups y la restauración no se verificaron todavía. No usar una restauración sobre TMS ni `supabase db reset` sobre bases remotas.

## Criterio de entrega

No declarar Staging validado por un build o smoke HTTP. Faltan inicio de sesión con cuenta WMS real, importación operativa autorizada, confirmación física, prueba de dispositivo/Windows y regresión remota. El workflow conserva por separado el smoke de despliegue del mismo SHA y exige aprobación expresa y evidencia Staging antes de habilitar Producción. La aprobación no debe otorgarse hasta completar todas las pruebas y recuperación pendientes.

## Resultado de esta ejecución (A–F)

### A. Resultado ejecutivo

Implementación y pruebas automatizadas completadas en PR #486, candidata `61e8f6ef41c355244771b40fab0bdff1f31b1439`, seguida del endurecimiento de secretos exclusivos WMS. No se aplicó una migración remota ni se publicó una nueva versión. TMS no recibió escrituras ni cambios de configuración. La separación, recepción transaccional y correcciones de impresión quedan disponibles para revisión.

### B. Antes y después

Las diferencias por componente y evidencia constan en la matriz anterior. La validación remota de CI ahora confirma también compilación completa Next, TypeScript, ESLint, pruebas PostgreSQL descartables y PDFs. No equivale a validación operativa del entorno Staging.

### C. Entrega revisable

PR: https://github.com/CPetit2025/JRM-TMS/pull/486, base `feature/warehouse-wms-portal`. Las migraciones WMS están separadas físicamente; el workflow de Producción TMS no se modifica. Manual: `docs/manual-wms.md`. Procedimiento: `docs/despliegue-wms.md`.

### D. Verificación ejecutada

CI https://github.com/CPetit2025/JRM-TMS/actions/runs/42370488304 y https://github.com/CPetit2025/JRM-TMS/actions/runs/42370520012: todos los pasos exitosos, incluido `npm run build` y publicación de artefactos PDF. Pruebas y límites descritos arriba. Faltan prueba remota autenticada, concurrencia entre sesiones reales, bootstrap completo, equipo Windows, impresora/escáner y recuperación de respaldo.

### E. Dependencias externas concretas

El preflight https://github.com/CPetit2025/JRM-TMS/actions/runs/42370488275 detuvo el flujo; validación dependiente, migración y despliegue fueron omitidos. La auditoría https://github.com/CPetit2025/JRM-TMS/actions/runs/42370488336 encontró HTTP 403 en acceso Supabase y ausencia de configuración dedicada Vercel; Producción carecía de referencia configurada. Se sustituyen nombres genéricos por exclusivos WMS para evitar heredar credenciales TMS del repositorio. Los valores anteriores presentes no prueban que existan credenciales exclusivas WMS.

Responsable: administrador de Supabase/Vercel/GitHub. En cada environment `wms-staging` y `wms-production`, configurar secretos `WMS_SUPABASE_ACCESS_TOKEN`, `WMS_SUPABASE_DB_PASSWORD`, `WMS_VERCEL_TOKEN`; variables `WMS_VERCEL_PROJECT_ID`, `WMS_VERCEL_ORG_ID` y `SUPABASE_PROJECT_REF`. Esta última debe ser `rquujukgtturdlkuzgdc` en Staging y `glecgvomkaqmkfkhtxhi` en Producción. Tokens deben autorizar únicamente su proyecto WMS; no reemplazar secretos TMS. Configurar los proyectos dedicados Vercel sin despliegue Git automático y con su propia URL y claves Supabase. No publicar secretos en mensajes ni logs.

Tras completar acceso, ejecutar primero Staging con el SHA revisado y realizar prueba operativa autorizada. Antes de Producción: respaldo/restore verificado, evidencia Staging del mismo SHA y nueva aprobación expresa. No se solicita esa aprobación mientras falte esta evidencia. La sincronización TMS→WMS y la producción del Excel desde ERP siguen siendo dependencias de integración explícitas, no funciones declaradas como entregadas.

### F. Estado único

**EN DESARROLLO**: candidata compila y supera pruebas automatizadas; instalación e integración operativa remotas pendientes. No se declara Staging validado ni Producción desplegada.
