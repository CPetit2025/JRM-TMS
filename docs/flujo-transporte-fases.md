# Flujo de transporte JRM TMS

## Circuito y responsabilidades

Solicitud de Transporte → Programación y Ruteo → Documentos de salida → Ejecución → Conformidad de entrega → Cierre y Registro de Servicios.

La Torre de Control supervisa transversalmente. El portal de seguimiento es de lectura; el portal del transportista y la app reciben evidencia de destino. Ninguna carga de guía por sí sola equivale a conformidad aprobada.

| Frente | Responsable y alcance |
| --- | --- |
| Solicitudes | Solicitante; modalidad, tipo de servicio, OT según área, fecha y hora solicitadas. |
| Programación y Ruteo | Supervisor de Transporte; recursos, orden de paradas, programación y distribución de flete. |
| Documentos previos a salida | Auditor registra Packing List firmado; Asistente verifica documentos y Nota de Despacho cuando corresponde. |
| Evidencia de entrega | Conductor/proveedor presenta guía firmada en destino; Supervisor valida, observa o rechaza. |
| Torre de Control | Seguimiento operativo, GPS, incidencias y accesos al servicio/documentos. |
| Registro de Servicios | Compromisos, realizados y anulados; partidas y regularización trazable de vínculos. |

Una ruta admite varias OT y tipos de servicio. Se conservan exclusividad conductor–unidad, recojo por cliente sin flete/GPS JRM, historial de reprogramación y versiones documentales. El estado operativo, documental y económico tiene significado distinto.

## Fases

1. Reglas comunes e identidad solicitud/ruta/parada/OT/documento/cargo.
2. Anticipación obligatoria de entregas y configuración por zona.
3. Programación con fechas solicitadas/programadas separadas e historial.
4. Centro documental con vista del Auditor y conformidad posterior a entrega.
5. Portal permanente controlado, calendario y tabla de solicitudes.
6. Registro económico: comprometido/realizado/anulado, regularización atómica e idempotente.
7. Validación de permisos, SQL, interfaces y compatibilidad antes de publicar.

## Anticipación mínima

El plazo se cuenta desde el registro real, según el servidor, en horas continuas; los horarios visibles se expresan en `America/Lima`. Valores iniciales: Lima 24 horas, provincia 48 y exterior 72. Configuración permite modificar o desactivar reglas globalmente o por zona.

Ejemplo: registrado el 07/10/2026 a las 17:45 para Lima, la primera entrega válida es el 08/10/2026 a las 17:45. La entrega a las 08:00 se bloquea y debe indicar la primera fecha permitida. La validación del navegador no sustituye la validación SQL.

Editar, aprobar o asignar ruta no reinicia el reloj. Cada solicitud conserva su regla original; cambiar configuración no impone silenciosamente reglas nuevas a solicitudes antiguas. Los históricos sin hora/snapshot quedan sin evaluación precisa, nunca se les inventa cumplimiento. La validación diferencia nuevas entregas de solicitudes antiguas y de otros tipos/modalidades a los que no aplica la regla.

## Accesos externos

El seguimiento permanente requiere token y código, con alcance definido por sede y OT, revocación y rotación de clave. Solo devuelve la proyección pública; no entrega precios ni rutas privadas de evidencias. Las credenciales anteriores conservan su fecha y vencimiento original.

El transportista mantiene su acceso separado para guía firmada. Al presentar sustento se bloquea la corrección del servicio hasta observación/rechazo; puede continuar las demás entregas autorizadas pendientes. La aprobación sigue a cargo del Supervisor.

## Presupuesto y cierre

Disponibilidad operativa = 80 % de partida bruta − reservas − consumos. Al cerrar, reserva pasa a consumo una sola vez. Restaurar el vínculo entre un flete existente y su despacho no consume ni reserva nuevamente; los casos ambiguos deben revisarse, no crear cargos a ciegas.

Un flete comprometido no acredita un servicio realizado. La vista económica distingue cargo manual, compromiso, realización y anulación, manteniendo la trazabilidad de OT/parada. El saldo actual no se presenta como saldo histórico de cada movimiento.

## Validación reproducible

- `node scripts/test-transport-flow-sql.cjs`: contenedor PostgreSQL 16 desechable; reutiliza los escenarios históricos de transporte y aplica migraciones del flujo con pruebas SQL nuevas. No conecta a producción.
- `node scripts/test-transport-flow-browser.cjs` y `node scripts/test-transport-flow-dashboards.cjs`: navegador Chromium real, escritorio/móvil; el portal intercepta todas las consultas con datos sintéticos. Los dashboards requieren el servidor de prueba descrito abajo.
- `node scripts/test-production-security.cjs`: regresión adversarial de RLS, identidad, funciones y relaciones usando forma de tablas observada en producción.
- Pruebas SQL `caja_c56_*`, `caja_c57_*`, `caja_c58_*` y siguientes: validaciones nuevas por fase, con rollback al terminar.
- `npm run check:guards`, `npm run typecheck`, lint de archivos intervenidos y `npm run build`: validación de integración coordinada.

El arnés local de transporte reproduce restricciones operativas importantes, pero no sustituye todas las restricciones históricas ni todas las pruebas de Caja de la base desplegada. El workflow debe aplicar migraciones y ejecutar la suite SQL completa antes de solicitar el despliegue de Vercel. No se borran tablas, documentos históricos ni enlaces anteriores.

### Revisión posterior a la publicación

La auditoría de solo lectura de la versión `f2780d1` ([ejecución 37714047975](https://github.com/CPetit2025/JRM-TMS/actions/runs/37714047975)) verificó RLS en las 168 tablas, claves foráneas validadas e indexadas y ausencia de índices inválidos. Las tablas nuevas del portal y los plazos no conceden acceso anónimo directo. Los cuatro RPC públicos de seguimiento mantienen su acceso por token y código. Las tres vistas sanitizadas de Caja conservan sus filtros explícitos por módulo/sede.

Se revisaron 386 relaciones: las referencias de negocio comprobadas no tienen huérfanos. Hay 11 perfiles sin cuenta en `auth.users`; se conservan sin borrar ni crear cuentas automáticamente, porque el catálogo no determina su finalidad ni los registros que necesitan conservarlos.

El acceso delegado a plazos requiere escritura en `configuracion` y muestra únicamente ese formulario; las opciones generales siguen reservadas al administrador. El Registro de Servicios admite también el permiso histórico `clientes`, igual que sus RPC, conservando los controles de sede, OT y escritura en el servidor.

### Navegador local sin credenciales de producción

Iniciar `node scripts/test-transport-flow-fixture.cjs` (Supabase sintético en 127.0.0.1:3019). Compilar con `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3019 NEXT_PUBLIC_SUPABASE_ANON_KEY=fixture-public SUPABASE_SERVICE_ROLE_KEY=fixture-service npm run build`, iniciar `npm run start -- --port 3020` y ejecutar las dos pruebas de navegador. Las claves citadas son cadenas sintéticas de prueba, no credenciales de producción. Los artefactos visuales se guardan en `/tmp/transport-flow-screenshots`.

Playwright se resuelve desde el runtime del entorno; otro entorno puede proporcionar `PLAYWRIGHT_MODULE`. El origen local puede indicarse con `TRANSPORT_FLOW_ORIGIN`; no debe apuntarse a producción para pruebas con sesiones sintéticas. La prueba del portal comprueba revocación y la tabla de anticipación; la de dashboards comprueba renderizado SSR, ausencia de desbordamiento y bloqueo del formulario. Las acciones completas y sus permisos se prueban en SQL, no se simula su aprobación como evidencia de funcionamiento real.
