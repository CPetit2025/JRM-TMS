# Fase 12 — Centro de Control, analítica e IA

Fecha: 2026-09-28 · Migración: `20260928150000_f12_centro_control_ia.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | El Copiloto era un **simulador**: contexto fijo (`mockContext`), recomendación con un `if` y URL de respaldo `mock.supabase.co`. |
| Alto | El dashboard calculaba el MTTR en días en el navegador, leía estados inexistentes (`PENDIENTE`) y no tenía MTBF, preventivo vs correctivo, costo/km ni fallas recurrentes. |
| Alto | La base de datos estaba en UTC: `CURRENT_DATE` adelantaba la fecha de negocio desde las 19:00 de Lima (detectado en F5 y F10). |
| Medio | `ai_analysis_logs` solo existía para el simulador. |

## Implementado

- **Zona horaria de la base: `America/Lima`.** `CURRENT_DATE` es la fecha de negocio. Las marcas `timestamptz` no cambian.
- **`get_cmms_kpis(inicio, fin, placas)`** (`SECURITY INVOKER`, sin tablas de dashboard):

  | KPI | Cálculo |
  |---|---|
  | Disponibilidad | 1 − horas fuera de servicio por OT (**intervalos fusionados**, sin doble conteo por OT solapadas) / (unidades × horas del periodo) |
  | MTBF | (horas del periodo − horas fuera de servicio) / fallas no descartadas |
  | MTTR | Promedio de horas fuera de servicio de las OT correctivas/emergencia cerradas en el periodo |
  | Backlog | Solicitudes abiertas, críticas, antigüedad promedio y máxima; OT abiertas |
  | Preventivo vs correctivo | % sobre las OT cerradas |
  | Costos | TCO del periodo por categoría (libro de F11), costo/km con km reales, costo/hora con horómetro, mantenimiento por unidad |
  | Neumáticos | Costo/km promedio y por cambiar |
  | Fallas recurrentes | ≥3 en 90 días |

  Incluye una foto actual del estado de la flota y el **detalle por unidad**.
- **`get_cmms_copilot_brief()`** responde las preguntas del plan con datos reales:
  - unidades bloqueadas o no disponibles **y por qué** (motor F2);
  - mantenimiento que vence;
  - unidades que más cuestan (365 días);
  - fallas recurrentes;
  - repuestos bajo el mínimo;
  - talleres con más retrabajos.

  **Anomalías (IA predictiva):**
  - pico de costo: 30 días > 2× el promedio mensual de los 6 meses anteriores;
  - tendencia de fallas: ritmo 2× el de los 90 días previos;
  - neumáticos bajo el mínimo;
  - documentos vencidos o por vencer.

  Es `SECURITY INVOKER`: la IA solo ve lo que el usuario puede ver y **nunca modifica datos**.
- **JRM IA (Gemini):** tres herramientas nuevas con permiso `ia:read:mantenimiento`: `get_cmms_kpis`, `get_cmms_brief` y `explain_unit_availability`. Se agregaron sugerencias de mantenimiento, y otros módulos pueden abrir el asistente con una pregunta precargada (`jrm:open-ai`).
- **UI:**
  - **Centro de Control:** periodo de 7/30/90/365 días; 10 indicadores; estado de la flota; costos por categoría; alertas y anomalías; fallas recurrentes; tabla por unidad; definiciones visibles.
  - **Copiloto:** una tarjeta por pregunta con datos reales y un botón para preguntar a JRM IA. Agregado al menú.
- **Limpieza:** se elimina `ai_analysis_logs`.

## Pruebas — reconciliación manual de KPI

`supabase/tests/f12_kpis_copiloto.test.sql` — **11/11 PASS**

Muestra de junio 2026 con 2 unidades (1 440 h):
- OT correctivas solapadas en la unidad A: 36 h y 6 h (se fusionan en 36 h).
- OT preventiva en la unidad B: 12 h.
- 2 fallas en junio y 1 en mayo (no cuenta).
- Costos: 1 000 (A) + 500 (B). Km reales: 3 000 (A) + 2 000 (B).

| KPI | Esperado a mano | Obtenido |
|---|---|---|
| Horas fuera de servicio | 48 (no 54) | 48 ✔ |
| Disponibilidad | 96,67 % | 96,67 % ✔ |
| MTTR | (36 + 6) / 2 = 21 h | 21 ✔ |
| MTBF | (1 440 − 48) / 2 = 696 h | 696 ✔ |
| % preventivo | 1/3 = 33,3 % | 33,3 ✔ |
| Costo/km | 1 500 / 5 000 = 0,30 | 0,30 ✔ |
| Mantenimiento/unidad | 750 | 750 ✔ |
| Unidad A: disponibilidad / MTBF | 95 % / 342 h | ✔ |
| Unidad B: disponibilidad | 98,33 % | ✔ |

Además se validan: fallas recurrentes (A con 3 reportes); el Copiloto (B bloqueada con motivos y todas las secciones); la zona horaria de Lima; y RLS (un usuario sin permisos no ve costos ni unidades).

Regresión: F1 a F11 y `cmms_regresion` PASS con la zona horaria nueva.

## Observaciones

- **Permiso de IA.** Las herramientas de IA de mantenimiento requieren `ia:read:mantenimiento` en el rol, igual que las herramientas existentes de ese alcance. Hoy solo el Administrador lo tiene; hay que asignarlo en Permisos a los roles que deban usarlas.
- **Respuesta del modelo sin prueba automática.** La conversación con Gemini depende de la clave `GEMINI_API_KEY` en Vercel y de una sesión real. Las funciones que la alimentan sí están probadas.
