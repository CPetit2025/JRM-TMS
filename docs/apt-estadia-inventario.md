# APT — Control y estadía del inventario (Almacén de Producto Terminado)

Objetivo: verificar la **permanencia** del material en APT (bodega 647-04 ALM PT): cuánto hay, de qué NumRel, producto y
glosa, desde cuándo, cuánto salió y qué conviene liberar primero. Todo nace de las hojas **ENTRADA** (P/E Producción) y
**SALIDA** (Despacho Ventas) que se cargan a diario.

## Uso diario
1. *Almacén APT → Carga Diaria APT* (`/apt/cargas`): subir el `.xlsx` con las hojas ENTRADA y SALIDA (un libro o dos archivos).
2. Revisar la vista previa (filas, fechas, TN, filas excluidas) y confirmar.
3. La carga **reemplaza**, por hoja, los movimientos del rango de fechas que trae el archivo: sirve tanto el acumulado del
   año como solo el día, sin duplicar.
4. Revisar *Calidad de datos*: la conciliación fuente vs modelo debe estar en OK.

Permisos: `apt` (ver el módulo) y `apt-carga` (cargar y cambiar parámetros). El Administrador y el Jefe de Distribución
tienen ambos.

## Reglas del modelo
| Concepto | Regla |
|---|---|
| NumRel padre (lote) | ENTRADA: columna Lote; si falta, NumRel de la OP sin su último tramo (16325-S002-033 → 16325-S002). SALIDA: NumRel; las salidas "ERROR DE CONTRATO" van a su Lote. Coincide con el código de la OT en Contratos. |
| Clave | Lote \| Producto |
| Peso | \|PesoTotalProduccido\| en kg; TN = kg / 1000. La Cantidad tiene unidades mezcladas (UND, CIEN, KG…) y no se suma. |
| FIFO | Cada fila de ENTRADA es una capa. Las salidas de la misma clave consumen primero las capas más antiguas. |
| Días del saldo | Fecha de corte − fecha de ingreso de la capa. |
| Permanencia de lo despachado | Fecha de salida − fecha de ingreso, ponderada por kg. |
| TN×Días | Saldo TN × días del saldo. Es la prioridad para liberar espacio. |
| Aging ponderado | Σ(TN × días) / Σ TN del saldo. |
| Fecha de corte | La fecha máxima de los datos, o una manual en Parámetros. |
| Estados | En APT (sin salidas, dentro del plazo de alerta) · Salida parcial · Despachado (saldo ≤ tolerancia, 2 %) · Sin salida identificada (sin salidas y más días que la alerta, 60) · Problema de información (ingreso sin peso o salida registrada antes del ingreso). |
| Salidas | Despacho de lo ingresado · Excede lo ingresado (stock anterior al periodo) · Otro producto del lote (no ingresó por APT: pernería, accesorios) · Lote sin ingreso en el periodo · Sin NumRel. |
| FechaEntrega | Se analiza por separado; nunca reemplaza la fecha de ingreso APT. |

Una salida registrada antes del ingreso que consume se asigna igual (el ingreso se registró tarde), con 0 días, y
marca la capa como "Problema de información".

El inventario reconstruido por fecha (tendencias, inventario acumulado) parte de las entradas cargadas. El stock
anterior a la primera carga aparece como "Excede lo ingresado" o "Lote sin ingreso".

## Técnica
- Migración `supabase/migrations/20261002100000_apt_estadia_inventario.sql`:
  - Tablas `apt_uploads`, `apt_movements` (fila original en `raw` más la versión normalizada) y `apt_settings` / `apt_aging_ranges`.
  - Resultado del modelo en `apt_layers`, `apt_allocations` y `apt_exit_class`.
  - Funciones `apt_*`.
- El modelo se recalcula (`apt_model_rebuild`) después de cada carga y de cada cambio de parámetros.
- Prueba: `supabase/tests/caja_c16_apt_estadia.test.sql`.
- Pantallas en `src/app/(dashboard)/apt/*`, con base común en `src/lib/apt/*` y `src/components/apt/*`.
- JRM IA: herramienta `get_apt_status` (permiso de IA `ia:read:inventarios` más el módulo `apt`).
