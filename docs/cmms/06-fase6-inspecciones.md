# Fase 6 — Inspecciones y checklist

Fecha: 2026-09-27 · Migración: `20260927180000_f6_inspecciones.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | El checklist pre-ruta de la App fallaba siempre: `validate_driver_checklist` exige `driver_checklists.photo_url`, pero la función no la enviaba (la foto iba dentro de `checklist_data`). Además escribía `dispatches.start_odometer`, que no existía (corregido en F3). |
| Crítico | Había dos fuentes de inspección: la App guardaba JSON en `driver_checklists` y el CMMS usaba `inspections`. Las fallas del checklist no pasaban por la misma regla. |
| Alto | Con una falla crítica en el pre-ruta, el despacho igual pasaba a `EN_CURSO`. |
| Alto | RLS: plantillas y preguntas visibles para todos, y cualquier usuario podía insertar inspecciones y resultados. |
| Medio | La pantalla de checklists solo listaba plantillas: no permitía crearlas, inspeccionar ni ver resultados. |
| Medio | Acentos corrompidos en la pantalla de checklist de la App ("PresiÃ³n", "RevisiÃ³n"). |

## Implementado

- **Plantillas:**
  - Tipos `PREOPERACIONAL`, `POSTOPERACIONAL`, `PERIODICA`, `SEGURIDAD` e `INSPECCION_TECNICA` (los tipos legados se normalizan).
  - Se asignan a tipos de activo, incluidos montacargas, apiladores y transpaletas.
  - Opciones de firma y de lectura obligatorias.
- **Preguntas:** criticidad; tipo de respuesta (OK/Malo, Sí/No, Pasa/Falla, número o texto); foto obligatoria; código estable.
- **`submit_inspection`, entrada única para web y App:**
  - Valida que la plantilla aplique al tipo de activo, que todas las preguntas estén respondidas y que estén las fotos y la firma obligatorias.
  - Registra odómetro u horómetro por la fuente autorizada (F5), sin retrocesos.
  - Guarda la ubicación y calcula el resultado: `PASSED`, `WARNING` (falla no crítica) o `FAILED` (falla crítica).
- **Automatización:** una respuesta crítica genera **una** falla `CRITICA` con foto, odómetro y horómetro (sin duplicados, F3). El motor bloquea la unidad (F2). El flujo sigue: Backlog → OT → cierre → Flota 360°.
- **App del conductor:**
  - El checklist pre-ruta (versión nueva y APK instalados) crea una inspección `PREOPERACIONAL` sobre la plantilla del sistema `APP_PRE_RUTA`. Esa plantilla está protegida: frenos, llantas y luces son críticos.
  - `driver_checklists` queda como registro del despacho, enlazado a la inspección.
  - Con una falla crítica la ruta no se inicia (`can_start: false`) y la App lo avisa.
- **RLS:**
  - Lectura por sede y permiso; el conductor ve solo sus inspecciones.
  - No hay inserción directa: todo entra por RPC.
  - Solo `mantenimiento-flota` administra plantillas.
- **UI (`/mantenimiento/checklists`):**
  - Indicadores y listado con detalle por pregunta.
  - Formulario de inspección con foto por pregunta, lecturas y firma dibujada (bucket `signatures`).
  - CRUD de plantillas.

## Pruebas

`supabase/tests/f6_inspecciones.test.sql` — **10/10 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Pregunta sin responder | Rechazada |
| T2/T3 | Falta foto obligatoria / falta firma | Rechazadas |
| T4/T5 | Plantilla de otro tipo de activo / lectura menor a la actual | Rechazadas |
| T6 | Inspección aprobada | Registra la lectura, la firma y el GPS |
| T7 | Falla no crítica | `WARNING`, sin falla generada ni bloqueo |
| T8 | Respuesta crítica | Una falla `CRITICA` con evidencia; unidad `BLOQUEADA` |
| T9 | Trazabilidad | Inspección → Falla → Backlog → OT → cierre → unidad `DISPONIBLE` → Flota 360° |
| T10 | Pre-ruta de la App con falla crítica | Inspección `APP` + registro de despacho enlazado; la ruta no se inicia |
| T11 | Pre-ruta sin falla crítica | La ruta se inicia (`EN_CURSO`, odómetro de salida) |
| T12 | Seguridad | Sin inserción directa, plantilla del sistema protegida, sin permiso no ve ni inspecciona |

Regresión: F1 a F5 y `cmms_regresion` PASS.

## Observaciones

- **APK nuevo pendiente.** Los APK instalados ya registran la inspección canónica, porque la lógica está en la base de datos. El aviso de `can_start` en pantalla requiere publicar un APK nuevo.
