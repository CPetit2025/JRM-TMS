# Contrato operativo y analítico de APT

Fecha de referencia: 11/10/2026. Zona operativa: America/Lima. Versión de respuesta analítica: 1.

Este contrato define qué representan los datos de APT y cómo deben interpretarlos las pantallas, exportaciones y JRM IA. Un saldo reconstruido documentalmente no certifica existencia física. Una guía ERP no certifica recepción conforme. Las funcionalidades futuras se distinguen expresamente de las disponibles.

## Fuentes y alcance

| Fuente | Evidencia disponible | Lo que no demuestra por sí sola |
|---|---|---|
| `apt_movements` | Fila original ERP, clasificación, fecha diaria, lote, producto, documento y peso informado | Existencia física actual, hora efectiva, disponibilidad o recepción conforme |
| `apt_flow_layers`, `apt_flow_exits`, `apt_flow_alloc`, `apt_flow_pieces` | Reconstrucción FIFO por almacén/lote/producto y composición del saldo | Conciliación física o explicación humana de cada diferencia |
| `apt_uploads`, `apt_flow_state` | Estado de importación, cobertura documental y fecha de recálculo | Que cada día sin movimientos sea un día cubierto por un reporte completo |
| Solicitudes, despachos, paradas y evidencias TMS | Compromisos y eventos registrados, documentos y validaciones | Vínculo inequívoco del peso ERP cuando el documento o su asignación sean ambiguos |

Los modelos originales de estadía (`ENTRADA`/`SALIDA`, clave lote/producto) y flujo (todos los movimientos, clave almacén/lote/producto) mantienen propósitos distintos. El nuevo resumen operacional usa el modelo de flujo; las consultas de estadía son análisis de cohorte y deben identificarse como tales.

## Clasificación de certeza

1. **Informado:** valor procedente de una fila/documento o evento registrado. Conservar su fuente, sin afirmar que fue verificado físicamente.
2. **Reconstruido:** resultado calculado por FIFO, balance o agregación. Declarar `DOCUMENTAL_RECONSTRUIDO`.
3. **Inferido:** apertura que el modelo introduce para evitar saldo cronológico negativo o cliente deducido. No etiquetar como confirmado.
4. **Desconocido:** peso, fecha de origen, vínculo o dato necesario ausente. Debe mantenerse visible, nunca sustituirse por una cifra inventada.
5. **Observado independientemente:** captura ERP o física de una fecha/almacén/lote/producto con peso, referencia, responsable y fecha de registro. No sobrescribe la apertura inferida. Una coincidencia documental solo valida esa clave y corte; no certifica todo el inventario.

Fecha de origen conocida no significa saldo físicamente confirmado. Un peso cero procedente de información ausente no significa cero material. Si la fuente no permite distinguir el cero legítimo del dato ausente, identificar el registro como peso no evaluable.

## Identidad y conservación de material

- Unidad física analítica: almacén + lote + producto; cada tramo conserva origen y documento.
- Familia contractual: OT madre y variantes reconocidas; agrupar sin borrar la identidad de cada lote.
- Códigos sospechosos por digitación y lotes vinculados a otra numeración quedan separados hasta resolverlos.
- Traspaso interno: salida del almacén origen e ingreso al destino; no aumenta producción ni material externo consolidado.
- Reasignación de lote: conserva el material y la edad de origen cuando la composición permite conocerla.
- Devolución: reabre un ciclo diferenciado; no equivale a producción nueva.
- Consumo y salida a almacén externo reducen el saldo; no equivalen a entrega al cliente.
- Tolerancia porcentual no autoriza eliminar un saldo residual. Una resolución exige ajuste/documentación explícita.

Ecuación por almacén/lote/producto:

`saldo final = apertura + producción + devolución + otros ingresos + traspasos recibidos − despachos − consumos − otros egresos − traspasos enviados ± ajustes autorizados`

La apertura inferida es una partida explícita de la ecuación. El cuadre del modelo puede ser cero por construcción; no llamarlo conciliación ERP/física. Los ajustes autorizados solo existirán cuando haya fuente y trazabilidad para registrarlos; hoy no se presume esa capacidad.

## Fechas, períodos y filtros

- **Corte del modelo:** última fecha calculada; limita la reconstrucción. El resumen operativo rechaza cortes posteriores a la cobertura del modelo; el Gantt existente limita el corte futuro e informa su alcance. Nunca proyectar existencia futura como dato confirmado.
- **Período de movimientos:** ventana inclusiva `desde`–`hasta`; controla flujos y stock diario medio, no borra las existencias originadas antes de la ventana.
- **Corte consultado:** fecha a la que se evalúa saldo/antigüedad. No confundir con fin del gráfico ni con hoy.
- **Fecha/hora TMS:** evento real registrado cuando existe. La fecha diaria ERP no permite medir horas.
- **Ubicación actual:** saldo en el almacén al corte, diferente de almacén original o un almacén por el que pasó.
- Cliente inferido debe conservar su significado. Filtrar por cliente no convierte esa inferencia en relación contractual validada.
- El saldo histórico se deriva de ingresos y salidas acumulados. En cortes anteriores, sin composición histórica persistida, el resumen operativo declara edad/origen `NO_DISPONIBLE`; el Gantt existente calcula edad por llegada y declara `ALMACEN` frente a `ORIGEN` al corte del modelo.
- Días observados: días calendario de la ventana efectiva y disponible; no una constante de 30 días. Días con cobertura documental incierta requieren advertencia.

## Diccionario de indicadores

| Indicador | Fórmula/unidad | Condiciones y lectura |
|---|---|---|
| Stock operacional reconstruido | Suma saldo por almacén/lote/producto / 1.000, TN | Incluye apertura inferida explícita; no certificado físicamente |
| Apertura inferida pendiente | Parte del saldo cuyo origen raíz es INICIAL, TN | Fecha de producción desconocida; no asignar edad cero |
| Saldo con origen conocido/desconocido | Saldo cuya fecha de origen existe/no existe, TN | Presentar ambas partes y base de edad |
| Antigüedad ponderada | Σ(kg saldo × edad conocida) / Σ(kg saldo con edad conocida), días | Denominador excluye origen desconocido y queda declarado; nulo sin base |
| TN×días | Σ(TN saldo × edad conocida), TN·día | Exposición del saldo al corte, no integral histórica ni costo |
| Producción / despachos / consumo / devolución | Suma del movimiento correspondiente dentro de la ventana, TN | Los traspasos internos no se incluyen como producción/despacho externo |
| Stock diario promedio | Σ(stock al cierre de cada día disponible) / días de ventana, TN | Considera el saldo anterior a la ventana; diferente del saldo final |
| Rotación del período | TN despachadas de ventana / stock diario promedio, veces | Nulo cuando el denominador es cero; mostrar ventana, no anualizar implícitamente |
| Calidad | Filas sin peso, anomalías temporales y apertura inferida | Conteos documentales; no estimar TN desconocidas desde conteos |
| Disponibilidad y bloqueos | Requiere liberación, causa y responsable registrados | Pendiente de fuente operativa; no deducir de antigüedad |
| Cumplimiento de entrega | Conforme dentro del compromiso / servicios evaluables vencidos | Requiere fecha comprometida y conformidad validada vinculadas; una salida ERP no basta |

El percentil 90 y la mediana existentes deben declarar si su base son capas/eventos o masa ponderada. No llamar percentil de servicios a un percentil de capas.

## Actualización, interfaz, IA y reportes

El resumen `apt_operational_summary(p jsonb)` publica `schema_version`, metadatos, corte, recálculo, frescura, indicadores, serie y filas. Los totales cubren todo el conjunto filtrado; la paginación solo limita las filas de detalle. Toda exportación conserva filtros, corte, unidades y alcance. Vacío no equivale a error ni a dato desconocido.

Una carga aplicada después del recálculo marca el modelo pendiente aunque sustituya las mismas fechas. La respuesta debe conservar el resultado anterior e identificarlo. Consultar una gráfica o solicitar un análisis IA no debe disparar un recálculo completo ni editar datos.

La IA utiliza herramientas de lectura autorizadas y resultados calculados. Su respuesta distingue hallazgos, evidencia, hipótesis y recomendaciones; declara cobertura y exclusiones. No diagnostica la causa de un bloqueo sin registro. No certifica cumplimiento, stock físico, recepción ni conciliación por inferencia. Un reporte comparte los permisos y el alcance del solicitante. Preparar un correo no lo envía.

Cierre administrativo de ruta a las 00:00 America/Lima libera recursos; no elimina pendientes ni acredita conformidad. Mantener independientes operación, documentos y KPI.

## Línea base de producción y conciliación

La inspección agregada de producción se ejecutó en lectura mediante las credenciales existentes del workflow, sin exponer secretos ni publicar OT, clientes, documentos o datos personales. Captura: **11/10/2026 18:30 America/Lima**, corte documental **09/10/2026**, inicio **02/01/2026**. Consulta reproducible: `scripts/security/apt-reconciliation.sql`. Esta línea base no afirma conciliación física. Las pruebas aisladas son independientes y usan datos sintéticos.

| Resultado medido | Lectura correcta |
|---|---|
| Flujo: 571,888 TN; estadía: 877,461 TN | Alcances diferentes; no atribuir la diferencia completa a error ni restar como ajuste |
| Saldo flujo por almacén: 647 = 388,751; 540 = 166,337; ST = 16,800 TN | Ubicación reconstruida al corte |
| Apertura inferida introducida: 304,643 TN; pendiente: 8,202 TN | Apertura total del período distinta de apertura aún en stock |
| Origen desconocido pendiente: 8,202 TN | 1,43% del saldo reconstruido sin fecha de origen; no asignar cero días |
| 69 asignaciones de salida anteriores a entrada: 56,247 TN | Excepción cronológica en el modelo de estadía, necesita revisión documental |
| 77 capas con flag de problema; 61 con estado diferente a problema | Inconsistencia de clasificación visible |
| 1 capa despachada con saldo: 0,019 TN | Residuo real del modelo que no debe desaparecer por tolerancia |
| Traspasos internos reconstruidos: 5.283,631 TN de ingreso y egreso | Cuadre de movimientos internos; no producción externa adicional |
| Cuadre reconstruido por almacén: diferencia 0 | Balance por construcción; no certificación contra ERP o conteo |

Cobertura documental y calidad del peso:

| Tipo | Filas válidas | Sin peso positivo | Último documento |
|---|---:|---:|---|
| Entrada | 14.202 | 16 | 08/10/2026 |
| Salida | 21.018 | 1.884 | 09/10/2026 |
| Traspaso entrada | 19.136 | 1.857 | 08/10/2026 |
| Traspaso salida | 12.680 | 20 | 09/10/2026 |
| Consumo | 193 | 25 | 29/09/2026 |
| Devolución | 73 | 32 | 29/09/2026 |

Las 3.834 filas sin peso positivo no permiten estimar TN faltantes; requieren resolver si el peso es ausente o legítimamente cero. La fecha del último documento no demuestra cobertura continua ni autoriza afirmar que consumo/devolución están incompletos sin contrastar el reporte ERP. El flujo estaba recalculado respecto de la última carga aplicada al momento de la captura.

La nueva tabla `apt_stock_observations` conserva capturas separadas ERP/FISICO y todas sus versiones. `apt_stock_observation_save` requiere cuenta activa y permiso de carga; `apt_stock_reconciliation` requiere permiso APT y compara la última observación de cada fuente/clave en el corte exacto. Una corrección agrega evidencia; no ajusta automáticamente el FIFO. Sin modelo para el corte, la diferencia permanece nula/no evaluable. El panel presenta solo observaciones registradas, no presume conciliación de claves sin captura.

Para completar la conciliación operacional:

1. Elegir un corte y obtener el reporte ERP de existencias y movimientos con cobertura explícita por tipo/almacén. Usar un canal autorizado; no compartir credenciales en chat.
2. Seleccionar una muestra con parcialidades, devoluciones, consumos, traspasos, variantes y stock anterior al período.
3. Comparar por almacén/lote/producto: apertura, movimientos, saldo, documento y peso. Separar diferencias de fuente, vínculo, cronología y modelo.
4. Registrar conciliación con ERP y, cuando corresponda, conteo físico por separado, con evidencia y responsable.
5. Resolver cada excepción conservando fila original y trazabilidad; evitar ajustes silenciosos o reclasificación por conveniencia.
6. Repetir el corte y obtener coincidencia de resumen operacional, Kardex y Gantt bajo el mismo alcance. Diferencias de estadía de cohorte se explican por su alcance.

## Criterios de aceptación

- No duplicar TN consolidadas por traspasos; diferenciar producción, retorno y consumo.
- Mantener visibles origen/peso desconocidos y saldo residual.
- Distinguir corte histórico, período de movimientos y fecha actual.
- Rotación usa inventario diario medio; nulo no se convierte en cero engañoso.
- Permisos SQL reales: anónimo y usuario sin APT no acceden; las herramientas IA respetan el mismo permiso.
- Modelo pendiente identificado, incluso con reemplazo de fechas iguales.
- Totales invariantes por paginación y reconciliables bajo filtros idénticos.
- Evidencia de pruebas aisladas separada de conciliación y rendimiento concurrente de producción.

Referencia técnica: `docs/apt-gantt-scm.md`, `docs/apt-estadia-inventario.md`, migración `20261003100000_apt_flujo_multialmacen.sql` y nueva migración operacional. Este contrato no altera el historial aplicado de migraciones.
