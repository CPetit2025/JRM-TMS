# Desempeño por rol: Despacho, Transporte, Asistente Documentario y Conductores

Implementa el plan de `docs/plan-kpi-supervisores.md` (fases 1 a 3).
- Migración: `20261005180000_desempeno_por_rol.sql`.
- Prueba: `supabase/tests/caja_c36_desempeno_por_rol.test.sql`.
- Pantalla web: **Operación › Desempeño por rol** (`/desempeno`).
- App del conductor: tarjeta **Mi desempeño del mes** en Inicio.

## Decisiones tomadas (editables)

Mientras no haya otra indicación, se aplicaron los valores sugeridos del plan:

- **Metas y pesos:** los del plan. Se cambian en **Desempeño › Metas y pesos**.
- **Tiempos:** en horas calendario.
- **Revisión de informes:** quien tenga el permiso `desempeno`. Se asignó al rol Jefe de Distribución; el Administrador
  siempre lo tiene. Nadie revisa su propio informe.
- **Conductores:**
  - el índice es solo de seguimiento, sin bono;
  - un siniestro grave con responsabilidad del conductor deja el mes en 0;
  - el conductor ve solo su propio resultado, sin ranking.
- **Cobertura mínima:** el índice se calcula solo si los KPI con datos suman al menos el 40 % del peso del rol. Si no,
  aparece «Sin datos suficientes».

## A quién se mide

| Rol | Se mide a | Informe mensual |
|---|---|---|
| Supervisor de Despacho | usuarios con `despacho-aprobacion` | Sí |
| Transporte / Jefe de Distribución | usuarios con `caja-aprobacion` o con rol «…transporte…» / «…distribución…» | Sí |
| Asistente Documentario | rol «…documentario…» | Sí |
| Conductores | maestro de conductores (activos) | No: el índice se calcula solo |

El Administrador no se mide. La regla está en `kpi_roles` y se puede ajustar.

## Puntaje

| Tipo de KPI | Cálculo del puntaje (0–100) |
|---|---|
| Mayor es mejor | Resultado ÷ meta |
| Menor es mejor | 100 si cumple la meta; si la supera, baja en proporción al exceso |
| Meta 0 (multas, siniestros) | −50 puntos por cada caso |

El índice es el promedio ponderado de los KPI con datos.

En los roles con informe, la puntualidad del informe es un KPI más: −15 puntos por día de atraso. Vence el día 3, con
los mismos parámetros que Soporte Mecánico.

## Datos nuevos (fase 2)

- **Historial de estados del despacho** (`kpi_dispatch_log`): da la salida real, la entrega y el cierre con hora y
  usuario. Se cargó con los cambios de estado que ya existían.
  - Salida puntual: inicio de ruta hasta 30 min después de la hora programada. Si se programó solo la fecha, basta
    salir ese día.
- **Causa al reprogramar** (`reprogramar_solicitud`): la causa es obligatoria en Solicitudes › Reprogramar. Opciones:
  cliente, almacén sin stock, producción, sin unidad, sin conductor, vía o clima, documentos u otro.
- **Causa al anular un documento** (`anular_documento`):
  - Las causas «Error en datos», «Error en cantidades» y «Error en destino» cuentan contra el Asistente Documentario.
  - «Cambió la unidad», «Cambió el conductor» y «Pedido del cliente» no cuentan en su contra.
- **Cargo (guía firmada)** (`dispatch_cargos`, `registrar_cargo`): se registra en Documentos de Despacho, en los
  despachos que ya salieron (marcar «Ver los que ya salieron»).
- **Responsabilidad en multas y siniestros:** ya existía (Cumplimiento F9).

## Avisos (fase 3)

| Cuándo | Aviso | Para quién |
|---|---|---|
| Día 1, 08:00 | «Presenta tu informe mensual de …» | Cada integrante de Despacho, Transporte y Documentario |
| Día 1, 08:00 | «Tu desempeño de …: NN / 100», con un mensaje según la calificación | Cada conductor |
| Desde el día 4 | Aviso diario de atraso, con los días acumulados | El integrante y los revisores |
| Al revisar u observar un informe | Aviso del resultado | El autor del informe |

## Limitaciones conocidas

- La puntualidad depende de que la hora programada se registre al armar la ruta.
- «Rendiciones vencidas» del conductor solo se calcula para el mes en curso: es una foto del día.
- Los KPI de equipo son iguales para todos los integrantes de ese rol. En Despacho son observadas, reprogramadas y
  cumplimiento de fecha; en Transporte, los de puntualidad, control y liquidación.
