# Auditoría y GAP Analysis - CMMS JRM-TMS

## 1. Estado Actual (Auditoría del Ecosistema)

### Frontend (Next.js)
- **Módulos Existentes en Dashboard:**
  - `/mantenimiento/page.tsx` (Dashboard principal con indicadores básicos).
  - `/mantenimiento/flota` (Gestión de vehículos).
  - `/mantenimiento/gestor-ot` (Gestor de Órdenes de Trabajo).
  - `/mantenimiento/inventario` (Catálogo maestro de repuestos).
  - `/mantenimiento/neumaticos` (Gestión de neumáticos).
  - `/mantenimiento/preventivos` (Planes de mantenimiento preventivo y proyección).
  - `/mantenimiento/proveedores` (Directorio de talleres y proveedores).
  - Módulos paralelos: `/contratos`, `/torre-control`, `/caja`, `/solicitudes`.
- **App Conductor (Mobile):**
  - `/checklist` (Inspecciones pre y post ruta funcionales).
  - `/fallas` (Solicitudes de mantenimiento desde ruta).

### Backend & Base de Datos (Supabase)
- **Tablas/Entidades Clave:** `vehicles`, `maintenance_work_orders`, `spare_parts`, `inventory_transactions`, `maintenance_plans`, `maintenance_requests`, `maintenance_providers`.
- **Lógica, Triggers y RPC:**
  - Migraciones avanzadas como `20260923175000_advanced_cmms.sql` introducen gestión de preventivos vinculados al odómetro, vistas de estado y funciones completas de cierre de OTs (`complete_maintenance_order`).
  - Motor de estados para vehículos robusto (`20260923163000_vehicle_state_machine.sql`).
  - Controles de acceso (RLS) correctamente implementados.

## 2. GAP Analysis (Actual vs Arquitectura Objetivo)

### Flota 360 & Disponibilidad
- **Existe:** Vistas de flota y cálculo básico de disponibilidad en el cliente.
- **Falta/Brecha:** Centralización de disponibilidad histórica (MTTR, MTBF) a nivel de base de datos (RPCs/Views) en lugar de cálculos pesados en el frontend.

### Solicitudes (Fallas)
- **Existe:** Integración desde el App Conductor mediante tabla de `maintenance_requests`.
- **Falta/Brecha:** Flujo de aprobación más fluido (UX/UI) que convierta una solicitud en OT con un presupuesto preliminar de forma guiada.

### OTs (Órdenes de Trabajo)
- **Existe:** Gestor funcional. El proceso de cierre descuenta inventario automáticamente.
- **Falta/Brecha:** Mejor diferenciación visual y funcional entre OTs de taller interno vs. proveedores externos; soporte robusto para fotos/evidencias adjuntas a cada tarea.

### Preventivos
- **Existe:** Planes de mantenimiento y proyecciones.
- **Falta/Brecha:** Generación automática de OTs (Drafts) cuando se cruzan umbrales de odómetro/fecha, actualmente es más un reporte/proyección.

### Inspecciones
- **Existe:** Checklists funcionales.
- **Falta/Brecha:** Automatización que dispare un "Maintenance Request" o ponga el vehículo en "MANTENIMIENTO_REQUERIDO" si falla un ítem crítico en el checklist.

### Inventario
- **Existe:** Catálogo y movimientos bajo el capó (`inventory_transactions`).
- **Falta/Brecha:** Un módulo de Kardex visible e interactivo, alertas de stock mínimo y gestión de reposición (Órdenes de Compra).

### Neumáticos
- **Existe:** Estructura básica en código.
- **Falta/Brecha:** Mapa de ejes visual (Axle Map), historial de vida útil, mediciones de presión/cocada integradas a las inspecciones.

### Cumplimiento
- **Existe:** Alertas documentarias (SOAT, Rev Técnica) en el dashboard.
- **Falta/Brecha:** Bloqueo en el State Machine para evitar asignar contratos o iniciar rutas con documentos vencidos (Cumplimiento rígido).

### Proveedores y Contratos
- **Existe:** Funciones avanzadas de contratos y listado de proveedores.
- **Falta/Brecha:** Medición de SLA (Acuerdos de nivel de servicio) para calificar a proveedores de mantenimiento externos.

### Analítica
- **Existe:** Dashboards con KPIs.
- **Falta/Brecha:** Torre de Control de Mantenimiento puramente analítica (Costos vs. Utilidad por placa, reportes de frecuencia de averías) impulsada por vistas materializadas o RPCs.

## 3. Estrategia Técnica

- **Qué debe reutilizarse:** Componentes de UI actuales, motor de estados (State Machine), esquema relacional base y App Conductor.
- **Qué debe refactorizarse:** Lógica analítica del frontend trasladada hacia Supabase RPCs.
- **Qué debe eliminarse:** Código o triggers "huérfanos" superados por las migraciones avanzadas recientes.
- **Qué falta desarrollar:**
  1. Integración Checklist -> Solicitud Automática.
  2. UI avanzada de Neumáticos (Ejes).
  3. UI de Kardex interactivo.
  4. Automatización Preventivo -> Draft de OT.
  5. Refuerzo de bloqueos por Cumplimiento (Docs).
