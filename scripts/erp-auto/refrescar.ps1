# Refresca la consulta del ERP (Power Query sobre FLEXLINE) de cada libro y lo guarda. Usa la credencial que Excel ya
# tiene guardada para el origen de datos. Falla (código 1) si un libro está abierto, la consulta no trae filas o no se
# actualizó.
param([Parameter(Mandatory)][string[]]$Archivos)
$ErrorActionPreference = 'Stop'

# Mientras Excel está ocupado (abriendo 20 MB o refrescando) rechaza las llamadas COM: se reintenta hasta 10 min
function Com([scriptblock]$Paso) {
  for ($i = 0; ; $i++) {
    try { return & $Paso } catch {
      $h = $_.Exception.HResult, $_.Exception.InnerException.HResult
      if ($i -ge 600 -or -not ($h -contains -2147418111 -or $h -contains -2147417846)) { throw }  # RPC_E_CALL_REJECTED / SERVERCALL_RETRYLATER
      Start-Sleep -Seconds 1
    }
  }
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false
$fallos = 0
try {
  foreach ($ruta in $Archivos) {
    $ruta = (Resolve-Path $ruta).Path
    try { [IO.File]::Open($ruta, 'Open', 'ReadWrite', 'None').Close() } catch { throw "El archivo está abierto o bloqueado: $ruta" }
    $antes = Get-Date
    $wb = Com { $excel.Workbooks.Open($ruta, 0) }  # 0 = no actualizar vínculos externos
    try {
      $lo = Com { $wb.Worksheets.Item('Consulta1').ListObjects.Item('Consulta1') }
      # Power Query no expone RefreshDate: la hora del ERP viene en Fecha_Actualizacion (margen por el reloj del servidor)
      $fresco = { $v = Com { $lo.ListColumns.Item('Fecha_Actualizacion').DataBodyRange.Cells.Item(1).Value2 }; $v -is [double] -and [DateTime]::FromOADate($v) -ge $antes.AddMinutes(-30) }
      # Los libros se refrescan solos al abrirse (en segundo plano): se espera y solo si no quedó al día se refresca de nuevo
      Com { $excel.CalculateUntilAsyncQueriesDone() }
      if (-not (& $fresco)) {
        Com { foreach ($c in $wb.Connections) { if ($c.Type -eq 1) { $c.OLEDBConnection.BackgroundQuery = $false } } }
        Com { $wb.RefreshAll() }
        Com { $excel.CalculateUntilAsyncQueriesDone() }
      }
      $filas = Com { $lo.ListRows.Count }
      if ($filas -lt 1) { throw "Consulta1 quedó vacía" }
      if (-not (& $fresco)) { throw "Consulta1 no se actualizó (Fecha_Actualizacion anterior a hoy)" }
      Com { $wb.Save() }
      Write-Output "OK $([IO.Path]::GetFileName($ruta)): $filas filas"
    } catch {
      $fallos++
      Write-Output "ERROR $([IO.Path]::GetFileName($ruta)): $($_.Exception.Message)"
    } finally { Com { $wb.Close($false) } }
  }
} finally {
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  [GC]::Collect()
}
if ($fallos) { exit 1 }
