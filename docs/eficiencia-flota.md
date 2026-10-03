# Eficiencia de Flota

Módulo propio (`/eficiencia-flota`) que relaciona el mantenimiento, el combustible, los km recorridos y el peso
transportado de cada activo (unidades de transporte, montacargas y equipos de elevación). Con eso calcula el costo
por km, por tonelada·km y por hora, y propone una decisión: reemplazar, dar de baja, vigilar o mantener.

## Permisos

| Permiso | Modo | Permite |
|---|---|---|
| `flota-eficiencia` | lectura / escritura | Ver el módulo y sus 6 pantallas |
| `flota-eficiencia-carga` | interruptor | Cargar el Excel, registrar el horómetro y editar parámetros y activos |

Se asignan en **Roles y Permisos** (grupo "Eficiencia de Flota"). Todas las escrituras pasan por RPC `SECURITY DEFINER`.
Las tablas `fe_*` solo tienen políticas de lectura (`fe_can_view()`).

## Fuentes y corte

La historia se carga una vez desde el Excel (`Gastos_Mantenimiento_KM_Peso_Combustible.xlsx`), que tiene 3 hojas
detectadas por sus encabezados: mantenimiento, combustible mensual y rutas. Cada carga reemplaza toda la historia
anterior. El análisis empieza en `fe_settings.desde` (2025-01 por defecto).

El corte se aplica **por fuente**. Cada fuente usa el Excel hasta su último mes y el TMS desde el mes siguiente.
Si se define `fe_settings.corte`, esa fecha rige para todas las fuentes.

| Fuente | Excel | TMS (después del corte) |
|---|---|---|
| Mantenimiento | hoja de mantenimiento | `vw_vehicle_cost_ledger` (MANTENIMIENTO y NEUMATICOS) |
| Combustible | hoja mensual | `dispatch_expenses` COMBUSTIBLE no rechazado (`COALESCE(approved_amount, amount)`) |
| Km | KM REAL del mes | `vehicle_odometer_logs`, `fuel_odometer` y `dispatches.end_odometer` (máximo del mes menos el del mes anterior) |
| Viajes y peso | hoja de rutas | `dispatches` con su guía de remisión → salida APT (`apt_guia_key`) |
| Días fuera de servicio | — | `maintenance_work_orders` (inicio y fin real) |
| Horómetro | km/horas de la hoja de mantenimiento | `fe_hour_readings` y `vehicle_odometer_logs.hours_value` |

Las placas se normalizan con `fe_code()`: `BCW 838 / ARB 976` → `BCW 838` y `BDK-791` → `BDK 791`.

## Reglas de cálculo

- El **costo por km** solo usa meses completos, es decir, meses con km, combustible y mantenimiento.
- El **costo por t·km** además exige meses con viajes y peso.
- Las **horas por año** salen de la suma de incrementos del horómetro. Se descartan las bajadas y los saltos de más
  de 12 h por día, y solo se calculan si las lecturas abarcan más de 180 días.
- Correcciones al cargar el Excel:
  - se anula el peso mayor a la capacidad del vehículo (o a 45 t);
  - se anulan los km por viaje que sean ≤ 0 o > 1 200;
  - se excluyen los meses con un rendimiento imposible.

## Decisión

El puntaje y la recomendación usan los umbrales de **Datos y parámetros**: vida útil por clase, horas mínimas por
año, factor de costo, tendencia de mantenimiento por km, volumen mínimo y factor de t·km.

### Transporte

Puntaje:

| Condición | Puntos |
|---|---|
| Edad ≥ vida útil | +40 |
| Edad ≥ 80 % de la vida útil | +20 |
| Costo t·km > factor × mediana (con cargas de al menos 1 t) | +20 |
| Tendencia del mantenimiento por km > umbral | +20 |
| Mantenimiento por km > 1,5 × mediana | +20 |

Recomendación, en este orden: Verificar estado (sin uso en 3 meses) → Reemplazar (≥ 60) → Planificar reemplazo
(edad ≥ vida útil) → Vigilar (≥ 20) → Consolidar carga (volumen bajo) → Alta reciente → Mantener.

### Montacargas y elevación

Puntaje:

| Condición | Puntos |
|---|---|
| Edad ≥ vida útil | +40 |
| Edad ≥ 80 % de la vida útil | +20 |
| Costo por hora > factor × mediana | +25 |
| Horas por año < mínimo | +25 |

Recomendación, en este orden:

1. **Dar de baja o alquilar**: poco uso y, además, costo alto o edad ≥ vida útil.
2. **Verificar estado**: sin registro en 6 meses.
3. **Reemplazar**: puntaje ≥ 60.
4. **Planificar reemplazo**.
5. **Registrar horómetro**.
6. **Vigilar**: puntaje ≥ 25.
7. **Mantener**.

## Pantallas

| Pantalla | Contenido |
|---|---|
| Resumen y decisiones | Indicadores, conclusiones automáticas y decisión por activo |
| Unidades de transporte | S/ por t·km, productividad, mantenimiento por km por año, tabla del periodo y exportación a Excel |
| Montacargas y elevación | Uso frente a costo por hora, registro del horómetro y detalle por equipo |
| Rutas y carga | Toneladas por mes, por unidad y por tipo de actividad |
| Recambios | Línea de vida de cada activo |
| Datos y parámetros | Carga del Excel, calidad de los datos, cobertura por mes, parámetros, activos, lecturas e historial de cargas |

JRM IA cuenta con la herramienta `get_fleet_efficiency`, que devuelve el resumen o el detalle de un activo.

## Puesta en marcha

1. Asignar los permisos en Roles y Permisos.
2. Cargar el Excel en **Datos y parámetros**.
3. Completar la capacidad (kg) y el valor de reposición de cada camión en la tabla de activos.
4. Registrar una lectura de horómetro al mes por equipo.

## Pruebas

`supabase/tests/caja_c27_eficiencia_flota.test.sql` comprueba:

- los permisos;
- la carga;
- el cálculo de km, costo por km, toneladas y t·km;
- el corte manual;
- las horas del montacargas.

El mensaje de la prueba informa cuántos registros del TMS existen desde 2025 (`tms2025: …`).
