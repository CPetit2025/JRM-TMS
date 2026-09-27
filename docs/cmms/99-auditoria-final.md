# Auditoría final — Evolución CMMS JRM-TMS a Fleet & Asset Management

Fecha: 2026-09-28 · Base de datos: Supabase (producción) · Frontend: Vercel (producción, `master`)

## Estado de despliegue

- **Migraciones:** 21 corregidas (base) + 12 de fases aplicadas en producción. `supabase migration list` no muestra pendientes.
- **Frontend:** cada fase se integró por PR a `master` (#17 a #28) y Vercel desplegó producción sin errores.
- **Rutas del CMMS y la App:** responden HTTP 200 en producción (Centro de Control, Flota 360, Fallas, OT, Preventivos, Inspecciones, Repuestos, Neumáticos, Cumplimiento, Proveedores, Finanzas/TCO, Copiloto, Contratos y Liquidación de alquiler, App).
- **Zona horaria de la base:** `America/Lima` (verificada en una sesión nueva).

## Matriz de cumplimiento

| Fase | Pruebas automáticas (producción, con rollback) | Resultado |
|---|---|---|
| F0 Auditoría | Auditoría inicial + revisión real fase por fase (hallazgos documentados en cada fase) | ✅ |
| F1 Flota 360° | `f1_activos_flota360` 10/10 | ✅ |
| F2 Elegibilidad | `f2_motor_elegibilidad` 19/19 | ✅ |
| F3 Fallas/Backlog | `f3_fallas_backlog` 16/16 | ✅ |
| F4 OT | `f4_ordenes_trabajo` 17/17 | ✅ |
| F5 Preventivos | `f5_preventivos` 12/12 | ✅ |
| F6 Inspecciones | `f6_inspecciones` 10/10 | ✅ |
| F7 Inventario | `f7_inventario` 14/14 | ✅ |
| F8 Neumáticos | `f8_neumaticos` 13/13 | ✅ |
| F9 Cumplimiento | `f9_cumplimiento` 13/13 | ✅ |
| F10 Proveedores | `f10_proveedores` 8/8 | ✅ |
| F11 Alquileres/TCO | `f11_alquileres_tco` 9/9 | ✅ |
| F12 Analítica/IA | `f12_kpis_copiloto` 11/11 (reconciliación manual de KPI) | ✅ |
| Regresión integral | `cmms_regresion` PASS | ✅ |

**Total: 152 pruebas automáticas + regresión**, ejecutadas contra la base de producción en transacciones revertidas después de cada despliegue. Además: `tsc` sin errores, `next build` OK y lint sin errores nuevos en los archivos de cada fase.

Ejecución de todas las pruebas:

```bash
for t in supabase/tests/*.test.sql; do npx supabase db query --linked -f "$t"; done
```

Cada archivo termina con `… PASS (n pruebas)` o `… FAIL: …` y revierte todo.

## Fallos de producción corregidos durante el proyecto

Estos fallos afectaban a producción antes de este trabajo:

1. **Checklist pre-ruta de la App:** fallaba siempre (columna `start_odometer` inexistente y `photo_url` no enviada).
2. **Reporte de fallas de la App:** fallaba siempre (`vehicles.updated_at` inexistente) y rechazaba las fallas críticas (restricción que exigía `'CRÍTICA'` con tilde).
3. **Transiciones de estado del vehículo:** las llamadas de 3 argumentos eran ambiguas (error `42725`), lo que rompía el cierre de OT, los reportes críticos y la liberación al cerrar un despacho.
4. **Acción de mantenimiento del Copiloto:** creaba OT con un estado inválido.
5. **Pantallas que no guardaban o se rompían:** Preventivos (columna inexistente, error ignorado), Inventario (se rompía con los datos reales) y Gestor de OT (vacío).
6. **Stock:** se descontaba dos veces al cerrar una OT.
7. **Permisos inexistentes:** varios controles usaban `has_tms_permission('mantenimiento')`, que ningún rol tiene; solo el Administrador podía operar.
8. **RLS "todo permitido" o "visible para todos":** solicitudes, repuestos, kardex, neumáticos, proveedores, documentos y auditoría falsificable.
9. **Datos que se habrían perdido:** la migración pendiente de Flota 360 convertía los 7 vehículos de producción a tipo `otros`.

## Pendientes y observaciones (no bloquean el despliegue)

| # | Tema | Acción recomendada |
|---|---|---|
| 1 | **UI no probada con sesión real.** Las pantallas se verificaron con `tsc`, lint, build y HTTP 200, pero no con un usuario autenticado en el navegador (requiere credenciales, que no ingreso). | Recorrer cada módulo con un usuario de cada rol. |
| 2 | **APK de la App.** Los APK instalados ya usan las reglas nuevas porque están en la base de datos. El aviso "no inicie la ruta" y el reporte con audio y "¿puede continuar?" requieren publicar un APK nuevo. | Ejecutar el workflow *Build signed Android APK*. |
| 3 | **Permiso de IA de mantenimiento.** Las herramientas de IA del CMMS requieren `ia:read:mantenimiento`; hoy solo lo tiene el Administrador. | Asignarlo en Permisos a los roles de mantenimiento o supervisión. |
| 4 | **Datos maestros vacíos:** documentos (SOAT/RT), planes preventivos, stock inicial y proveedores. Mientras falten, el motor declara las unidades `NO_APTO` al intentar liberarlas. | Cargar documentos, planes, stock inicial (como `INGRESO`) y proveedores. |
| 5 | **Concurrencia de inventario.** Está garantizada por el bloqueo de fila (`FOR UPDATE`) en el único trigger de stock; la prueba corre en una sola sesión. | Opcional: prueba de carga con dos sesiones. |
| 6 | **Ruta marcador de la App.** `src/app/app/(app)/mantenimiento/flota/[plate]/page.tsx` es un marcador sin enlaces. | Eliminarla o implementarla cuando se defina la ficha para conductores. |
| 7 | **Lint previo.** Archivos anteriores al proyecto (`flota/page.tsx`, `sidebar.tsx`) tienen errores de lint ajenos a este trabajo. | Limpieza en una tarea aparte. |
| 8 | **Respuesta de Gemini.** Las respuestas del modelo no tienen prueba automática. Las funciones que lo alimentan sí están probadas. | Validar con preguntas reales cuando se asigne el permiso de IA. |

## Documentación por fase

`docs/cmms/01…12-*.md` (hallazgos, diseño, pruebas y observaciones por fase) y este documento.
