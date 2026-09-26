# AUDITORÍA INTEGRAL JRM-TMS — FASE DE DIAGNÓSTICO (ESTADO ACTUAL)

## 1. INVENTARIO DEL SISTEMA

### Funcionalidades Existentes (Operativas)
- Motor de Estados (`transition_dispatch_status`) para despachos.
- Autenticación y Autorización básica (Supabase Auth).
- App Conductor: Checklist, Viajes, Liquidaciones (con dependencias de red en inicio).

### Funcionalidades Declaradas pero No Operativas (Inseguras o Incompletas)
- **Torre de Control:** Los enlaces a vehículos y contratos no funcionan por carecer de UUIDs en la consulta.
- **Elegibilidad de Flota:** Validaciones asimétricas; el frontend usa reglas que el backend no replica (Bypass en `schedule_dispatch`).
- **Control de Inventario CMMS:** Las órdenes de trabajo descuentan inventario pero no se integran al costo TCO de mantenimiento (Fuga Financiera).
- **Gastos de Combustible:** Posible duplicidad por ausencia de *idempotency key* al enviar desde la App móvil.

## 2. MAPA DE ARQUITECTURA DETECTADO

```text
[Cliente Web (Fat UI)] 
    │   (Lógica de negocio inyectada en React)
    ├── /despacho (Validaciones asimétricas de presupuesto y elegibilidad)
    ├── /torre-control (Pérdida de enlaces relacionales)
    ├── /mantenimiento (Lectura de campos obsoletos de SOAT/RT)
    │
[Supabase (Backend Frágil)]
    │   (RLS Inseguro en tablas transaccionales del MVP)
    ├── PostgreSQL (RPCs sin re-validación de reglas de front)
    ├── work_orders, transport_budgets, clients (Abiertos a `anon`)
    │
[App Conductor (Capacitor)]
    │   (Dependencia de Web URL, sin offline-first real)
    ├── GPS Tracking (Riesgo en background sin permisos correctos)
    ├── Odómetro Pre-ruta (Sin validación histórica de saltos negativos)
```

## 3. GAP ANALYSIS (Brechas Arquitectónicas)
- **Seguridad Perimetral (CRÍTICO):** El RLS en tablas críticas (`work_orders`, `clients`, `transport_budgets`) está abierto a la internet (rol `anon`). 
- **Fat UI vs Thin Backend (CRÍTICO):** Next.js asume validaciones críticas (ej. Elegibilidad de Choferes, Presupuestos), pero los RPCs en Supabase (`schedule_dispatch`) están ciegos. Si se llama a la API directamente, se corrompe el sistema.
- **Doble Fuente de Verdad:** Mantenimiento usa campos obsoletos de SOAT/RT en lugar de la nueva tabla `vehicle_documents`.
- **Integridad Transaccional CMMS (CRÍTICO):** Fallo silencioso en el cierre de OTs (`maintenance_orders` vs `maintenance_work_orders`) permite liberar un camión con fallas pendientes.

## 4. HALLAZGOS CLASIFICADOS (Consolidado)

| ID | Módulo | Severidad | Hallazgo |
|---|---|---|---|
| C-DB-01 | DB / Seg | CRÍTICO | RLS permite a `anon` modificar OTs, Presupuestos y Clientes (MVP Legacy). |
| C-DB-02 | DB / Seg | ALTO | Usuarios `authenticated` tienen acceso global sobre solicitudes sin filtros de Tenant. |
| M-DB-03 | DB / Perf | MEDIO | Faltan índices en `work_orders(client_id)` y `(transport_budget_id)`. |
| C-ARQ-01 | Arquitectura | CRÍTICO | Frontend valida elegibilidad de flota; Backend (`schedule_dispatch`) permite bypass. |
| C-ARQ-02 | Arquitectura | CRÍTICO | Acoplamiento fuerte (Fat UI) en React Client Components. |
| M-TMS-01 | TMS | ALTO | Duplicidad de presupuesto en subcontratos por Triggers sin filtros. |
| C-TMS-02 | TMS | CRÍTICO | UI permite programar despachos con presupuesto insuficiente (fuga de fondos). |
| C-CMMS-01 | CMMS | CRÍTICO | Cierre de OT falla en silencio y libera vehículos inseguros (tabla incorrecta). |
| C-CMMS-02 | CMMS | CRÍTICO | Consumo de inventario en OTs no se refleja en los costos del vehículo (TCO distorsionado). |
| C-APP-01 | App | CRÍTICO | App web-dependent en `capacitor.config`, arruinando uso Offline en rutas sin señal. |
| C-APP-02 | App | CRÍTICO | RPC de combustible carece de *idempotency key*, permitiendo gastos duplicados. |

## 5. PLAN ORDENADO DE CORRECCIÓN (CICLO DE FASES)

Acatando la Regla #31 (Orden de Corrección), ejecutaremos iteraciones atómicas:

### ITERACIÓN 1 (PRIORIDAD 1: Seguridad, Datos Críticos y RLS)
- **Corrección 1A:** Purgar RLS `anon` de `work_orders`, `clients`, `transport_budgets` y restringir `authenticated`.
- **Corrección 1B:** Corregir la máquina de estados del CMMS (tabla inexistente `maintenance_orders`) para frenar la liberación insegura de flota.
- **Corrección 1C:** Reforzar el RPC `schedule_dispatch` para que la validación de elegibilidad sea backend-first, bloqueando definitivamente los bypass de UI.

### ITERACIÓN 2 (PRIORIDAD 2: Lógica de Negocio y Finanzas)
- **Corrección 2A:** Inyectar el costo real de los repuestos al TCO al cerrar una OT.
- **Corrección 2B:** Arreglar duplicidades de combustible añadiendo `idempotency key` al RPC y App.
- **Corrección 2C:** Evitar presupuestos huérfanos/dobles en subcontratos limitando el trigger `trg_ensure_transport_budget`.
- **Corrección 2D:** Solucionar validación asimétrica de Odómetro en Pre-Ruta vs Histórico.

### ITERACIÓN 3 (PRIORIDAD 3: Deuda Técnica, App y Performance)
- **Corrección 3A:** Modificar Capacitor (`webDir`) e inyectar `ACCESS_BACKGROUND_LOCATION` en AndroidManifest.
- **Corrección 3B:** Añadir UUIDs relacionales al endpoint de Torre de Control para re-conectar Deep Links.
- **Corrección 3C:** Agregar Índices B-Tree faltantes para aliviar carga concurrente.

---
*Cada corrección iniciará un ciclo estricto de: Desarrollo SQL/TS -> Verificación QA -> Auditoría Independiente.*
