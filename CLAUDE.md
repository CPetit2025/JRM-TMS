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

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
