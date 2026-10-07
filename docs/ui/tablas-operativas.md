# Tablas operativas JRM TMS

Las tablas de Solicitud de Transporte, Contratos, Despacho, Seguimiento, Flota,
Mantenimiento, Caja, APT, Reportes y Analítica, maestros y usuarios comparten
`DataTable` (`src/components/ui/data-table.tsx`). El componente conserva las
propiedades nativas de la tabla y las clases de cada pantalla. No consulta datos
ni modifica permisos, filtros, cálculos o exportaciones.

## Presentación común

- Encabezado claro, títulos breves, sin mayúsculas forzadas y con separación inferior.
- Celdas compactas, espaciado uniforme y números tabulares.
- Cada módulo conserva las alineaciones numéricas, anchos, colores que expresan
  alertas, encabezados agrupados y columnas fijas que necesita su operación.
- El contenedor de cada pantalla controla el desplazamiento y su adaptación móvil;
  no se ocultan columnas ni se transforma la tabla automáticamente.
- Los estados se explican con texto, además de su color.
- `TableActions` permite una acción principal visible y un menú para las demás.
  Las acciones se calculan según el rol y el estado del registro. El menú admite
  teclado, cierra con Escape o al desplazar la tabla y se muestra fuera del
  contenedor para que no quede recortado.

## Solicitud de Transporte

Una fila por servicio: fecha de solicitud, fecha de atención, tipo de servicio,
OT, punto de atención, estado y acciones. Fecha de atención comprende entregas,
recojos y traslados. Origen y destino se muestran juntos para punto a punto.

La barra de búsqueda y filtros permanece visible; los contadores por estado
también sirven como filtros. Los encabezados ordenan los resultados y la
paginación permite 25, 50 o 100 filas. Cambiar los filtros reinicia la página.
Código, emisión, cliente, glosa, carga, presupuesto, viajes, kilómetros, peso
real sustentado y eventos se consultan mediante **Ver detalle**.

En móvil, cada servicio mantiene los siete campos con etiquetas y sus acciones
visibles. En escritorio las filas son compactas; cuando el espacio es limitado,
el desplazamiento queda dentro de la tabla.

## Documentos y exportaciones

El estilo común se aplica solo en pantalla y excluye las tablas dentro de
`.caja-printable` y `.liq-page`. El documento de liquidación de alquiler conserva
sus tablas y diseño propios. El PDF FR-DT 007 mantiene su formato oficial:
`DataTable` solo presenta el listado de inspecciones, no construye ese PDF.
Las exportaciones Excel conservan sus datos y columnas originales.

Para nuevas tablas, usar `DataTable` con las mismas propiedades que una tabla
HTML, una leyenda o nombre accesible, encabezados con `scope`, estados de carga
y resultados vacíos, y un contenedor que permita desplazamiento cuando sea
necesario. No añadir acciones que el usuario no pueda ejecutar.
