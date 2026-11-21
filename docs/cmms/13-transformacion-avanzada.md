# Transformación del módulo de mantenimiento a CMMS avanzado

## Alcance y criterio de cierre

La aplicación ya cuenta con activos, fallas, órdenes de trabajo, preventivos, lecturas, repuestos, presupuestos e indicadores. La transformación consiste en cerrar el ciclo de mantenimiento con datos confiables, trazabilidad, captura móvil y costos completos; no en duplicar módulos existentes.

Una fase se considera cerrada únicamente cuando sus criterios de aceptación pasan en pruebas, los datos de origen están conciliados, hay permisos y auditoría verificados, y la operación puede completar el flujo en la interfaz. El despliegue de una fase no autoriza cambios destructivos sobre historiales.

## Fases y entregables

| Fase | Entregable | Criterio verificable |
| --- | --- | --- |
| 0. Claridad operacional | Separar borradores de OT activas y etiquetar de forma distinta proyección histórica y planes activos | Los conteos de cada pantalla identifican su fuente y universo; una OT en BORRADOR no se suma a OT abiertas; filtros permiten revisar borradores y órdenes activas sin cambiar sus estados. |
| 1. Calidad y maestros de activos | Jerarquía de flota, componentes críticos, ficha técnica, proveedor, garantía, documentos y ciclo de vida del activo | Cada placa/unidad posee identificador estable; duplicados, campos faltantes y lecturas inválidas se muestran en bandeja de calidad y no se corrigen silenciosamente. |
| 2. Captura de uso y condición | Odometría/horómetro con fecha, unidad, fuente, usuario, evidencia y validaciones de continuidad; inspecciones y captura móvil offline | Lecturas no decrecientes salvo corrección auditada; se identifica brecha, fuente y última sincronización; formularios móviles conservan captura offline y sincronizan idempotentemente. |
| 3. Ciclo de vida de OT | Solicitud/falla → evaluación → aprobación → programación → ejecución → validación → cierre/liberación | Transiciones permitidas por rol y reglas; responsables, tiempos, indisponibilidad, diagnóstico, tareas, evidencia, causa raíz y autorización quedan en historial inmutable. |
| 4. Preventivo basado en uso | Planes por km, horómetro, calendario o condición; pronóstico, tolerancia, excepciones y generación controlada de OT | El vencimiento explica regla, lectura y cálculo; no genera duplicados; una ejecución cerrada reinicia el ciclo y los borradores sin validar no se presentan como trabajo iniciado. |
| 5. Repuestos, servicios y costo real | Reserva/consumo/devolución de inventario, compras y servicios externos vinculados a OT y activo | Kardex y costos se concilian con OT; costo total desglosado en mano de obra, repuesto, proveedor y tiempos; toda reversión queda auditada. |
| 6. Analítica, presupuesto y confiabilidad | Disponibilidad, MTBF, MTTR, backlog por prioridad/antigüedad, costo por km/hora, cumplimiento preventivo y presupuesto | Fórmulas documentadas, filtros de período y fuente, exportación conciliable; indicadores sin muestra suficiente se presentan como “sin datos”, nunca como cero real. |
| 7. Despliegue y adopción | Migración controlada, entrenamiento, monitoreo, respaldo y reversión por fase | Ensayo en staging con conteos conciliados, pruebas de rol y flujo, restauración comprobada, monitoreo de errores y aceptación operativa antes de producción. |

## Separación de indicadores preventivos

El modelo histórico (`mant_planificacion`) estima necesidades desde el historial importado, órdenes y Caja. `vw_maintenance_projections` representa planes activos configurados con sus lecturas y fechas. Ambos universos son útiles y pueden tener cifras diferentes; deben conservar etiquetas, fechas de corte y procedencia para evitar conciliarlos como si fueran el mismo indicador.

Los registros de OT en BORRADOR se conservan hasta que un responsable los revise. Este trabajo no los aprueba, cancela ni elimina automáticamente.

## Secuencia de ejecución

La fase 0 es un saneamiento de presentación y consulta, sin migración de datos. Las fases 1–6 requieren auditoría de esquema y de datos por dominio antes de escribir migraciones; las fases 2 y 3 preceden a los cálculos confiables de 4 y 6. La fase 7 se ejecuta por cada conjunto de cambios, no como sustituto de pruebas.

Fuentes funcionales que ya existen en el repositorio incluyen `mant_planificacion`, `vw_maintenance_projections`, el Gestor de OT, fallas, inspecciones, repuestos y presupuesto anual. La implementación de fases debe extender estos flujos y reutilizar sus controles de acceso y RPC transaccionales.
