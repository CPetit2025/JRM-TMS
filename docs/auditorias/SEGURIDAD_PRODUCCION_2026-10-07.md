# Inspección de seguridad, integridad y rendimiento — 07/10/2026

La inspección utiliza el catálogo y contadores de la base real, además de pruebas adversarias reproducibles. Tener RLS activado no garantiza que una política, vista o función autorice correctamente. Este informe registra hallazgos demostrados y el alcance de las correcciones; no certifica seguridad absoluta.

## Evidencia y alcance

Diagnóstico de solo lectura: [Actions 37621743633](https://github.com/CPetit2025/JRM-TMS/actions/runs/37621743633). Se revisaron 164 tablas, 518 funciones, 40 vistas, 315 claves foráneas, 350 índices y las políticas de almacenamiento. No se descargaron documentos, contraseñas ni filas de negocio. Las definiciones seleccionadas de funciones del grupo A tienen un límite de 12.000 caracteres; el inventario de permisos comprende todas las funciones. No se modificaron registros operativos durante el diagnóstico.

## Hallazgos y correcciones

| Hallazgo confirmado | Corrección |
| --- | --- |
| 164 tablas con RLS, pero políticas permisivas de lectura/escritura en diez tablas | Reglas por módulo, usuario, sede y relación principal; separación entre registro de horas y validación del supervisor. |
| 112 tablas conservaban permisos de lectura de tabla para `anon`; RLS todavía impedía muchas lecturas | Revocación de permisos innecesarios. Excepciones explícitas: versión publicada y columnas públicas de identificación de transportistas activos. |
| Cinco vistas consultables por usuarios ejecutaban como propietario y podían omitir RLS; otras dos vistas de propietario no tenían acceso de aplicación | Vistas con `security_invoker`. Se conservan tres proyecciones de Caja con barreras explícitas de módulo/sede. |
| Siete RPC privilegiados accesibles anónimamente sin necesidad del flujo público | Acceso anónimo reservado a tres consultas de seguimiento con token/PIN; revocación de invocación directa de triggers. `search_path` fijo en funciones privilegiadas. |
| RPC de checklist posterior confiaba en el conductor suministrado y persistía cambios aunque una transición fallara | Identidad/unidad/ruta verificadas en servidor y transacción completamente revertida ante rechazo. Odómetro vinculado al usuario y esquema real. |
| Permisos `TRUNCATE`/`TRIGGER` excedían lo que controla RLS | Revocación para roles de aplicación. Cuentas inactivas bloqueadas mediante políticas restrictivas, incluso con JWT conservado. |
| Buckets `evidence` y `signatures` públicos, sin límites de tipo/tamaño | Buckets privados, límites y enlaces firmados de 120 segundos usando la sesión del solicitante. No se utiliza service-role para firmar archivos. |
| Registro público sin cuota durable y administración de usuarios con autorización insuficiente para asignar roles | Cuota persistente por huella HMAC de dirección de red confiable; fallo cerrado; creación administrativa exclusiva del administrador activo. Registro público conserva perfiles inactivos sin roles privilegiados. |
| Proxy SUNAT y generación de plantillas sin comprobación de módulo | Sesión activa, permiso de módulo, entrada acotada y timeout de consulta externa. |
| 28 vínculos operativos sin clave foránea; 243 claves foráneas iniciales sin índice de cobertura | Claves foráneas verificadas y validadas; índices de columnas hijas reutilizando cobertura existente. La migración se detiene ante referencias huérfanas; no borra ni reasigna datos. |
| Dependencias de producción con alertas, incluida una crítica de Next.js y alertas del lector Excel | Next.js 16.3.6, Sharp 0.35.5, lector XLSX 0.20.3 y dependencias transitivas corregidas y fijadas en lockfile. |

Los tres RPC públicos de seguimiento permanecen habilitados para conservar el proceso de transportistas. Los instaladores APK son intencionalmente públicos; las guías, packing lists, recibos, evidencias y firmas permanecen privados.

## Relaciones y tablas históricas

Las 315 claves foráneas y 38 vínculos operativos adicionales no presentaron referencias huérfanas. Se encontraron **11 perfiles sin fila en `auth.users`**. Son registros históricos, no cuentas con acceso: se conservan para mantener referencias y auditoría. Su reconciliación requiere determinar qué personas necesitan cuenta vigente, sin eliminar perfiles ni reasignar autorías automáticamente.

Las columnas `_id` sin FK no representan siempre relaciones pendientes: también incluyen identificadores de dispositivo, operación idempotente y datos derivados de APT. No se eliminaron tablas por estar vacías ni se añadieron restricciones arbitrarias a cachés derivadas. Las nuevas FK impiden eliminar físicamente entidades que siguen referenciadas; las bajas operativas deben conservar el historial.

## Dependencias y compatibilidad Excel

`npm audit --omit=dev` queda sin alertas conocidas. La auditoría completa conserva cinco entradas de severidad alta, todas en la cadena de desarrollo de ESLint (`braces` 3.0.3 y consumidores). Al inspeccionar el registro no existe una versión publicada de `braces` que corrija el aviso GHSA-vfj7-8cjw-p6xm. No se fuerza una versión inexistente ni una actualización incompatible. Estas entradas no pertenecen al despliegue de producción; quedan pendientes de actualización del proveedor.

El paquete npm `xlsx` antiguo se sustituye por el alias exacto `npm:@e965/xlsx@0.20.3`. Es una **redistribución no oficial** del lector SheetJS, con versión e integridad fijadas en `package-lock.json`; el CDN oficial no fue accesible desde el entorno. Se verificaron procedencia publicada y compatibilidad mediante lectura real de XLS/XLSX, exportación ExcelJS y fechas en UTC, Lima y Nueva York, incluidos libros con época 1904. Se corrigió la compensación de fecha que el lector antiguo necesitaba y que el nuevo lector ya resuelve.

## Validación reproducible

- `scripts/test-production-security.cjs`: PostgreSQL 16 con las 164 tablas y columnas del esquema observado, sin datos reales. Reproduce filtración de vista, escritura no autorizada y mutación anónima del checklist antes de aplicar la corrección. Verifica denegaciones, acceso legítimo al odómetro propio, rollback, privacidad de archivos, cuotas, FK y reutilización de índices. La réplica de metadatos no reproduce cada restricción histórica de producción.
- `scripts/test-security-api.cjs`: cinco pruebas de permisos administrativos, cuota durable, dirección de red confiable, registro de conductor y enlaces de archivos privados.
- `scripts/test-security-workbooks.cjs`: importación/exportación real, pesos y fechas en tres zonas horarias, formatos XLS/XLSX y época 1904; compatibilidad del generador nativo Xcode.
- Regresiones existentes: solicitudes/modalidad/80%, conformidad y documentos, sesiones del app, APT y formato oficial FR-DT 007.
- TypeScript, compilación Next y guardas de publicación. Lint de archivos modificados sin errores nuevos; el repositorio conserva deuda de lint previa y no se declara limpio globalmente.
- `supabase/tests/caja_c55_seguridad_produccion.test.sql`: verifica permisos, vistas, funciones, cuentas inactivas, privacidad de buckets, cobertura de índices y denegación de suplantación en el esquema real. Termina con excepción `CAJA C55 PASS` para revertir todas las pruebas.

El workflow de producción aplica las migraciones nuevas, ejecuta todas las pruebas SQL de Caja y solo entonces solicita Vercel. Tras la publicación se repite la inspección mediante `Deploy production` con `audit_only=true`; este modo no aplica migraciones ni despliega. El resultado final del despliegue y de esa segunda inspección se registra en el PR y en Actions.

## Rendimiento y límites

La corrección cubre índices de relaciones, comprobación de cuenta activa mediante initplan (una evaluación por consulta), límites de entrada/archivos, cuotas persistentes y timeouts. No hay evidencia de filas operativas huérfanas que exijan una limpieza destructiva. Los índices aumentan almacenamiento y costo de escritura a cambio de reducir búsquedas y bloqueos de integridad; se evita duplicarlos y se limita la espera por locks.

No se ejecutó una prueba de carga masiva sobre producción ni una restauración de backups. Los índices no garantizan por sí solos ausencia de bloqueos o tiempos máximos: el dimensionamiento bajo concurrencia requiere medir las operaciones representativas. Esta inspección tampoco equivale a un pentest completo independiente de todos los flujos del sistema.

## Segunda inspección de la base real

[Actions 37628887395](https://github.com/CPetit2025/JRM-TMS/actions/runs/37628887395), después de aplicar las migraciones: **165/165 tablas con RLS**, **343 FK validadas**, **cero FK sin cobertura de índice**, **611 índices** (350 antes), **37 vistas invoker** y tres proyecciones de Caja con barreras explícitas. Solo los tres RPC de seguimiento conservan acceso anónimo privilegiado. La única lectura anónima de tabla completa es la versión publicada; transportistas conserva únicamente columnas públicas autorizadas. Los buckets privados y los contadores de documentos quedaron verificados; no se borraron archivos. No aparecen huérfanos operativos y los 11 perfiles históricos permanecen sin cambios.

La primera ejecución del conjunto SQL detectó que sus ayudantes temporales dependían del permiso PUBLIC por defecto, ahora revocado. Se corrigieron los tests con permisos explícitos para funciones de `pg_temp`, locales a cada transacción. La prueba adversaria verifica tanto la denegación sin ese permiso como su ejecución con el permiso explícito. No se restaura acceso público a funciones de producción ni se modifica ninguna migración ya aplicada. El despliegue web queda condicionado a que el conjunto completo pase tras esa corrección.
