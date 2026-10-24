# Gestión de Personal — implementación y puesta en marcha

La URL raíz sigue siendo `/hhee` para conservar enlaces. El módulo muestra Inicio, Lista de Personal, Horarios, Asistencia, Permisos y compensaciones, Solicitud de HHEE y Reportes y analítica.

## Datos y reglas

- **Padrón**: reutiliza `hhee_people` y sus vínculos existentes con Flota/Maestros. No crea una segunda tabla de colaboradores. La programación exige personal activo y acceso al área.
- **Horario**: fijo con siete días explícitos y vigencia versionada; rotativo mediante programación diaria. Se admiten turnos que cruzan medianoche. No se deduce un turno cuando falta programación. Los turnos vinculados a asistencia confirmada o permisos activos no se reescriben.
- **Asistencia**: cada área/fecha requiere confirmación. Solo se marcan ausentes; los otros programados pasan a ASISTENCIA_DECLARADA. Descansos y permisos completos se distinguen. No representa una marcación biométrica ni permite calcular tardanza. Correcciones con motivo, aprobador y revisión optimista. Se conserva el padrón/turno del día confirmado y el historial de decisiones.
- **Permisos**: duración en minutos contra el turno del día; no se inventa una hora de entrada/salida. PENDIENTE → APROBADO → APLICADO, con rechazo/anulación auditados. Puede regularizar una falta. Un permiso parcial se muestra en minutos; no convierte automáticamente una ausencia de día completo en presencia. Un permiso completo prevalece en la vista/reportes sin borrar la declaración original. Si se anula un permiso que sustentaba la confirmación, se pide revisar la asistencia.
- **Aprobadores**: usuario activo con alcance y permiso de aprobación del área, cuyo rol sea Administrador o Jefe de Distribución. El permiso técnico por sí solo no sustituye el rol. Se conservan los alcances por sede/área.
- **HHEE planificadas**: formulario existente, horario común aplicable al equipo y excepciones por trabajador. Se mantiene aprobación, cierre por app/geocerca/supervisor y causa de la solicitud.
- **HHEE operativas**: reutiliza generador de rutas y su programador existentes, ahora contra el turno individual. Sin horario o salida de ruta no inventa horas. Revisa borradores para agregar tripulantes que terminan su turno más tarde; no modifica solicitudes presentadas/aprobadas automáticamente. Conserva una solicitud automática por ruta y la prevención existente de duplicar trabajador/fecha. Rutas de varios días o cambios después de presentar requieren revisión del supervisor.
- **Validación**: cierre real de todas las líneas y aprobación previa; Administrador/Jefe valida cantidades y destino pago/compensación con sustento. Solo entonces se acredita saldo. No acredita solicitudes, aprobaciones ni cierres sin validar. Las líneas validadas y su destino quedan protegidos contra edición/anulación.
- **Bolsa**: minutos validados para compensar − descansos aplicados activos − permisos compensables aprobados reservados. Aprobar reserva; aplicar consume una vez; anular libera/revierte. Operaciones bloquean al colaborador y verifican revisión para evitar doble uso concurrente.
- **Históricos**: cierres antiguos sin la nueva validación se muestran por separado y no se convierten silenciosamente en saldo. Descansos históricos se conservan. Esto puede producir saldos negativos que requieren conciliación; no se debe eliminar historia para cuadrarlos.
- **Reportes**: HHEE autorizadas/ejecutadas/validadas/compensables por área, causa y origen; saldo actual por persona; asistencia declarada por fecha/área/estado; permisos y eventos. Exportación Excel. Los saldos son actuales e independientes del filtro de fechas. Los nuevos reportes no exponen remuneraciones; el panel gerencial anterior mantiene sus permisos.

## Validación realizada

- `node scripts/test-gestion-personal.cjs`: PostgreSQL aislado PGlite, migración real y funciones HHEE reales con esquema de compatibilidad/datos sintéticos. Cubre horarios, rotación, descansos, turno nocturno, confirmación atómica/versiones, saldo solo tras validar, inmutabilidad, reservas/aplicación/anulación, saldo insuficiente, permisos completos posteriores, generación de rutas sin duplicar e incorporación tardía a borradores, restricción por rol y reportes conciliados.
- `node --test scripts/test-gestion-personal-ui.cjs`: confirmar explícitamente y enviar ausencias; bloqueo de pantalla sin horario.
- Regresión de formulario/búsqueda de trabajadores y pruebas HHEE existentes.
- TypeScript, ESLint de componentes/rutas modificados, guardas y build de Next. El build utiliza valores locales ficticios de Supabase, sin conexión a producción.
- Se adaptan fixtures SQL C125–C132 a roles/horarios explícitos y validación previa al saldo. No se ejecutaron contra una base empresarial completa en esta máquina; dependen de datos auxiliares existentes. Las suites Docker de PostgreSQL deben correr en CI.

## Activación

1. Revisar PR y ejecutar migración en base de pruebas; revisar pantallas con una sesión autorizada y datos representativos. Un frontend de vista previa sin la migración no permite probar las nuevas RPC.
2. Configurar horarios reales, descansos y turnos rotativos del padrón; verificar vínculos con conductores y auxiliares. No hay horario masivo supuesto.
3. Confirmar usuarios Administrador/Jefe de Distribución y sus accesos por área/sede.
4. Conciliar HHEE históricas y descansos existentes; validar únicamente ejecuciones revisadas. Verificar saldos negativos antes de compensar.
5. Comprobar que el cron existente de rutas está habilitado y se ejecuta. El código reutiliza ese mecanismo; no demuestra por sí solo que esté operativo en producción.
6. Aplicar y desplegar mediante el flujo del proyecto después de revisión. El despliegue aplica las migraciones y exige todas las cajas SQL antes de publicar el frontend. No revertir tablas con movimientos: conservarlas y corregir mediante migraciones posteriores auditadas.
## Configuración confirmada para octubre de 2026

- Base común: lunes a viernes 08:00–17:30; sábado 08:00–13:30; refrigerio de 60 minutos. Domingo como descanso base, con trabajo mediante HHEE planificada.
- Ustedes seleccionan/asignan colaboradores según capacidad operativa. La pantalla Horarios ofrece una plantilla de base y guardado por selección explícita, con fecha revisable. No asigna automáticamente personas ni sobrescribe historia incompatible.
- Turnos operativos informados: lunes a viernes 07:00–19:00 / 19:00–07:00; sábado 07:00–13:00 / 13:00–19:00. **No deben guardarse como jornada ordinaria**: la regla acordada considera HHEE solo los tramos fuera de la base común.
- La solicitud automática detecta salida anticipada y extensión posterior. La planificación por tramos excluye la base común, ubica el refrigerio y separa los días al cruzar medianoche. Las propuestas automáticas exigen revisar el refrigerio antes de presentar y las horas reales antes de validar.

## Planificación completa y ejecución por tramos

- En Solicitudes hay plantillas Diurno 07–19, Nocturno 19–07, Sábado 07–13 y Sábado 13–19. Seleccionar no asigna personal: agregue colaboradores y aplique el horario al equipo o ajuste por trabajador. Domingo se planifica con las horas reales; su base es descanso.
- Active «Calcular solo tramos fuera de jornada». Un turno completo requiere ubicar exactamente los 60 minutos de refrigerio. Una extensión corta de ruta permite desmarcar turno completo y justificar si el refrigerio quedó fuera del tramo. Nunca se presume que ese descanso coincide con las HHEE.
- Con refrigerio 13–14: lunes 07–19 contiene 07–08 y 17:30–19 (150 minutos de HHEE). Nocturno 19–07 con refrigerio 01–02 contiene 660 minutos; cada tramo conserva su fecha. Sábado mañana 07–13 con refrigerio 10–11 contiene 60 minutos; sábado tarde 13–19 con refrigerio 16–17 contiene 270. Son ejemplos, no asignaciones reales.
- Se conserva una fotografía de la jornada ordinaria por persona y solicitud. Cambiar horarios después no recalcula silenciosamente lo aprobado. La base y el refrigerio quedan excluidos también en el cierre, los recargos, PDF, borrador de correo y exportación.
- El cierre/corrección por trabajador registra inicio, fin y refrigerio realmente tomados, motivo y versión. La app/geocerca puede aportar un primer cierre; aún se exige revisar esos hechos antes de validar. Los cierres automáticos existentes no se borran al corregir un borrador. Se bloquean solapamientos de planes y de ejecuciones y cambios posteriores a la validación.
- Reportes incluye tramos planificados y ejecutados, causa, área, origen y estado de validación. El filtro HHEE usa la fecha inicial de la solicitud; cada tramo muestra su fecha real. Los tramos no se suman a los agregados como si fueran otra fuente. La bolsa solo acredita minutos efectivamente validados para compensación.
- Rutas: un borrador no revisado se actualiza con la duración estimada mientras sigue en ruta; no se convierte en aprobado ni acredita saldo. Al presentar/aprobar, el supervisor controla cambios posteriores. Se conserva una solicitud automática por ruta y el bloqueo de otra solicitud del trabajador en la misma fecha; jornadas de más de 16 horas o rutas de varios días exigen planificación explícita por fecha. No se inventan continuidades ni se reabren cierres automáticamente.
- Pruebas adicionales: integración PGlite con RPC reales y caja C148 de producción; cubren tramos diurnos/nocturnos, sábado/domingo, recargo por día, refrigerio, versiones, revisión real, congelación de horarios y reportes reconciliados. C128/C129 conservan los escenarios operativos revisando expresamente el refrigerio de sus datos sintéticos.
