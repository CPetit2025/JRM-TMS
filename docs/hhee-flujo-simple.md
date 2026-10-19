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

## 2. Solicitud y aprobación

1. El supervisor registra fecha, área, causa, actividad, por qué se necesita, alternativa evaluada y resultado
   esperado; agrega trabajadores con hora de inicio, fin y descanso. **Repartir** asigna 2 h al 25 % y el resto al
   35 % (o todo al 100 % en día de descanso o feriado). El total no puede exceder el horario menos el descanso.
2. **Presentar para aprobación**.
3. El aprobador **aprueba**, **observa** (vuelve al supervisor para corregir) o **rechaza**, siempre con sustento.
   Nadie aprueba su propia solicitud (salvo Administrador). Si la ficha de un trabajador cambió durante la revisión,
   el sistema avisa que el costo cambió y pide confirmar de nuevo.
4. Al aprobar se guarda una **versión del informe** (`hhee_authorizations`) y se habilitan:
   - **PDF de autorización** (por qué, quiénes, cuántas horas, firmas).
   - **Correo** con vista previa editable (Gmail, Outlook o programa de correo).
   Ni el PDF compartido ni el correo incluyen conceptos remunerativos.
5. Modificar una solicitud aprobada la devuelve a aprobación; la nueva aprobación genera la versión 2, 3…

## 3. Panel gerencial

Horas y costo aproximado **autorizados** (no son horas trabajadas ni costo de planilla). Filtros por período,
área, causa, supervisor y trabajador. Incluye evolución, recargos, Pareto de causas, causas por mes, supervisores,
día de la semana, trabajadores recurrentes y exportación a Excel.

## Permisos aplicados por la migración `20261021050000_hhee_flujo_simple.sql`

- Supervisor de Transporte / Despacho: `hhee-solicitar:write`, `hhee:read`.
- Jefe de Distribución: `hhee-aprobar:write`, `hhee-gerencia:read`, `hhee-costos:read`, `hhee-config:write`, `hhee:read`.
- Los usuarios activos con esos roles quedan como miembros del área Distribución.
- Quien solo solicita no ve tarifas ni costos.

Prueba: `supabase/tests/caja_c125_hhee_flujo_simple.test.sql` (C125).
