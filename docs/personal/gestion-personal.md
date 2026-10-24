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
6. Aplicar y desplegar mediante el flujo del proyecto después de revisión. Este trabajo no aplica SQL ni despliega producción. No revertir tablas con movimientos: conservarlas y corregir mediante migraciones posteriores auditadas.
## Configuración confirmada para octubre de 2026

- Base común: lunes a viernes 08:00–17:30; sábado 08:00–13:30; refrigerio de 60 minutos. Domingo como descanso base, con trabajo mediante HHEE planificada.
- Ustedes seleccionan/asignan colaboradores según capacidad operativa. La pantalla Horarios ofrece una plantilla de base y guardado por selección explícita, con fecha revisable. No asigna automáticamente personas ni sobrescribe historia incompatible.
- Turnos operativos informados: lunes a viernes 07:00–19:00 / 19:00–07:00; sábado 07:00–13:00 / 13:00–19:00. **No deben guardarse como jornada ordinaria**: la regla acordada considera HHEE solo los tramos fuera de la base común.
- La solicitud automática de rutas calcula el tramo posterior al fin ordinario. La planificación completa de jornadas con tramos separados antes y después, refrigerio en una franja concreta y cruce de medianoche necesita tratar cada intervalo expresamente; no se debe cargar toda la jornada de 12 horas como HHEE ni asumir que este generador ya cubre el ingreso anticipado.
