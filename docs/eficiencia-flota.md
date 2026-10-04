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

## Reglas de cálculo (v2, migración `20261004100000`)

**Medición**

- **Precio constante.** El combustible se valora al precio de referencia: el de los parámetros o, si está vacío, la mediana
  de los últimos 6 meses (precio actual). El GLP tiene su propia referencia y se reconoce por la placa o por un precio
  menor a S/ 9. Siempre se muestra también lo efectivamente pagado.
- **Mantenimiento reclasificado.** Un registro "preventivo" cuyo detalle describe una reparación (repara, falla, avería,
  cambio de caja/motor/bomba…) cuenta como correctivo. Las llantas son una categoría propia.
- **Mantenimiento repartido.** Las llantas y las intervenciones mayores se reparten en 24 meses (parámetro), para que una
  factura grande no decida sola.
- El **costo por km** solo usa meses completos: con km, combustible y mantenimiento.
- El **costo por t·km** además exige meses con viajes y peso. El **costo total** suma la mano de obra: el conductor por
  cada mes con actividad y los ayudantes por las horas de viaje.
- Las **horas por año** de los equipos salen de la suma de incrementos del horómetro: se descartan las bajadas y los saltos
  de más de 12 h por día, y solo se calculan si las lecturas abarcan más de 180 días.
- **Comparación por grupo** (tracto, camión, liviano, camión grúa, montacarga, elevación), solo en grupos con 2 o más
  unidades. Las unidades a GLP y la grúa no se comparan en km por galón.
- **Capacidad**: la de la ficha, la de Flota o la práctica (percentil 95 del peso por viaje). Con la práctica, el llenado
  típico ronda el 50 % por construcción. Por eso la **capacidad ociosa** solo se marca con la capacidad real o con el % de
  volumen de las rutas.
- **Confianza** según los meses completos: Alta (12 o más), Media (6 a 11), Baja (menos de 6).
- **Cumplimiento del preventivo** (Excel): un servicio está a tiempo si no supera en más de 10 % el km u hora programado
  por el servicio anterior.
- Correcciones al cargar el Excel:
  - se anula el peso mayor a la capacidad (o a 45 t);
  - se anulan los km por viaje que sean ≤ 0 o > 1 200;
  - se anulan las horas por viaje que sean ≤ 0 o > 20;
  - se excluyen los meses con un rendimiento imposible.

**Decisión económica de reemplazo** (`fe_econ`)

- **Costo de seguir un año más** = mantenimiento sin llantas (más su alza anual) + combustible + pérdida de valor del año
  + tasa × valor de reventa.
- **Unidad nueva** = (valor nuevo − reventa al final de su vida útil, descontada) × factor de recuperación del capital
  + operación de una unidad nueva. La operación nueva tiene un 10 % menos de combustible y el mantenimiento que tuvieron
  las unidades del grupo hasta los 4 años; sin ese dato, se usa el 3 % del valor.
- Las llantas no entran en la comparación: se gastan por km igual en una unidad nueva o usada. La mano de obra tampoco:
  es la misma en ambos casos.
- **Reventa (mercado de Lima)**: el 1.er año pierde d1, luego d por año, con un piso. Se calibró con avisos de venta:

  | Activo | d1 | d | Piso | Referencia |
  |---|---|---|---|---|
  | Pesados | 15 % | 6 % | 25 % | Hino 300 2021 ≈ 70 %; International 7600 2016 ≈ 50 %; 2011 ≈ 32 % |
  | Livianos | 15 % | 8 % | 15 % | |
  | Montacargas y elevación | 20 % | 10 % | 10 % | Montacargas 2012 ≈ 18 % |

- **Tasa**: la de la empresa es confidencial. La decisión se calcula con 6 %, 10 % y 15 % (parámetros).
  - **Reemplazar**: el ahorro es positivo con las tres tasas.
  - **Planificar reemplazo**: el ahorro es positivo solo con alguna tasa, o la edad supera la vida útil.
- **Valor nuevo**: el valor de reposición de la ficha. Si falta, se usa un valor referencial por grupo (parámetros), que
  conviene reemplazar con la cotización real.

**Montacargas y elevación**

- **Costo propio por hora** = (mantenimiento repartido + pérdida de valor + costo de capital) / horas al año.
- Se compara con el **alquiler** (S/ 60 por hora + IGV, parámetro). El operador no se incluye porque se paga igual en
  ambos casos.
- **Dar de baja o alquilar**: alquilar sale más barato incluso con la tasa baja.
- "Propio conviene desde" = horas al año a partir de las cuales tener el equipo cuesta menos que alquilarlo.

**Rutas**

- El costo estimado por viaje es km × costo por km de la unidad + horas × (conductor + ayudantes).
- Se agrupa por cliente y por distrito. Los nombres de cliente se normalizan: sin forma societaria ni puntuación, y las
  variantes de JRM cuentan como traslado interno.
- La espera en el cliente se valora con el costo por hora del conductor y los ayudantes.

## Decisión

Puntaje (transporte):

| Condición | Puntos |
|---|---|
| Edad ≥ vida útil | +40 |
| Edad ≥ 80 % de la vida útil | +20 |
| Reemplazo económico con las 3 tasas | +40 |
| Mantenimiento por km > 1,5 × su grupo | +20 |
| Rendimiento < 85 % de su grupo | +20 |
| Alza de mantenimiento por km > umbral | +20 |

Recomendación, en este orden:

1. **Verificar estado**: sin uso en 3 meses.
2. **Reemplazar**: económico con las 3 tasas, o puntaje ≥ 60 si no hay datos económicos.
3. **Planificar reemplazo**: económico con alguna tasa, conviene en ≤ 2 años o la edad ≥ vida útil.
4. **Reasignar carga**: capacidad ociosa con el vehículo en línea con su grupo.
5. **Vigilar**: puntaje ≥ 20.
6. **Alta reciente**.
7. **Mantener**.

Equipos, en este orden:

1. **Dar de baja o alquilar**.
2. **Verificar estado**: sin registro en 6 meses.
3. **Reemplazar**: económico con las 3 tasas.
4. **Planificar reemplazo**.
5. **Registrar horómetro**.
6. **Vigilar**.
7. **Mantener**.

## Integración con Mantenimiento

- Cada activo se **vincula a una unidad de Flota**: automáticamente por placa o código interno, o a mano en Datos y
  parámetros. Del vehículo vinculado llegan:
  - costos del libro de la unidad (`vw_vehicle_cost_ledger`): OT, neumáticos, multas, siniestros y alquiler;
  - fallas (`vehicle_failures`) y días fuera de servicio por OT;
  - odómetro y horómetro (`vehicle_odometer_logs`), incluido el que se registra en las inspecciones;
  - capacidad (`weight_capacity`) y año.
- La ficha **Flota 360** (Mantenimiento › Flota › unidad) muestra la tarjeta de Eficiencia de Flota con la decisión, el
  costo y los motivos (`fe_activo`). Solo la ve quien tiene permiso del módulo.

## Pantallas

| Pantalla | Contenido |
|---|---|
| Resumen y decisiones | Indicadores, conclusiones automáticas y decisión por activo |
| Unidades de transporte | S/ por t·km con mano de obra, vehículo vs asignación, decisión económica de reemplazo, mantenimiento por km por año y exportación a Excel |
| Montacargas y elevación | Costo propio por hora frente al alquiler, registro del horómetro y detalle por equipo |
| Rutas y carga | Productividad (horas, espera, no programados), toneladas por mes y unidad, costo por cliente y por distrito |
| Recambios | Línea de vida de cada activo |
| Datos y parámetros | Carga del Excel, calidad de los datos, cobertura por mes, parámetros, activos, lecturas e historial de cargas |

JRM IA cuenta con la herramienta `get_fleet_efficiency`, que devuelve el resumen o el detalle de un activo.

## Puesta en marcha

1. Asignar los permisos en Roles y Permisos.
2. Cargar el Excel en **Datos y parámetros**.
3. Completar la capacidad (kg) y el valor de reposición de cada camión en la tabla de activos.
4. Registrar una lectura de horómetro al mes por equipo.

## Pruebas

`supabase/tests/caja_c28_eficiencia_flota_v2.test.sql` comprueba la reclasificación, el reparto de llantas, el precio
constante, la decisión económica, el alquiler de montacargas, el vínculo con Flota, la normalización de clientes y los
permisos de `fe_activo`.

`supabase/tests/caja_c27_eficiencia_flota.test.sql` comprueba:

- los permisos;
- la carga;
- el cálculo de km, costo por km, toneladas y t·km;
- el corte manual;
- las horas del montacargas.

El mensaje de la prueba informa cuántos registros del TMS existen desde 2025 (`tms2025: …`).
