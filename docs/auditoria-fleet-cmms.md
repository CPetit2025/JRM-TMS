# AUDITORÍA FASE 0 — JRM-TMS FLEET MANAGEMENT + CMMS + APP CONDUCTOR
> **Generado por:** Arquitecto + Data Agent + CMMS Agent + TMS Agent + App Agent
> **Fecha:** 2026-09-23
> **Estado:** PENDIENTE VEREDICTO AUDITOR INDEPENDIENTE
> **Modo:** SOLO LECTURA — Cero líneas de código modificadas

---

## RESUMEN EJECUTIVO

El ecosistema JRM-TMS cuenta con una base funcional significativa. Sin embargo, presenta **deuda técnica crítica** en áreas específicas que, si no se resuelven antes de implementar las fases siguientes, generarán inconsistencias sistémicas difíciles de revertir. Los hallazgos más graves son:

1. **Odómetro con 3 columnas paralelas** sin fuente de verdad consolidada.
2. **Preventivos CMMS con lógica de proyección mockeada** — no conectados a datos reales.
3. **Inventario de repuestos sin kardex ni control de existencias** — solo catálogo estático.
4. **Transiciones de estado del despacho ejecutadas con UPDATE directo** desde el frontend, sin RPCs de negocio.
5. **4 tablas paralelas de gastos** con riesgo de fragmentación de datos.
6. **Estados de vehículos inconsistentes** (MANTENIMIENTO vs EN_MANTENIMIENTO) en triggers distintos de diferentes migraciones.

---

## 1. ARQUITECTURA ACTUAL

### 1.1 Estructura de la Plataforma

```
JRM-TMS
├── Dashboard Web (Next.js App Router)
│   ├── /contratos              Gestión de portafolios y contratos
│   ├── /solicitudes            Requerimientos de transporte
│   ├── /despacho               Planificación y ejecución de despachos
│   ├── /torre-control          Monitoreo en tiempo real (Supabase Realtime)
│   ├── /mantenimiento          CMMS
│   │   ├── /gestor-ot
│   │   ├── /preventivos        ⚠️ LÓGICA MOCKEADA
│   │   ├── /inventario         ⚠️ SIN KARDEX
│   │   ├── /neumaticos
│   │   ├── /proveedores
│   │   └── /flota/[plate]
│   ├── /flota                  Gestión maestra de vehículos
│   ├── /clientes               CRM básico
│   ├── /usuarios               Gestión de roles
│   ├── /caja                   Finanzas y costos
│   ├── /monitoreo              Rastreo de viajes
│   └── /configuracion
│
├── App Nativa Conductor (Next.js + Capacitor Android, ID: com.jrm.tms)
│   ├── /app/login + /register
│   ├── /app/(app)/ruta             Ejecución de despacho [COMPLETO]
│   ├── /app/(app)/checklist        Inspección pre-ruta [COMPLETO]
│   ├── /app/(app)/viajes           Historial y próximos viajes [COMPLETO]
│   ├── /app/(app)/tareo            Control de jornada laboral [COMPLETO]
│   ├── /app/(app)/gastos           Registro de gastos [COMPLETO]
│   ├── /app/liquidacion            Cierre de documentos [COMPLETO]
│   ├── /app/(app)/fallas           Reporte de incidencias [PARCIAL — tabla incorrecta]
│   ├── /app/(app)/perfil           Datos del conductor [COMPLETO]
│   ├── /app/(app)/alertas          Pendientes operativos [COMPLETO]
│   └── /app/(app)/actividades      Historial de tareo [COMPLETO]
│
├── APIs Backend (/src/app/api/)
│   ├── /jrm-ai             Copiloto AI (Google Gemini + OpenAI dual — redundancia)
│   ├── /extract-invoice    OCR de comprobantes con IA
│   ├── /drivers            Gestión de conductores
│   ├── /register-driver    Alta de conductores
│   ├── /sunat              Integración SUNAT
│   └── /app-version        Control versiones APK
│
└── Tracking Público
    └── /tracking/[token]   Visibilidad para clientes externos
```

### 1.2 Stack Tecnológico
- **Frontend:** Next.js 15, React, TypeScript, TailwindCSS
- **Backend:** Supabase (PostgreSQL 15, RLS, Realtime, Storage)
- **App Nativa:** Capacitor v8, Android (`com.jrm.tms`)
- **GPS:** `@capacitor/geolocation` (nativo, background), `navigator.geolocation` (fallback web)
- **IA:** Google Gemini + OpenAI (coexistencia detectada — ver hallazgos)
- **Deploy:** Vercel (OTA para UI), APK para plugins nativos
- **OTA:** Todos los módulos de UI se actualizan OTA sin nueva compilación APK

---

## 2. ARQUITECTURA OBJETIVO

```
CONTRATOS
   ↓
REQUERIMIENTO DE TRANSPORTE
   ↓
PLANIFICACIÓN / DESPACHO
   ↓
MOTOR DE ELEGIBILIDAD (VehicleDriverEligibilityService) [FALTANTE]
   ↓
APP CONDUCTOR (Android Nativo)
   ↓
VIAJE
   ├── GPS (nativo Capacitor)
   ├── CHECKLIST PRE-RUTA (Odómetro + Geocerca) [COMPLETO]
   ├── CHECKLIST POST-RUTA [FALTANTE]
   ├── COMBUSTIBLE (con cálculo km/gal) [PARCIAL]
   ├── GASTOS (con OCR) [COMPLETO]
   ├── EVIDENCIAS (fotos por parada) [COMPLETO]
   └── FALLAS → maintenance_request [PARCIAL — tabla incorrecta]
          ↓
         CMMS
          ├── OT con cierre técnico [PARCIAL]
          ├── Preventivos con odómetro real [FALTANTE]
          ├── Inventario con kardex [FALTANTE]
          └── Neumáticos con historial [PARCIAL]
          ↓
       FLOTA 360 (vista unificada) [PARCIAL]
          ↓
TORRE DE CONTROL / ANALÍTICA / COPILOTO AI
```

---

## 3. GAP ANALYSIS

### 3.1 Por Módulo

| Módulo | Estado Actual | Gap Principal |
|--------|--------------|---------------|
| Contratos | ✅ COMPLETO | Ninguno |
| Solicitudes de Transporte | ✅ COMPLETO | Ninguno |
| Planificación / Despacho | ⚠️ PARCIAL | Transiciones de estado sin RPC |
| Motor de Elegibilidad | ❌ FALTANTE | Gap total — no existe |
| Torre de Control | ✅ COMPLETO | Ninguno |
| GPS / Rastreo | ✅ COMPLETO | Ninguno |
| Checklist Pre-Ruta | ✅ COMPLETO | Ninguno |
| Checklist Post-Ruta | ❌ FALTANTE | Gap total |
| Combustible integrado | ⚠️ PARCIAL | Sin cálculo km/gal |
| Gastos del Conductor | ✅ COMPLETO | Ninguno |
| Liquidación | ✅ COMPLETO | Ninguno |
| Fallas → CMMS | ⚠️ PARCIAL | Inserta en tabla incorrecta |
| Gestor OT | ⚠️ PARCIAL | Estados inconsistentes, sin firma |
| Preventivos CMMS | ❌ CRÍTICO | Completamente mockeado |
| Inventario Repuestos | ❌ CRÍTICO | Solo catálogo, sin kardex |
| Neumáticos | ⚠️ PARCIAL | Sin historial trazable |
| Proveedores | ⚠️ PARCIAL | Sin evaluación SLA |
| Flota 360 | ⚠️ PARCIAL | Datos fragmentados |
| Perfil Conductor | ✅ COMPLETO | Sin indicadores objetivos de rendimiento |
| Costos / TCO | ❌ FALTANTE | Módulo inexistente |
| Centro de Notificaciones | ⚠️ PARCIAL | Alertas y Actividades separadas |
| Copiloto AI | ✅ COMPLETO | Humanización y voz pendientes |
| Odómetro (fuente de verdad) | ❌ CRÍTICO | 3 columnas paralelas |
| Ciclo de Viaje (estados) | ⚠️ PARCIAL | Saltos posibles desde UI |
| Motor de Eventos de Dominio | ❌ FALTANTE | No existe |
| MTBF / KPIs completos | ⚠️ PARCIAL | MTBF faltante, MTTR en días |
| Seguridad RLS completa | ⚠️ PARCIAL | Tablas iniciales potencialmente débiles |

---

## 4. TABLAS DE BASE DE DATOS

### 4.1 Tablas Duplicadas o Solapadas — RIESGO CRÍTICO

| Conflicto | Tablas Involucradas | Severidad |
|-----------|---------------------|-----------|
| Sistema de gastos fragmentado | `expense_liquidations`, `dispatch_expenses`, `expenses`, `expense_records` | 🔴 CRÍTICO |
| Odómetro con 3 fuentes | `vehicles.odometer`, `vehicles.current_mileage`, `vehicles.current_odometer` | 🔴 CRÍTICO |
| Sistema de OTs duplicado | `work_orders` (obsoleta) + `maintenance_orders` (actual) | 🟡 ALTO |
| Rutas duplicadas | `routes`/`route_stops` (obsoletas) + `dispatches`/`dispatch_requests` (actuales) | 🟡 ALTO |
| Presupuestos duplicados | `transport_budgets` + `contract_budgets` | 🟠 MEDIO |

### 4.2 Máquinas de Estado

**`vehicles.status` (INCONSISTENTE):**
```
DISPONIBLE | ASIGNADA | EN_RUTA | MANTENIMIENTO | EN_MANTENIMIENTO | INACTIVA | BLOQUEADA
                                      ↑                 ↑
                               Trigger 00030     Trigger 00024
                               (inconsistentes entre sí)
```

**`dispatches.status`:**
```
PROGRAMADO → EN_CURSO → EN RUTA → ESPERANDO_AUTORIZACION
                                  → RETORNO → RETORNO_COMPLETADO
                                              → LIQUIDADO | CERRADO | FINALIZADO
```
> ⚠️ `EN_CURSO` y `RETORNO` se asignan con UPDATE directo sin RPC.

**`transport_requests.status`:**
```
PENDIENTE → PENDIENTE DE APROBACIÓN → APROBADA → ASIGNADA → EN TRANSITO → ENTREGADA
                                    → RECHAZADA | CANCELADA | REPROGRAMADA
```

### 4.3 Fuente de Verdad del Odómetro

| Columna | Actualizado por | Estado |
|---------|----------------|--------|
| `vehicles.odometer` | Schema inicial | ⚠️ En desuso |
| `vehicles.current_mileage` | GPS (close_dispatch_route anterior) | ⚠️ Desconectado del GPS por migración reciente |
| `vehicles.current_odometer` | `record_odometer_reading` (checklist) | ✅ FUENTE DE VERDAD actual |
| `vehicle_odometer_logs` | `record_odometer_reading` | ✅ Historial auditable |

### 4.4 Índices Faltantes — FK sin Índice (Riesgo de Full Scan)

| Tabla | Columna FK sin índice | Impacto |
|-------|----------------------|---------|
| `dispatch_requests` | `transport_request_id` | 🔴 ALTO — consultas frecuentes |
| `expenses` | `dispatch_id` | 🔴 ALTO |
| `dispatch_expenses` | `dispatch_id` | 🔴 ALTO |
| `dispatch_events` | `user_id` | 🟠 MEDIO |
| `vehicle_maintenance_records` | `dispatch_id` | 🟠 MEDIO |

### 4.5 Triggers Identificados

| Trigger | Tabla | Acción |
|---------|-------|--------|
| `trigger_update_vehicle_status` | `vehicle_maintenance_records` | Cambia estado a `EN_MANTENIMIENTO` ← INCONSISTENTE |
| `trigger_vehicle_status_maintenance` | `maintenance_work_orders` | Cambia estado a `MANTENIMIENTO` ← INCONSISTENTE |
| `sync_driver_to_profile` | `drivers` | Sincroniza datos con `profiles` |
| `sync_profile_to_driver` | `profiles` | Sincroniza datos con `drivers` |
| `route_track_before_insert` | `route_track_points` | Calcula distancia GPS y detecta gaps |
| `driver_checklist_validate` | `driver_checklists` | Valida geocerca antes de insertar |
| `validate_contract_assignment` | `contract_user_assignments` | Verifica rol Administrador de Contratos |
| `track_new_contract` | `contracts` | Previene manipulación de jerarquía |
| `assign_new_contract_creator` | `contracts` | Auto-asigna propiedad al creador |
| `profiles_assign_primary_site` | `profiles` | Asigna sede PRINCIPAL a nuevos empleados |

### 4.6 Columnas Creadas Sin Uso Aparente

| Tabla | Columna | Motivo |
|-------|---------|--------|
| `vehicles` | `odometer` | Reemplazada por `current_odometer` |
| `work_orders` | `weight`, `volume` | Nunca migradas a `transport_requests` |
| `transport_budgets` | `budget_limit` | Reemplazado por `contract_budgets` |

### 4.7 Top 10 RPCs Críticas

| RPC | Función |
|-----|---------|
| `save_transport_request` | Guarda/edita solicitudes validando saldo del contrato |
| `schedule_dispatch` | Programa despacho con validación de presupuesto |
| `start_dispatch_route` | Inicia ruta — verifica checklist aprobado y geocerca |
| `complete_dispatch_stop` | Marca entrega con validación de secuencia y foto |
| `close_dispatch_route` | Cierra/liquida ruta, consume presupuesto final |
| `record_odometer_reading` | Registra odómetro manual con validación de saltos |
| `record_route_track_point` | Inserta GPS con Haversine y detección de gaps |
| `create_portfolio_contract` | Crea contrato raíz de manera transaccional |
| `ai_confirm_trip_action` | Procesa intenciones del Copiloto AI con validaciones |
| `execute_driver_offline_action` | Sincroniza transacciones móvil offline → online |

---

## 5. HALLAZGOS POR SEVERIDAD

### 🔴 CRÍTICOS (Bloquean implementación segura)

| # | Hallazgo | Módulo | Evidencia |
|---|----------|--------|-----------|
| C1 | Motor de preventivos CMMS completamente mockeado | CMMS | `preventivos/page.tsx` L96: "Para demo, simulamos..." |
| C2 | Inventario sin kardex — no descuenta stock en OT | CMMS | Sin tablas de bodega, existencias ni movimientos |
| C3 | 3 columnas de odómetro paralelas sin fuente de verdad consolidada | BD | `vehicles.odometer`, `.current_mileage`, `.current_odometer` |
| C4 | 4 tablas de gastos fragmentadas — riesgo de doble contabilización | BD | `expense_liquidations`, `dispatch_expenses`, `expenses`, `expense_records` |
| C5 | Motor de elegibilidad inexistente — validaciones dispersas en UI | TMS | Sin servicio central, checks manuales en `despacho/page.tsx` |

### 🟡 ALTOS

| # | Hallazgo | Módulo | Evidencia |
|---|----------|--------|-----------|
| A1 | Transiciones `EN_CURSO` y `RETORNO` via UPDATE directo sin RPC de negocio | TMS | `despacho/page.tsx` — supabase.from().update() sin validaciones backend |
| A2 | `MANTENIMIENTO` vs `EN_MANTENIMIENTO` — dos triggers con valores distintos | BD | Migrations 00024 (EN_MANTENIMIENTO) y 00030 (MANTENIMIENTO) |
| A3 | Estado OT: frontend usa `FINALIZADA`, trigger de vehículo espera `COMPLETADO` | CMMS | `gestor-ot/page.tsx` vs trigger |
| A4 | Fallas desde App insertan en `vehicle_maintenance_records`, no en `maintenance_request` | App/CMMS | `fallas/page.tsx` |
| A5 | Ruta `/mantenimiento/fallas` referenciada en dashboard pero NO EXISTE | CMMS | Dashboard → 404 |
| A6 | Validación de documentos requeridos solo en frontend de despacho | TMS | `despacho/page.tsx` `startRoute()` |
| A7 | Tablas del MVP inicial con RLS potencialmente débil (FOR ALL USING true) | Seguridad | Migraciones iniciales sin refactorizar |

### 🟠 MEDIOS

| # | Hallazgo | Módulo |
|---|----------|--------|
| M1 | Neumáticos sin historial trazable de cambios de estado (montaje/desmontaje) | CMMS |
| M2 | MTBF no implementado; MTTR en días no en horas | CMMS |
| M3 | `ActiveTripContext` escribe en React State + localStorage + DOM Events (fuentes paralelas) | App |
| M4 | OSRM de demostración en `routing.ts` — no apto para producción con carga real | Arquitectura |
| M5 | Coexistencia de `openai` y `@google/generative-ai` — bundle innecesariamente grande | Arquitectura |
| M6 | `exceljs` + `xlsx` — dos librerías para el mismo propósito | Arquitectura |
| M7 | Proveedores sin evaluación SLA ni KPIs de desempeño | CMMS |
| M8 | Lógica de dominio embebida en herramientas de IA (`tools.ts`) en lugar de servicios centrales | Arquitectura |

### 🟢 BAJOS

| # | Hallazgo | Módulo |
|---|----------|--------|
| B1 | `work_orders` obsoleta coexiste con `maintenance_orders` sin limpieza | BD |
| B2 | `routes`/`route_stops` obsoletas coexisten con `dispatches` sin limpieza | BD |
| B3 | Lógica de versión APK embebida directamente en componente React | App |
| B4 | 5 FK sin índice explícito en tablas transaccionales de alto volumen | BD |

---

## 6. FUNCIONALIDADES YA EXISTENTES (Prohibido duplicar)

Las siguientes funcionalidades están **completamente implementadas**:

- ✅ Autenticación, roles y permisos (Supabase Auth + RLS)
- ✅ Ciclo completo de contratos y control presupuestal
- ✅ Solicitudes de transporte con aprobación/rechazo
- ✅ Planificación y agrupación de despachos
- ✅ GPS tracking con sincronización offline (cola de eventos)
- ✅ Checklist pre-ruta con geocerca obligatoria y captura de odómetro
- ✅ Marcado de paradas con foto obligatoria
- ✅ Retorno con geocerca a base autorizada
- ✅ Gastos del conductor (peajes, combustible) con OCR por IA
- ✅ Liquidación de documentos (GRs, facturas)
- ✅ Torre de Control en tiempo real (Supabase Realtime)
- ✅ Tracking público por token para clientes
- ✅ Copiloto AI transaccional con confirmación del conductor
- ✅ Gestión maestra de vehículos y conductores
- ✅ Control básico de neumáticos (estado y posición)
- ✅ Dashboard CMMS con disponibilidad y MTTR
- ✅ Integración SUNAT básica

---

## 7. ESTRATEGIA DE MIGRACIÓN

### Principios
1. No eliminar tablas antiguas sin migrar datos primero.
2. Las columnas redundantes se deprecan con comentario antes de eliminar.
3. Cada migración debe ser idempotente (`CREATE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
4. Los RPCs se crean como `OR REPLACE` para no romper dependencias existentes.
5. Ninguna Fase siguiente comienza hasta Gate 100% de la Fase anterior.

### Acciones Pre-Fase 1 (Prerequisitos)

| Prioridad | Acción | Riesgo si no se hace |
|-----------|--------|---------------------|
| P1 | Consolidar 3 columnas de odómetro — deprecar `odometer`, definir rol de `current_mileage` como GPS y `current_odometer` como fuente oficial | Preventivos alertan en km incorrectos |
| P2 | Unificar estado OT: `FINALIZADA` → `COMPLETADO` en frontend | Trigger de vehículo no se dispara correctamente |
| P3 | Unificar estados de vehículo: `EN_MANTENIMIENTO` → `MANTENIMIENTO` en migrations 00024 | Estados inconsistentes en filtros de despacho |
| P4 | Crear tabla estandarizada `maintenance_requests` para fallas de App | Fallas no llegan al CMMS |
| P5 | Agregar índices a 5 FKs críticas | Full table scans en producción |

---

## 8. DEPENDENCIAS ENTRE FASES

```
Fase 0 (Auditoría) — ESTE DOCUMENTO
    ↓ [Gate 100%]
Fase 1 (Motor de Estados): Prerequisitos P1, P2, P3 resueltos
    ↓
Fase 2 (Motor Elegibilidad): Requiere Fase 1
    ↓
Fase 3 (Ciclo Viaje): Requiere Fase 2 + A1 (RPCs prepare_dispatch, authorize_return)
    ↓
Fase 4 (Checklist Pre-Ruta): Paralelo a Fase 3
Fase 5 (Checklist Post-Ruta): Requiere Fase 4
    ↓
Fase 6 (App ↔ CMMS): Requiere P4 + Fase 5
    ↓
Fase 7 (CMMS Avanzado): Requiere C1 + C2 resueltos
    ↓
Fase 8 (Combustible): Paralelo a Fase 7
Fase 9 (Costos/TCO): Requiere C4 (gastos consolidados) + Fase 8
    ↓
Fase 10 (Flota 360): Requiere Fases 7, 8, 9
Fase 11 (Perfil 360): Requiere Fase 3 + 8
    ↓
Fase 12-13 (Torre Control + Notificaciones): Requieren todas las anteriores
    ↓
Fase 14-15 (Viajes/Tareo + IA): Paralelas, requieren Fase 3
    ↓
Fases 16-17 (Eventos + Seguridad): Transversales
    ↓
Fases 18-20 (Performance + Auditoría Final)
```

---

## 9. RIESGOS IDENTIFICADOS

| Riesgo | Probabilidad | Impacto | Fase que lo mitiga |
|--------|-------------|---------|-------------------|
| Preventivos alertan en km incorrectos | ALTA | CRÍTICO | Fase 4 |
| Doble contabilización de gastos | ALTA | CRÍTICO | Fase 9 |
| Bypass de elegibilidad en asignación | ALTA | ALTO | Fase 2 |
| Vehículo liberado sin validación completa post-OT | MEDIA | ALTO | Fase 7 |
| Falla reportada no llega al CMMS | ALTA | ALTO | Fase 6 |
| Usuario autenticado saltando reglas de negocio en despacho | ALTA | ALTO | Fase 3 |
| Datos de odómetro inconsistentes en preventivos | ALTA | CRÍTICO | Fase 1 (Pre) |

---

## RESULTADO DE FASE 0

```
┌─────────────────────────────────────────────────┐
│  FASE 0 — AUDITORÍA COMPLETA                    │
│                                                 │
│  Hallazgos Críticos:         5                  │
│  Hallazgos Altos:            7                  │
│  Hallazgos Medios:           8                  │
│  Hallazgos Bajos:            4                  │
│                                                 │
│  Funcionalidades existentes documentadas: 18    │
│  Gaps documentados: 14 módulos                  │
│  Prerequisitos para Fase 1 identificados: 5     │
│                                                 │
│  Código modificado:          0 líneas           │
│  Migraciones creadas:        0                  │
│  Datos alterados:            0                  │
│                                                 │
│  PENDIENTE: Veredicto del Auditor Independiente │
└─────────────────────────────────────────────────┘
```
