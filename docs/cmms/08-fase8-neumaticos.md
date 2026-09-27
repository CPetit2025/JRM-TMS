# Fase 8 — Neumáticos

Fecha: 2026-09-27 · Migración: `20260927220000_f8_neumaticos.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | `check_tire_tread_depth`, el trigger que controlaba la cocada, insertaba en columnas inexistentes de `maintenance_requests`: fallaba cada vez que se medía una cocada baja. |
| Crítico | RLS "todo permitido" en `tires` y `tire_movements`. |
| Alto | La pantalla cambiaba el estado y la posición directamente, sin registrar km ni validar la posición. |
| Alto | `vw_tire_metrics` dependía del vocabulario con tildes, no contaba reencauches y solo incluía neumáticos de baja o en reencauche. |
| Medio | Historial paralelo sin uso (`tire_status_logs`). Vocabulario con tildes (`ALMACÉN`, `INSTALACIÓN`), que ya causó rechazos en F3. |

## Implementado

- **Identidad individual:** código interno único, serie, DOT, marca, modelo, medida, costo, proveedor, cocada original y mínima, máximo de reencauches y vida útil esperada.
- **Ciclo de vida solo por `register_tire_event`:**

  | Evento | Qué hace |
  |---|---|
  | `COMPRA` | Automática al dar de alta |
  | `INSTALACION` | Solo desde almacén; posición única por unidad |
  | `ROTACION` | Posición destino libre; acumula km |
  | `DESMONTAJE` | Acumula km y vuelve al almacén |
  | `MEDICION` | Registra la cocada |
  | `ENVIO_REENCAUCHE` / `RETORNO_REENCAUCHE` | El retorno exige costo y cocada; controla el máximo de reencauches |
  | `BAJA` | Exige motivo; solo si el neumático está desmontado |

  Un guard impide cambiar estado, posición, km o cocada fuera del RPC.
- **Km por odómetro real:** el odómetro informado se registra por la fuente autorizada (F5) y no retrocede. Los km se acumulan en cada rotación o desmontaje. El km en curso de un neumático instalado se calcula en la vista.
- **Cocada bajo el mínimo en un neumático instalado:** genera una falla `ALTA` en el backlog (F3), sin duplicarla en el día.
- **Indicadores (`vw_tires`):**
  - km totales;
  - costo total (compra + reencauches) y costo por km;
  - % de desgaste y estado de cocada (`OK`, `POR_CAMBIAR`, `CAMBIAR`);
  - reencauches realizados y máximos.
- **Historial (`vw_tire_history`):** de la compra a la baja, con unidad, posición de origen y destino, odómetro, cocada, km, costo y usuario.
- **Integración:** la ficha Flota 360 (F1) muestra los neumáticos montados. El costo por km entra al TCO en F12.
- **Limpieza:** se eliminan `tire_status_logs`, `vw_tire_metrics` y el trigger roto. Vocabulario canónico sin tildes, normalizando las variantes.
- **UI:**
  - Indicadores: instalados, en almacén, en reencauche, por cambiar y costo por km.
  - Listado con acciones de evento según el estado.
  - Vista de posiciones por unidad e historial.

## Pruebas

`supabase/tests/f8_neumaticos.test.sql` — **13/13 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Alta del neumático | Entra al almacén y registra la `COMPRA` |
| T2 | Instalación | Posición única por unidad |
| T3 | Cambio directo de estado o movimiento | Rechazado |
| T4 | Rotación | Acumula 5 000 km según el odómetro |
| T5 | Medición bajo el mínimo | Genera la falla y marca `CAMBIAR` |
| T6 | Desmontaje | Suma 3 000 km más |
| T7 | Reencauche | Costo total 1 300 y costo por km 0,1625 |
| T8 | Exceso de reencauches | Rechazado al superar el máximo |
| T9 | Baja | Exige motivo y cierra el ciclo |
| T10 | Neumático instalado | Suma los km en curso; lectura menor rechazada |
| T11 | Historial | 8 eventos de la compra a la baja |
| T12 | Flota 360 | Muestra el neumático montado |
| T13 | Usuario sin permisos | No registra eventos ni ve neumáticos |

Regresión: F1 a F7 y `cmms_regresion` PASS.
