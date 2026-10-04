# Soporte Mecánico: rol, capacidad de respuesta e informe mensual

Migración `20261005150000_soporte_mecanico.sql` · prueba `supabase/tests/caja_c35_soporte_mecanico.test.sql` ·
pantalla **Mantenimiento › Soporte Mecánico** (`/mantenimiento/soporte`).

## Rol y permisos

El rol **Soporte Mecánico** tiene estos permisos:

| Permiso | Para qué |
|---|---|
| `mantenimiento-soporte` (nuevo) | Su desempeño, su informe mensual y los avisos de fallas |
| `mantenimiento-fallas` | Tomar, validar, diagnosticar, programar y convertir fallas a OT |
| `mantenimiento-ot` | Ejecutar y cerrar órdenes de trabajo; consultar repuestos |
| `mantenimiento-flota:read`, `mantenimiento-planes:read`, `mantenimiento-vencimientos:read` | Consultar unidades, inspecciones, planes y vencimientos |

Se asigna en **Usuarios** (rol «Soporte Mecánico»). Quien tenga `mantenimiento-dashboard` es supervisor: ve al equipo,
revisa los informes y ajusta los plazos.

## Avisos de fallas (punto 2)

Cuando el conductor (app), el Jefe de Distribución, el supervisor de transporte o cualquier usuario registra una falla,
la campana avisa a Soporte Mecánico, Fallas y Mantenimiento. El aviso indica la unidad, la criticidad y **quién la
reportó**. Además:

| Aviso | Cuándo |
|---|---|
| **Falla asignada** | Le llega solo al técnico, cuando el supervisor le asigna una falla |
| **Falla sin atención** (crítico) | Nadie la tomó dentro del plazo de respuesta de su criticidad. Se revisa cada 15 minutos |

## Cómo se mide la productividad (punto 1)

En **Fallas y Backlog**, el botón **Tomar** registra la primera atención. También cuenta como primera atención el primer
cambio de estado. Cada paso queda en `maintenance_request_events`, con hora y usuario.

Plazos por criticidad (editables en **Soporte Mecánico › Plazos**):

| Criticidad | Respuesta | Solución |
|---|---|---|
| Crítica | 1 h | 24 h |
| Alta | 4 h | 72 h |
| Media | 24 h | 7 días |
| Baja | 72 h | 15 días |

**Índice de eficiencia (0–100)**, ponderado:

| Componente | Peso | Cálculo |
|---|---|---|
| Respuesta dentro del plazo | 30 % | Porcentaje de fallas tomadas antes del plazo de respuesta |
| Solución dentro del plazo | 30 % | Porcentaje de fallas cerradas antes del plazo de solución |
| Sin reincidencia | 15 % | 100 − porcentaje de cierres en que la misma unidad volvió a fallar dentro de 30 días |
| Backlog al día | 10 % | 100 − porcentaje de fallas abiertas con más de 7 días |
| Puntualidad del informe | 15 % | 100 − 15 puntos por cada día de atraso |

Los componentes sin datos en el mes no cuentan. La calificación es Excelente (90 o más), Bueno (75 o más), Regular
(60 o más) o Bajo.

La pantalla también muestra:
- fallas atendidas y críticas;
- tiempo promedio y mediana de respuesta y de solución;
- OT cerradas (preventivas y correctivas) y horas promedio fuera de servicio;
- fallas del equipo sin atender;
- el detalle de cada falla con sus tiempos.

## Informe mensual (punto 3)

1. **Día 1, 08:00:** recordatorio en la campana del técnico («Presenta tu informe mensual de …»).
2. **Vence el día 3** (parámetro `plazo_informe_dia`).
3. **Desde el día 4:** aviso diario de atraso al técnico y a los supervisores, con los días de atraso. Cada día de atraso
   descuenta 15 puntos de puntualidad (parámetro `penalidad_dia_atraso`).
4. El técnico presenta el informe en **Soporte Mecánico › Informe mensual**. Escribe sus trabajos y logros, los problemas
   y las acciones para el mes siguiente. Los indicadores del mes se adjuntan solos.
5. El supervisor lo marca **Revisado** u **Observado** en la pestaña **Equipo** y el técnico recibe el aviso. Si está
   observado, el técnico lo corrige y lo reenvía; los días de atraso se cuentan desde el primer envío.

## Nota técnica

El aviso de falla nueva reemplaza al disparador `notif_falla` de `20261004140000`. Usa la misma clave `fal-<id>`, así que
no se duplica, y agrega quién reportó la falla y el destinatario Soporte Mecánico.
