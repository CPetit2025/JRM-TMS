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
# Proceso de este Excel oculto: si Quit no lo cierra, queda vivo y el siguiente archivo que abra el usuario cae en él
Add-Type -Name W -Namespace WmsAuto -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'
[uint32]$excelPid = 0
[void][WmsAuto.W]::GetWindowThreadProcessId([IntPtr]$excel.Hwnd, [ref]$excelPid)
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
      # Copia del robot del TMS (scripts/erp-auto): aquí la tabla Consulta1 está en la hoja «Entrada ALM PT»
      $lo = @(Com { foreach ($ws in $wb.Worksheets) { foreach ($l in $ws.ListObjects) { if ($l.Name -eq 'Consulta1') { $l } } } })[0]
      if (-not $lo) { throw 'No se encontró la tabla Consulta1 en el libro' }
      # Power Query no expone RefreshDate: la hora del ERP viene en Fecha_Actualizacion (margen por el reloj del servidor)
      $fresco = { $v = Com { $lo.ListColumns.Item('Fecha_Actualizacion').DataBodyRange.Cells.Item(1).Value2 }; $v -is [double] -and [DateTime]::FromOADate($v) -ge $antes.AddMinutes(-30) }
      # Los libros se refrescan solos al abrirse (en segundo plano): se espera y solo si no quedó al día se refresca de nuevo
      Com { $excel.CalculateUntilAsyncQueriesDone() }
      if (-not (& $fresco)) {
        # Solo la conexión de entradas y en primer plano: RefreshAll (como en el TMS) no dejaba Consulta1 al día en este
        # libro, que además tiene Consulta2 (salidas), que el WMS no usa
        $con = Com { $wb.Connections.Item('Consulta - Consulta1') }
        Com { $con.OLEDBConnection.BackgroundQuery = $false }
        Com { $con.Refresh() }
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
  Com { $excel.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  [GC]::Collect()
  # Si sigue vivo y sin ventana (nadie lo está usando), se cierra; con ventana es del usuario y no se toca
  $p = Get-Process -Id $excelPid -ErrorAction SilentlyContinue
  if ($p -and -not $p.WaitForExit(30000) -and $p.MainWindowHandle -eq 0) { Stop-Process -Id $excelPid -Force }
}
if ($fallos) { exit 1 }
