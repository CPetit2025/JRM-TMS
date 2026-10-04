# Plan de mantenimiento preventivo y correctivo

Relaciona el gasto histórico de mantenimiento (Excel 2021–2026, S/ 1,21 millones) con Flota y con el módulo de
Mantenimiento.

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Historial único por unidad, clasificación por sistema, equipos registrados en Flota, horómetro y checklist del operario | Migración `20261004140000` |
| 2 | Planes de cada unidad desde las plantillas, con la última ejecución del historial; validación y activación | Migración `20261004160000` |
| 3 | Reparación mayor con cotización, gasto de Caja en el historial, plan anual con presupuesto e indicadores | Migración `20261004160000` |

## Diagnóstico (Excel)

- **El correctivo real duplica lo registrado.** El Excel marca como correctivo el 17 % del gasto. Si se reclasifican
  los preventivos que describen reparaciones, el correctivo real es el 41 %. En 2024–2025 fue el 33 %.
- **Sistemas con más gasto correctivo:**
  - motor: S/ 110 mil;
  - hidráulico: S/ 84 mil;
  - baterías: S/ 74 mil;
  - caja y embrague: S/ 61 mil;
  - eléctrico: S/ 40 mil.
- **Elevadores eléctricos sin preventivo.** Entre el 64 % y el 81 % de su gasto es correctivo.
- **Intervalos de aceite.**
  - Camiones: 5.000 km. La BDK 791 y la F3R 838 pasaron el intervalo en más de 10 % el 22 % de las veces.
  - Montacargas: 250 h. Varios equipos cambian antes de 200 h, lo que es gasto de más.
- **Vacíos de datos:**
  - días fuera de servicio en solo 4 registros;
  - tracto y semirremolque mezclados en un solo activo;
  - lectura imposible en la BDK 791;
  - CFO 930 y CJS 716 sin mantenimiento registrado.

## Frecuencias (plantillas `mant_plan_templates`)

Se aplica lo que ocurra primero: km, horas o días.

| Familia | Unidades | Servicio | Frecuencia | Fuente |
|---|---|---|---|---|
| Camión diésel Hino serie 500 | BDJ 943, BDK 791 | A: aceite, filtros de aceite y combustible, engrase | 7.500 km / 90 días | [Hino](https://srmacos.com/novedades/guia-mantenimiento-preventivo-camion-hino-500-por-kilometros): 10.000 km normal, 5.000 en uso severo |
| | | B: + filtro de aire, frenos, rotación de llantas | 15.000 km / 180 días | |
| | | C: caja, corona, refrigerante, embrague | 60.000 km / 1 año | |
| Tracto con caja Eaton Fuller | BCW 838 | A: aceite y filtros, quinta rueda, nivel de caja | 10.000 km / 90 días | Motor pesado: 15.000–30.000 km en carretera; menos en uso exigente |
| | | B: + filtros de aire, secador de aire | 30.000 km / 180 días | |
| | | Caja y diferencial (sintético) | 150.000 km / 2 años | [Eaton](https://www.globaltransmissionsupply.com/eaton-fuller-transmission-troubleshooting-guide/transmission-lubrication): 290.000 km o 3 años en uso vocacional |
| Semirremolque | ARB 976 | Trimestral: zapatas, rodajes, luces | 10.000 km / 90 días | |
| | | Anual: ejes y suspensión | 1 año | |
| Camión diésel de más de 15 años | F3R 838 (VW Worker 2006) | A / B / C | 5.000 / 10.000 / 40.000 km | Motor antiguo: se mantiene 5.000 km |
| Liviano a gasolina o GLP | BHW 001 (JAC GLP), F6E 535, CFO 930, CJS 716 | A / B / C | 5.000 / 10.000 / 20.000 km | [JAC Perú](https://www.jac.pe/noticias/cada-cuantos-kilometros-se-debe-hacer-el-mantenimiento-vehicular/): cada 5.000 km |
| Montacargas a GLP o gasolina | NN01–NN04, CLARK 4TN y 5TN, Hangzhou | 250 / 500 / 1.000 / 2.000 h | 90 / 180 / 365 / 730 días | [Programa 250-500-1.000-2.000 h](https://ciftransmissions.com/how-often-should-you-schedule-forklift-maintenance/) |
| Plataforma de tijera y apilador | Tijeras N1, N2, N5 y N6, apilador BT | Mensual / trimestral / anual | 30 / 90 / 365 días | [ANSI A92](https://atomoving.com/blog/aerial-work-platform/scissor-lift-inspection-frequency-building-a-safe-maintenance-schedule-18022026-new/): pre-uso, cada 3 meses y anual |

**Por qué estas frecuencias son eficientes**

- **Hino: 7.500 km en lugar de 5.000.** Aceite CK-4 con análisis de aceite en los primeros 4 servicios. Si el análisis
  sale bien, se pasa a 10.000 km, la pauta normal de Hino. Son unos 2 servicios menos por camión al año sin perder
  protección. El reparto urbano en Lima cuenta como uso severo, por eso no se salta directo a 10.000 km.
  - El diésel en Perú es B5 S50, con 50 ppm de azufre como máximo ([Repsol](https://www.repsol.pe/content/dam/repsol-paises/pdfs/peru/gasoleo/Diesel%20B5%20S50.pdf)).
    Eso permite intervalos más largos que con el diésel de antes.
- **Montacargas:** se respeta 250 h, sin adelantar el cambio.
- **Elevadores:** se pasa de "atender cuando falla" a un calendario. Sus fallas principales (baterías e hidráulico)
  se previenen con revisiones semanales y mensuales de bajo costo.
- **Tracto:** confirmar la marca y el modelo del motor con el concesionario para ajustar el servicio A. Desde 2024 su
  "próximo mantenimiento" usa otra lectura, probablemente el horómetro del motor.

## Turno del operario (app › Equipos)

- Al iniciar el turno, el operario registra el **horómetro** y el **checklist**:
  - montacargas: checklist pre-uso en cada turno;
  - elevadores: checklist semanal.
- **Validación del horómetro:**
  - no puede retroceder;
  - un salto mayor a lo posible (16 h por día desde la última lectura, mínimo 24 h) queda **por validar** y no mueve
    el horómetro de la unidad, para que un dígito de más no bloquee las lecturas siguientes.
- **Puntos en falla:** se reportan a Mantenimiento en Fallas y Backlog (`maintenance_requests`).
  - Un punto **crítico** (frenos, dirección, GLP, horquillas, bajada o paro de emergencia, barandas) entra como falla
    CRÍTICA, y la unidad se bloquea por el motor de elegibilidad.
  - El aviso llega por la campana a quienes tienen permiso sobre las fallas.
- Funciones: `mant_equipos_turno()` y `mant_registrar_turno(vehicle_id, horas, checklist, observaciones)`.

## Equipos en Flota

La migración registra los 12 equipos con su horómetro según el historial y los vincula a su ficha de Eficiencia de
Flota. Si un equipo ya estaba en Flota, no lo duplica.

| Excel | Placa / código en Flota | Tipo |
|---|---|---|
| UN FORKLIFT NN01–NN04 | NN01–NN04 | Montacargas (MTC) |
| CLARK 4TN, CLARK 5TN, HANGZHOU 3.5TN | Mismo nombre | Montacargas (MTC) |
| SCISSOR LIFT N1, N2, N5, N6 | TIJERA N1, N2, N5, N6 | Otro equipo (EQP) |
| APILADOR BT REFLEX | APILADOR BT | Apilador (API) |

Las unidades de transporte no se crean ni se modifican. La prueba C30 informa en el despliegue cuáles están en Flota.

**Verificación en producción (C30, 04/10/2026)**

| Unidad | En Flota | Familia del plan |
|---|---|---|
| BDJ 943, BDK 791 | Sí (CAMION) | Camión diésel Hino |
| F3R 838 | Sí (CAMION) | Camión de más de 15 años |
| BHW 001, F6E 535 | Sí, pero como CAMION | Liviano (corregido en la migración `20261004150000`) |
| BCW 838 | Sí, como una sola unidad "BCW838/ARB976" de tipo TRAILER | Tracto. El semirremolque no tiene ficha propia. |
| CFO 930, CJS 716 | **No** | Registrar en Flota |

## Historial único (Flota 360 › Gasto y plan)

`mant_historial(placa)` muestra:

- el Excel hasta su último registro y las OT del sistema después de esa fecha, sin doble conteo;
- el gasto por año (preventivo y correctivo) y por sistema;
- el % correctivo de los últimos 12 meses (meta: menos de 25 %);
- el plan recomendado según la familia de la unidad;
- los turnos del operario.

Pueden verlo quienes tienen Mantenimiento › Flota, OT o Finanzas, o Eficiencia de Flota.

## Fase 2: planes por unidad

- **Unidades nuevas en Flota:** CFO 930 (camión grúa), CJS 716 (camioneta) y el semirremolque ARB 976, que tiene ficha
  propia para su mantenimiento. El tracto sigue siendo la unidad "BCW838/ARB976" que usa Despacho.
- **Odómetro:** el de cada unidad de transporte se sube a la última lectura del historial. Nunca baja y queda
  registrado como `HISTORIAL_EXCEL`.
- **Planes:** cada unidad recibe los servicios de su familia (`maintenance_plans.mant_template_id`). La última
  ejecución se toma del historial con el patrón del servicio (por ejemplo, cambio de aceite de motor). Rellenar o
  completar aceite no cuenta como cambio.
- **Los planes nacen inactivos.** El historial termina en junio de 2026. Si se activaran directo, el programador diario
  (6:00) generaría OT por servicios que quizá ya se hicieron. Mantenimiento confirma la última ejecución en
  **Mantenimiento › Plan anual › Validar** (`mant_validar_planes`, permiso Preventivos) y desde ahí se activan.

## Fase 3: control y presupuesto

- **Reparación mayor:** una OT correctiva de más de **S/ 5.000** (`mant_settings.umbral_cotizacion`) no pasa a
  APROBADA, PROGRAMADA ni EN_PROCESO sin cotización aprobada. Lo controla el disparador `mant_ot_umbral`, sin cambiar
  las funciones de OT. El mensaje pide revisar la decisión de Eficiencia de Flota.
- **Caja:** los gastos aprobados de categoría MANTENIMIENTO o NEUMATICOS (repuestos, parchado) entran al historial de la
  unidad. Los que no tienen placa se listan en el Plan anual para asignarlos (`mant_asignar_gasto`). Solo se completa la
  placa: el gasto no cambia en Caja.
- **Plan anual** (`mant_plan_anual`):
  - **calendario por mes:** el intervalo de cada servicio es el que ocurra primero entre su uso real (km o horas de
    los últimos 12 meses) y los días. Un servicio mayor reemplaza a los que incluye en el mismo mes. Lo vencido se
    programa en el mes actual;
  - **costo:** la mediana de lo pagado en ese servicio en los últimos 3 años, como máximo 2 veces el costo de
    referencia de la plantilla;
  - **reserva de correctivo:** el promedio anual de los últimos 24 meses;
  - **real del año:** Excel + OT + Caja;
  - **indicadores:** % correctivo (meta menos de 25 %), cambios de aceite a tiempo (meta 90 %), días promedio entre
    correctivos (MTBF), servicios vencidos, Caja sin unidad y reparaciones mayores sin cotización.
- **Eficiencia de Flota:** cuenta las fallas desde `maintenance_requests`, la fuente única.

## Reglas acordadas

- Una reparación de más de **S/ 5.000** exige cotización y la decisión de Eficiencia de Flota antes de aprobarse
  (Fase 3).
- **Metas a 12 meses:**
  - correctivo por debajo del 25 %;
  - preventivo a tiempo en al menos 90 % de los servicios;
  - días fuera de servicio registrados en todas las OT.

## Pruebas

`supabase/tests/caja_c30_plan_mantenimiento.test.sql` comprueba:

- la clasificación por sistema;
- los equipos en Flota;
- el horómetro válido, el menor y el salto imposible;
- que un punto crítico cree la falla;
- el historial por permiso;
- el aviso de fallas.

También informa el vínculo de cada unidad de transporte con Flota.

`supabase/tests/caja_c31_plan_mantenimiento_f2_f3.test.sql` comprueba:

- los planes creados, inactivos y con línea base;
- la validación con permiso y su rechazo sin permiso;
- el bloqueo de la reparación mayor sin cotización;
- el plan anual con presupuesto y su acceso por permiso;
- las fallas en Eficiencia de Flota;
- las unidades nuevas.

También informa los planes por validar, los odómetros actualizados y el presupuesto.
