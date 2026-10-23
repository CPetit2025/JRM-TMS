# Mantenimiento de flota: registro único, importación del Excel y reglas de las OT

Migración `supabase/migrations/20261023100000_mant_registros_flota.sql`. Prueba SQL `supabase/tests/caja_c136_mant_registros_flota.test.sql`.
Prueba del importador `node --test scripts/test-mant-import.cjs`.

## Modelo

| Necesidad | Dónde | Nota |
|---|---|---|
| Activos | `vehicles` + columnas `asset_class` (VEHICULAR, MONTACARGAS, ELEVACION, APILADOR, TRANSPALETA), `display_name`, `meter_type` (KM u HORAS), `assigned_area`, `manufacture_year`, `decommissioned_at`, `decommission_reason` | No hay tabla de activos nueva. La baja es una fecha con motivo (no cambia el estado operativo). `fe_assets` sigue como ficha económica de Eficiencia. |
| Gasto de mantenimiento | `mant_registros` | Fuente única: historial del Excel y, más adelante, OT y Caja. Guarda el dato original (`tipo_origen`, `km_hrs_original`, `fila_original` completa) y el corregido (`tipo`, `km_hrs_validado`, `obs_medidor`, `criterio_tipo`). |
| Lecturas | `mant_lecturas` | Excel, OT, inspección, manual y turno, con observación de calidad, valor validado y motivo cuando se confirma una lectura fuera de rango. |
| Proveedores | `maintenance_providers` + `mant_proveedor_alias` | Los creados desde el historial llevan RUC provisional `PENDIENTE-…` (no es un RUC): completar. |
| Activos del Excel | `mant_activo_alias` | Nombre del Excel → unidad de Flota. |
| Importaciones | `mant_importaciones` | Archivo, huella, conteos y reporte. |
| Eficiencia y Plan | `fe_maint` | **Copia derivada** de `mant_registros` (`mant_sync_fe_maint`). Se regenera al importar, al revisar una equivalencia y después de cada carga de Eficiencia de Flota, para no contar dos veces. |

Pantalla: *Flota y Mantenimiento → Activos y equivalencias* (`/mantenimiento/activos`): ficha de cada activo (clase, medidor, área, año, baja), registro de activos nuevos (p. ej. la transpaleta eléctrica ERE120), lectura manual validada, revisión de equivalencias de activos y proveedores e historial de importaciones.

## Reglas que aplica el TMS desde ahora (OT)

Al **terminar** una OT (*Órdenes de Trabajo → Terminar* abre el «Cierre de taller»; el trigger `mant_ot_reglas` lo exige también en la base):

1. **Tipo obligatorio y coherente.** Una reparación, una avería o un cambio de componente (motor, caja, bomba, embrague, alternador, arrancador, turbo, radiador, diferencial, compresor, cilindro, inyectores, rodamientos, batería, contactor, controlador…) nunca es preventivo. Los consumibles (aceite, filtros, refrigerante, grasa, llantas) sí pueden serlo. Se valida en cualquier momento en que cambie el tipo o la descripción.
2. **Ingreso y salida de taller** con fecha y hora: parada real = salida − ingreso.
3. **Lectura de horómetro u odómetro** obligatoria, comparada con la anterior del activo (lecturas validadas o del historial sin revisar, y registros del conductor; no las marcadas con problema):
   retroceso o avance de más de **16 h/día** (equipos) o **1.200 km/día** (vehículos) → se avisa y solo se acepta con un motivo (p. ej. cambio de medidor). La lectura queda registrada como CONFIRMADA con su motivo.
4. **Moneda** (PEN o USD; en USD con tipo de cambio) y si el monto **incluye IGV**.

## Importar el Excel (y volver a importarlo cuando llegue uno nuevo)

Requisitos: Node 22 y las dependencias del proyecto (`npm ci`). El Excel debe tener la hoja **CONSOLIDADO** con sus encabezados
(ACTIVO, CLASE_ACTIVO, FECHA, PROVEEDOR, FACTURA, KM_HRS, PROX_MANTTO, FECHA_INGRESO, FECHA_SALIDA, MONTO, COMENTARIOS, TIPO_MANTTO,
AREA, CATEGORIA_COSTO, TIPO_ORIGEN, AÑO FABRICACIÓN y las columnas de calidad CRITERIO_TIPO_MANTTO, OBS_MEDIDOR, KM_HRS_VALIDADO,
DIA_CON_CORRECTIVO).

1. **Simulación (siempre primero):** no escribe nada; deja el reporte de cuadre y de problemas en la carpeta indicada.
   ```bash
   node scripts/mant-import.cjs --file "Mantenimiento_Flota_v5_Analisis_360.xlsx" --out mant-import-reportes
   ```
   Revise en el reporte: controles de aceptación (registros y monto total, por clase, ventana jul-2024 a jun-2026, montacargas y
   elevación con % correctivo), proveedores agrupados, registros rechazados y dudosos con su motivo, y datos faltantes.
2. **Equivalencias revisadas (opcional):** un JSON con los nombres a unir, por ejemplo
   `{"proveedores": {"BECERRA DONAYRES MAURO": "BECERRA DONAIRES MAURO"}}`, con `--equivalencias eq.json`. Después de importar, las
   equivalencias se revisan en `/mantenimiento/activos`.
3. **Aplicar en desarrollo o local:**
   ```bash
   node scripts/mant-import.cjs --file "Mantenimiento_Flota_v5_Analisis_360.xlsx" --apply --db "postgresql://usuario@host:puerto/base"
   ```
   Al final compara lo cargado en la base con el Excel por clase de activo y por año.
4. **Producción:** solo con confirmación explícita del responsable. Mismo comando con la cadena de conexión de producción
   (variable `MANT_DB_URL`, nunca escrita en el repositorio).

**Volver a importar es seguro.** La clave natural es activo + fecha + factura + monto + huella de la descripción + n.° de
repetición (dos líneas idénticas del Excel se conservan como 1 y 2). Un registro ya cargado no se duplica: si el Excel nuevo
corrige su clasificación, lectura validada, área, categoría, taller o RQ, se **actualiza** solo eso; el dato original no cambia.
Los registros que ya no estén en el Excel nuevo no se borran (se informan en el reporte si hiciera falta depurarlos).

**No se inventan datos.** Lo que falta queda vacío y se lista en `faltantes`. Rechazados (no se cargan): sin ACTIVO o con MONTO no
numérico. Dudosos (se cargan y se listan): sin fecha válida, sin monto, monto ≤ 0, PREVENTIVO con reparación o cambio de componente,
o lectura con observación distinta de OK. IGV del historial: desconocido. Ingreso y salida sin hora: 00:00 con aviso.

## Decisiones tomadas (aprobadas con «aplica todas tus recomendaciones»)

- Activos en `vehicles` y gasto en `mant_registros`; `fe_maint` derivada en lugar de una vista, porque la carga de Eficiencia la
  reescribe y las pruebas C27 y C28 la alimentan (en esas pruebas se desactiva la resincronización con
  `set_config('mant.sync_fe_maint', 'off', true)`).
- Baja como fecha con motivo; lecturas fuera de rango: aviso con motivo (no bloqueo); IGV histórico: desconocido.
- Pendiente del negocio: si la NN01 de Producción es la misma unidad del Excel reasignada o un equipo distinto (se registra en
  `/mantenimiento/activos`), y si «BCW 838 / ARB 976» se separa en tracto y semirremolque (hoy queda como un activo combinado).
