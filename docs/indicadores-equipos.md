# Indicadores por equipo

24 KPI de Transporte, Despacho, Inventario y Auditoría, con periodo semanal, quincenal o mensual.
Complementa a **Desempeño** (índice mensual por persona, `docs/desempeno-por-rol.md`): aquí se mide al equipo.

- Pantalla: **Reportes › Indicadores por equipo** (`/indicadores` lleva ahí).
- Enlace para gerencia: `/tracking/indicadores/<token>` con PIN de 8 dígitos.
- Migración: `supabase/migrations/20261231290000_indicadores_equipos.sql`.
- Prueba: `supabase/tests/caja_c226_indicadores_equipos.test.sql`.
- Base funcional: propuesta de KPI por equipo del 18-nov-2026.

## Reglas

- **El dato de origen nunca se modifica.** Las correcciones se guardan en `kpi_eq_correcciones`, junto con el valor
  original, el motivo, quién la propuso y quién la aprobó, y se aplican al calcular.
  - Hay una sola corrección viva por registro.
  - Quien la propone no puede aprobarla.
  - Rechazar exige un comentario.
  - Proponer exige permiso de escritura del equipo; con solo lectura se ve, pero no se corrige.
  - El revisor puede **revertir** una corrección aprobada por error: queda ANULADA con su motivo y el registro vuelve
    a su valor original.
  - En los KPI «foto» (I3, I4) la corrección se imputa a la foto vigente (hoy) y sigue aplicándose al mismo lote en las
    fotos siguientes.
- **Sin datos no es cumplir ni fallar.** Estados posibles:
  - `PENDIENTE_DATOS`: la fuente todavía no existe o no se captura.
  - `SIN_REGISTROS`: no hubo actividad en el periodo.
  - `DATOS_INSUFICIENTES`: la cobertura está bajo el mínimo del KPI; el valor solo es referencial.
  - `CUMPLE`, `ALERTA` y `NO_CUMPLE`: solo con datos suficientes.
- **Periodos:**
  - semana de lunes a domingo, quincenas 1–15 y 16–fin de mes, y mes calendario;
  - cierre automático en hora de Lima: 3 días después del fin del periodo a las 12:00 (semana: miércoles; mes: día 3),
    para que venzan antes los plazos que se juzgan dentro del periodo (cargo ≤ 48 h, asignación ≤ 4 h)
    (tarea `kpi-equipos-cierre`, cada hora).
  - El cierre guarda una foto inmutable (`kpi_eq_cierres`). Reabrir exige un motivo y el siguiente cierre crea
    otra versión; las versiones anteriores se conservan.
  - Mientras el periodo está cerrado no se aceptan correcciones de sus registros.
- **KPI «foto»** (I3, I4): miden el stock al momento del cálculo o del cierre. No se inventan para periodos que
  terminaron antes de que existiera el módulo.
- **Permisos:**
  - Revisor (`desempeno` o Administrador): ve todo, aprueba correcciones, cierra y reabre periodos, edita metas y
    crea enlaces.
  - Los demás ven y corrigen solo su equipo: Transporte con `flota`, Despacho con `despacho`, Inventario con `apt`
    y Auditoría con `hallazgos` (lectura o escritura).
- **Enlace compartido:**
  - solo lectura;
  - muestra solo periodos cerrados y solo los equipos elegidos;
  - no muestra numeradores, denominadores ni nombres de personas;
  - 10 intentos de PIN cada 15 minutos;
  - registra el nombre de cada visitante;
  - se puede revocar.

## Los 24 KPI

| Código | KPI | Frecuencia | Estado de datos al 18-nov-2026 |
|---|---|---|---|
| T1 | Rendimiento de combustible (% de la base) | Quincenal, mensual | Pendiente: 0 cargas de combustible registradas |
| T2 | Costo por km | Mensual | Pendiente: falta combustible y km reales |
| T3 | Fallas resueltas dentro del plazo | Quincenal | Activo |
| T4 | Unidad apta en el checklist | Mensual | Activo |
| T5 | Checklist antes de salir | Semanal | Activo |
| T6 | Salida puntual | Semanal | Activo (misma regla que Desempeño) |
| D1 | Entrega en la fecha requerida (OTD) | Semanal | Parcial: la causa de la tardanza no se registra |
| D2 | Asignación ≤ 4 h desde la aprobación | Semanal | Activo |
| D3 | Solicitudes reprogramadas | Quincenal | Activo |
| D4 | Entrega perfecta | Quincenal | Activo |
| D5 | Cargo de guía ≤ 48 h | Semanal | Activo |
| D6 | Ocupación de unidades | Mensual | Pendiente: peso en 33 % de las solicitudes |
| I1 | Exactitud de inventario (conteo cíclico) | Mensual | Pendiente de integración WMS |
| I2 | Exactitud de recepción | Semanal | Pendiente de integración WMS |
| I3 | Stock APT con más de 30 días | Mensual | Activo (foto) |
| I4 | Stock sin salida identificada | Quincenal, mensual | Activo (foto) |
| I5 | Ajustes y mermas | Mensual | Parcial: cerca de la mitad de los ajustes llegan sin peso |
| I6 | Devoluciones | Quincenal | Parcial: sin motivo ni estado del material |
| A1 | Despachos que pasan por el flujo WMS | Semanal | Activo desde el 8-nov-2026 |
| A2 | Cobertura de auditoría antes de cargar | Semanal | Pendiente de integración WMS |
| A3 | Exactitud de preparación | Semanal | Pendiente de integración WMS |
| A4 | Hallazgos por cada 100 despachos | Quincenal | Pendiente: 0 hallazgos; activarlo cuando se audite |
| A5 | Hallazgos cerrados en plazo | Quincenal | Activo (sin registros aún) |
| A6 | Salidas liberadas con excepción | Mensual | Activo (sin registros aún) |

Cuando una captura nueva empiece a funcionar, el revisor cambia el estado de datos del KPI en **Configuración**.

La cobertura es la menor entre la de todas las filas y la de las filas que solo aportan al numerador (devoluciones,
ajustes, hallazgos). Así, si en I5 o I6 ningún documento del numerador trae peso, el KPI nunca sale «cumple».
D1 cuenta como tarde las solicitudes vencidas sin llegada, en el periodo de su fecha requerida.

## Diferencias con la propuesta original

- **T3** mide las fallas resueltas dentro del plazo en vez de las fallas por cada 10 000 km: solo el 37 % de los
  viajes tiene km reales, así que el denominador no sería confiable.
- **T4** mide la proporción de checklists con la unidad apta. La disponibilidad por días necesitaría el calendario de
  taller.
- **T5** se mide con la inspección preuso (`driver_preuse_inspections`) de la misma placa ese día: **100 %** en la
  semana del 9 al 15 de noviembre. El 31 % de la propuesta venía de `kpi_despachos_v.salida_checklist`, que en
  realidad es la hora de salida (`departure_time`).
- **D5** usa el cargo registrado (`dispatch_cargos`, 96,8 % esa misma semana), la misma fuente que Desempeño, en vez
  del cierre documentario.
- **I1, I2, A2 y A3** viven en la base del WMS (otro repositorio). Para calcularlos, el WMS tiene que reportarlos al
  TMS como ya lo hace con el packing list (`wms_report_packing_list`).

## Hallazgos sobre Desempeño (no corregidos aquí)

- Su KPI **checklist** usa `driver_checklists`, que tiene 0 registros. El checklist real está en
  `driver_preuse_inspections`.
- **Entrega a tiempo** y **cumplimiento de fecha** usan `kpi_despachos_v.entrega_at`, que solo tienen 3 de 198
  despachos. La llegada real está en `delivery_conformities.arrived_at`.
- **Cargo ≤ 48 h** filtra `docs_required`, que solo tiene 1 de 198 despachos.

## Pendiente

- Integración WMS → TMS de los conteos, la validación de recepción y la auditoría de LPN, en el repositorio del WMS.
- Capturas nuevas (fase 2): causa de la tardanza, peso obligatorio, motivo y estado de las devoluciones, y causa
  codificada de los ajustes.
- Correo programado: no hay proveedor de correo. Hoy el cierre avisa por la campana (`KPI_EQUIPOS_CIERRE`).
