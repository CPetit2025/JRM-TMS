# HHEE — flujo simplificado

Control de horas extras de Distribución en tres ventanas (menú **Control de horas extras**):

| Ventana | Ruta | Quién |
|---|---|---|
| Solicitudes y aprobación | `/hhee/solicitudes` | Supervisor de Transporte / Despacho solicita; Jefe de Distribución o Administrador aprueba |
| Personal y tarifas | `/hhee/personal` | Jefe de Distribución / Administrador (`hhee-config`) |
| Panel gerencial | `/hhee` | Aprobadores y gerencia (`hhee-gerencia`) |
| Áreas, accesos y causas | `/hhee/configuracion` | `hhee-config` |

Las ventanas antiguas (RR. HH., validación, acciones correctivas, aprobaciones, reportes) redirigen al flujo nuevo;
su historial se conserva en la base.

## 1. Personal (alta con cálculo en vivo)

Ficha: código, nombres, documento, cargo, área, jornada de referencia (horas diarias y divisor mensual
**confirmado**), conceptos remunerativos (marcando cuáles son computables) y fecha de vigencia.

- Valor hora base = suma de conceptos computables ÷ divisor mensual. Tarifas 25 % / 35 % / 100 % = base × 1,25 / 1,35 / 2.
- Si falta el divisor confirmado o no hay conceptos computables: **Costo pendiente: completar ficha**.
- Importación desde Excel (plantilla descargable, hasta 500 filas, detecta código y documento duplicados).
- Cada cambio remunerativo queda en el historial (`hhee_people_history`). Las solicitudes ya aprobadas conservan la
  tarifa usada (`hhee_lines.plan_rate`, `plan_cost`).

### Personal unificado por DNI (migración `20261021080000_personal_unificado_placa_hhee.sql`)

- Un DNI = una persona. La ficha con el DNI de un conductor se **enlaza a Flota** (`hhee_people.driver_id`) y toma de
  allí nombre y DNI. Las demás fichas toman nombre y DNI de **Maestros → Trabajadores** (`profile_id`).
- Si se corrigen en Flota o en Maestros, la ficha se actualiza sola (triggers que nunca bloquean la edición en Flota).
  En la ficha esos campos quedan de solo lectura e indican de dónde vienen.
- La remuneración sigue solo en Personal (HHEE).
- Botón **Unificar con Flota**: diagnóstico por DNI (conductores sin ficha, DNI que coincide sin enlace, DNI repetido en
  Flota, fichas sin DNI), «Enlazar por DNI y actualizar datos» y «Crear fichas» para los conductores activos que no
  tienen (cargo Conductor, costo pendiente hasta completar la remuneración).

### Rutas: auxiliar y horas extras automáticas (migración `20261021100000_rutas_auxiliar_hhee_automatica.sql`)

- **Armar ruta → Unidad y conductor:** auxiliar opcional, elegido de **Personal (/hhee/personal)**: fichas activas,
  tengan o no usuario en el sistema; con «Incluir conductores disponibles» se suman las fichas enlazadas a Flota. No
  aparecen quienes ya conducen, acompañan o van de auxiliar en otra ruta activa (`list_route_assistants`,
  migración `20261021140000_auxiliar_desde_personal.sql`). Se pueden agregar **hasta 6 auxiliares** por ruta (cada uno
  se quita con «×»); se guardan con `set_route_auxiliaries` en `route_auxiliaries` (migración
  `20261021150000_varios_auxiliares.sql`) y los que tienen usuario también como tripulación AUXILIAR. Todos entran en
  la solicitud automática de horas extras de la ruta.
- **Fecha programada de salida:** al elegir servicios con una sola fecha requerida, se completa sola con esa fecha a
  las 08:00 (se ajusta la hora); si se cambia a mano, ya no se reemplaza.
- **Horario ordinario** (`hhee_settings`): lunes a viernes hasta las 17:30, sábado hasta las 13:30. Domingo y feriado:
  todo el tiempo de ruta, al 100 %.
- **Solicitud automática:** cada 10 minutos (pg_cron `hhee-rutas-fuera-de-horario`) las rutas de flota propia que siguen
  en curso pasado el horario generan una sola solicitud en borrador con el conductor y la tripulación que viaja
  (auxiliar / ayudante), la placa de la ruta, inicio al fin del horario y fin estimado (la siguiente hora en punto).
  El supervisor que programó la ruta recibe el aviso, completa actividad, por qué, alternativa y resultado (vienen
  «PENDIENTE»; no se puede presentar sin completarlos), ajusta la hora de fin y la presenta. Quien no tiene ficha de
  personal recibe una con costo pendiente. Las horas extras de otras actividades siguen siendo manuales.

### Cierre de las horas extras de ruta y compensación (migración `20261021110000_hhee_cierre_ruta_compensacion.sql`)

- **Aviso:** al aprobarse, el conductor y el auxiliar (si tiene usuario) reciben la notificación «Horas extras aprobadas»
  con enlace a **App → Inicio → Mis horas extras** (`/app/hhee`). El aviso push al teléfono queda para una etapa posterior.
- **Cierre manual:** solo el conductor cierra desde el app («Terminé · cerrar horas extras»); al cerrar las suyas se cierran
  las de toda la tripulación de esa solicitud. El auxiliar las ve, pero no las cierra.
- **Cierre por geocerca:** con horas extras abiertas, cada posición del conductor (puntos de la ruta, posición del app y el GPS
  nativo, que sigue activo aunque la ruta ya se haya cerrado) se compara con las **bases**: geocercas activas de tipo
  *CEDI / Almacén*, *Depósito* o *Cochera* (o cuyo nombre diga CEDI, cochera, almacén o depósito), creadas en
  **Configuración → Ubicaciones**. Cierra a la hora en que la unidad **sale** de una base en la que **entró** después de
  empezadas las horas extras; si ya estaba dentro al empezar, salir no cierra. Sin geocercas de base se usan los locales
  autorizados (radio).
- **Registro del supervisor:** en el detalle de la solicitud (tarjeta «Ejecutado»), el supervisor que la registró o el aprobador
  indica la hora real de fin y el motivo cuando el app no cerró.
- **Ejecutado:** por trabajador, hora real de fin, minutos ejecutados y su reparto legal (25 / 35 / 100 %), quién cerró y el costo
  ejecutado. El panel muestra horas ejecutadas frente a las autorizadas, abiertas y tipo de cierre.
- **Compensación (D.S. 007-2002-TR art. 10):** el aprobador o quien administra el personal elige por línea «Pago» o
  «Compensar con descanso». Las compensadas no tienen costo en dinero y suman a la **bolsa de horas** del trabajador
  (columna en Personal). Los descansos tomados se registran en la bolsa (no pueden superar el saldo) y se pueden anular.

## 2. Solicitud y aprobación

**Conductores — placa de la ruta.** Al elegir a un conductor, la placa sale de su ruta asignada en Despacho para esa
fecha (una ruta: automática; varias: se elige). Si no tiene ruta o usó otra unidad, se indica la placa (opcional) y el
**motivo** (obligatorio). La placa, la ruta y el motivo quedan en el informe, el correo y el consolidado.


1. El supervisor registra fecha, área, causa, actividad, por qué se necesita, alternativa evaluada y resultado
   esperado; agrega trabajadores con hora de inicio, fin y descanso. **Las horas por recargo se calculan solas**
   (ver «Cálculo legal»); el formulario muestra el resultado del servidor antes de guardar.
2. **Presentar para aprobación**.
3. El aprobador **aprueba**, **observa** (vuelve al supervisor para corregir) o **rechaza**, siempre con sustento.
   Nadie aprueba su propia solicitud (salvo Administrador). Si la ficha de un trabajador cambió durante la revisión,
   el sistema avisa que el costo cambió y pide confirmar de nuevo.
4. Al aprobar se guarda una **versión del informe** (`hhee_authorizations`) y se habilitan:
   - **PDF de autorización** (por qué, quiénes, cuántas horas, firmas).
   - **Correo** con vista previa editable (Gmail, Outlook o programa de correo).
   Ni el PDF compartido ni el correo incluyen conceptos remunerativos.
5. Modificar una solicitud aprobada la devuelve a aprobación; la nueva aprobación genera la versión 2, 3…

### Cálculo legal (migración `20261021070000_hhee_calculo_legal_consolidado.sql`)

- Horas extras de cada trabajador = horario − descanso.
- D.S. 007-2002-TR (TUO de la Ley de Jornada) art. 10: las **primeras 2 h extra del día** con 25 % y las siguientes con
  35 %. Las 2 h se cuentan **por trabajador y por día**, sumando sus solicitudes del mismo día registradas antes (no
  anuladas ni rechazadas).
- D. Leg. 713: trabajo en **feriado nacional** o en el **día de descanso** del trabajador (casilla «Su día de descanso»)
  con 100 %. Los feriados se reconocen solos (`hhee_pe_holiday`, con Jueves y Viernes Santo según la Pascua).
- Al aprobar, el reparto se vuelve a calcular (otra solicitud del día pudo anularse) y con él el costo; si el monto
  cambió, se pide confirmar.

### Informe consolidado

En la lista, marque solicitudes aprobadas (use «Aprobadas» y el rango de fechas) y pulse **Informe consolidado**: un
solo PDF horizontal con las autorizaciones incluidas, el detalle por trabajador y día, el resumen por trabajador
(DNI, cargo, días, horas 25/35/100 %, total y costo si corresponde) y el resumen por causa, más el correo. Toma la
versión vigente de cada autorización.

Los informes (individual y consolidado) incluyen los datos del trabajador (código, nombre, DNI, cargo, día de descanso),
el tipo de día, las horas por recargo, los totales y la base legal del cálculo.

## 3. Panel gerencial

Horas y costo aproximado **autorizados** (no son horas trabajadas ni costo de planilla). Filtros por período,
área, causa, supervisor y trabajador. Incluye evolución, recargos, Pareto de causas, causas por mes, supervisores,
día de la semana, trabajadores recurrentes y exportación a Excel.

## Permisos aplicados por la migración `20261021050000_hhee_flujo_simple.sql`

- Supervisor de Transporte / Despacho: `hhee-solicitar:write`, `hhee:read`.
- Jefe de Distribución: `hhee-aprobar:write`, `hhee-gerencia:read`, `hhee-costos:read`, `hhee-config:write`, `hhee:read`.
- Los usuarios activos con esos roles quedan como miembros del área Distribución.
- Quien solo solicita no ve tarifas ni costos.

Pruebas: `supabase/tests/caja_c125_hhee_flujo_simple.test.sql` (C125) , `caja_c126_hhee_calculo_legal.test.sql` (C126) `caja_c127_personal_unificado_placa.test.sql` (C127) `caja_c128_rutas_auxiliar_hhee_auto.test.sql` (C128) `caja_c129_hhee_cierre_ruta_compensacion.test.sql` (C129) `caja_c130_auxiliar_desde_personal.test.sql` (C130) y `caja_c131_varios_auxiliares.test.sql` (C131).
