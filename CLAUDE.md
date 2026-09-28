@AGENTS.md

## Despliegue

Regla del dueño del repositorio: cuando un cambio está validado (pruebas SQL, `tsc`, `next build` y lint sin
errores nuevos), se mergea a `master` y se despliega automáticamente, sin pedir confirmación. Al llegar a `master`,
el workflow `deploy-production.yml` aplica las migraciones de Supabase, corre las pruebas de caja y despliega en
Vercel (ver `docs/despliegue-automatico.md`). Después de mergear, revisar el resultado del workflow y corregir si falla.

Confirmaciones automáticas: no pedir confirmación al usuario para corregir fallas, aplicar mejoras que se
desprenden de lo pedido, mergear ni desplegar. Se hace, se valida y se informa el resultado al final.

## Reglas para no repetir incidentes

1. **Antes de mergear**, el check `Verificación previa (PR)` debe estar en verde (`npm run check:guards` + `tsc`).
2. **Producción no coincide con las migraciones del repo** (historial no reproducible). En SQL nuevo:
   - No escribir ni leer columnas de tablas existentes sin verificar que existen en producción (ya fallaron
     `drivers.updated_at` y `vehicles.updated_at`). Para columnas opcionales usar `to_jsonb(t)->>'columna'`.
   - Tratar como "sin dato" los valores por defecto de producción (p. ej. `dispatches.actual_distance_km` es
     `NOT NULL DEFAULT 0`: usar `NULLIF(..., 0)`).
   - Las pruebas SQL deben respetar las restricciones reales: índices únicos `dispatch_one_active_driver`,
     `dispatch_one_active_vehicle`, `drivers_document_number_key`; perfiles sin `auth.users`; perfiles ya
     vinculados a conductores.
   - Probar localmente con el arnés "tipo producción" (sin esas columnas, con esos índices) antes de mergear.
3. **Después de cada despliegue** revisar el paso `Caja SQL tests` del workflow: un `FAIL` es un incidente y se
   corrige de inmediato con una migración nueva (nunca editar una migración ya aplicada).
4. **App del conductor**: el APK carga la web en vivo (`capacitor.config.ts` → `server.url`), así que los cambios
   llegan sin reinstalar. Nunca quitar `server`. Toda pantalla nueva en `src/app/app/(app)` necesita un acceso
   visible desde Inicio o Actividades (lo verifica `check:guards`).
