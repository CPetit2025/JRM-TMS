# Indicadores (KPI): un solo módulo

Menú **Operación › Indicadores (KPI)** (`/desempeno`). Reúne en una pantalla los indicadores de los cinco roles medidos:
Supervisor de Despacho, Supervisor de Transporte / Jefe de Distribución, Asistente Documentario, Conductores y Soporte Mecánico.

- Migración: `supabase/migrations/20261006120000_kpi_tablero.sql`.
- Prueba: `supabase/tests/caja_c37_kpi_tablero.test.sql`.
- Cálculo por rol: `docs/desempeno-por-rol.md` (cuatro roles) y `docs/soporte-mecanico.md` (Soporte Mecánico).

## Para el Jefe de Distribución y el Administrador (permiso `desempeno`)

| Pestaña | Contenido |
|---|---|
| **Tablero** | Índice general, personas medidas, índices bajos, informes por revisar y atrasados. Una tarjeta por rol con promedio, distribución por calificación y evolución de 6 meses. Gráfico de evolución por rol. Lista «Requieren atención»: índice bajo, siniestro grave, informe atrasado. |
| **Equipo** | Ranking por rol (incluye Soporte Mecánico), lo que más baja el índice de cada persona y su informe. «Ver detalle» abre la ficha completa. |
| **Informes** | Los informes mensuales de **todos** los roles, Soporte Mecánico incluido. Se marcan como Revisado u Observado desde aquí. |
| **Metas y pesos** | Metas y pesos de los cuatro roles. Para Soporte Mecánico, los plazos se ajustan en Soporte Mecánico › Plazos. |

**Exportar Excel** descarga cuatro hojas: Resumen por rol, Personas, Indicadores (detalle por persona) y Evolución.

El día 5 de cada mes llega a la campana el aviso «Indicadores de <mes> listos».

## Para cada usuario medido: «Mi avance»

- **Web, pestaña Mi avance:**
  - medidor del índice, con la variación frente al mes anterior;
  - indicadores en su meta y avance del mes (día X de Y);
  - evolución de 6 meses y estado del informe mensual;
  - «Qué mejorar este mes» y el detalle de cada indicador.
- **Inicio:** tarjeta **Mi avance del mes**. Solo aparece si el usuario está en un rol medido.
- **App del conductor:** sin cambios. Sigue la tarjeta «Mi desempeño del mes».

## Cómo se calcula

- **Soporte Mecánico** usa los mismos componentes y pesos de `soporte_kpis`. Se presenta con la misma ficha que los demás roles.
  - Igual que los demás roles, con menos del 40 % del peso medido el índice queda en «sin datos».
- **Historial mensual** (`kpi_historial`): cada día a las 06:25 se guarda la foto del mes anterior, hasta el día 10. De ahí sale la evolución.
  - Al desplegar se cargaron los 6 meses anteriores.
- **Permisos:**
  - quien tiene `desempeno` ahora también ve los KPI de Soporte Mecánico y revisa sus informes;
  - el supervisor de mantenimiento conserva ese acceso.
