# Caja de transporte

La caja deja de ser un registro de gastos y controla el dinero de cada viaje de principio a fin:

**Presupuesto (tarifario) → Anticipo al conductor → Gastos en ruta → Aprobación → Liquidación del viaje → Costo real (TCO y rentabilidad)**

| Fase | Migración | Pruebas | Documento |
|---|---|---|---|
| C1 · Registro y aprobación de gastos | `20260929090000_caja_c1_aprobacion_gastos.sql` | `caja_c1_aprobacion.test.sql` — 13/13 | [01-c1-aprobacion-gastos.md](01-c1-aprobacion-gastos.md) |
| C2 · Cajas, anticipos, cuenta corriente y liquidación | `20260929100000_caja_c2_cajas_anticipos.sql` | `caja_c2_cajas_anticipos.test.sql` — 14/14 | [02-c2-cajas-anticipos.md](02-c2-cajas-anticipos.md) |
| C3 · Tarifario, reglas, combustible y reportes | `20260929110000_caja_c3_tarifario_combustible_reportes.sql` | `caja_c3_tarifario_combustible.test.sql` — 7/7 | [03-c3-tarifario-combustible-reportes.md](03-c3-tarifario-combustible-reportes.md) |
| C4 · Anticipos solicitados desde la app | `20260929130000_caja_c4_anticipos_desde_app.sql` | En `caja_c2_...` (T13–T14) | [04-c4-anticipos-desde-app.md](04-c4-anticipos-desde-app.md) |

## Pantallas

| Ruta | Permiso | Contenido |
|---|---|---|
| `/caja` | `caja` | Panel: saldos de cajas, dinero por rendir, gastos por aprobar, viajes por liquidar, gasto del mes |
| `/caja/gastos` | `caja-gastos` | Registro web (viaje o unidad sin viaje), pagador, comprobante con IA, "Mis gastos" con corrección |
| `/caja/aprobaciones` | `caja-aprobacion` | **Bandeja de aprobación** (solo Administrador y Jefe de Distribución) |
| `/caja/anticipos` | `caja-anticipos` | Presupuesto por tarifa, solicitud y entrega de anticipos |
| `/caja/liquidaciones` | `caja-liquidaciones` | Cuadre anticipo vs gastos y cierre con devolución, reembolso o planilla |
| `/caja/conductores` | `caja-anticipos` o `caja-liquidaciones` | Cuenta corriente, antigüedad de saldos y estado de cuenta |
| `/caja/cajas` | `caja-fondos` | Cajas, libro de movimientos, arqueo, solicitud de reposición (reemplaza `/caja/fondos`) |
| `/caja/combustible` | `caja-combustible` | Cargas, rendimiento km/gal, grifos, facturas y conciliación |
| `/caja/tarifario` | `caja-tarifario` (lectura con cualquier permiso de caja) | Tarifas por ruta, categorías (tope, comprobante, cuenta contable), parámetros (Administrador) |
| `/caja/reportes` | `caja` | Rentabilidad por viaje, presupuesto vs real, exportación contable |
| App `/app/gastos` | conductor | **Solicitar anticipo**, anticipo y saldo, estado y observación de cada gasto, corrección de observados |
| App `/app/liquidacion` | conductor | Cierre de ruta (odómetro, guías, total declarado) y conformidad de sus liquidaciones |

## Rol Jefe de Distribución

La migración C1 crea el rol **Jefe de Distribución** (C2 y C3 le agregan permisos):
`dashboard`, `despacho:read`, `monitoreo:read`, `torre-control:read`, `caja`, `caja-gastos`, `caja-aprobacion`,
`caja-liquidaciones`, `caja-anticipos`, `caja-combustible`.

El permiso `caja-aprobacion` solo lo tienen el Administrador (por su rol) y el Jefe de Distribución. Se puede
revisar en **Roles y Permisos** → grupo *Caja de Transporte*.

## Puesta en marcha

1. Aplicar las tres migraciones en orden (`npx supabase db push`).
2. Asignar el rol **Jefe de Distribución** a los usuarios que aprueban (Usuarios → rol).
3. En **Cajas y fondos**: crear las cajas (caja chica por sede, cuenta bancaria) y registrar la apertura.
4. En **Tarifario y reglas**: cargar las rutas frecuentes, revisar topes y cuentas contables; el Administrador
   define la doble aprobación (desactivada por defecto) y el plazo de rendición (48 h).
5. En **Control de combustible**: registrar los grifos con crédito y, por unidad, el rendimiento esperado y el tanque.

## Pruebas

Cada archivo termina en error a propósito para forzar `ROLLBACK` (mismo formato que `supabase/tests` de CMMS):

```bash
npx supabase db query --linked -f supabase/tests/caja_c1_aprobacion.test.sql
npx supabase db query --linked -f supabase/tests/caja_c2_cajas_anticipos.test.sql
npx supabase db query --linked -f supabase/tests/caja_c3_tarifario_combustible.test.sql
```

Requieren al menos 5 perfiles y un Administrador (reasignan roles dentro de la transacción).
