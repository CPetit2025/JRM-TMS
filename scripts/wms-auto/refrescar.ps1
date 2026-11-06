# Actualiza el libro de ingresos APT (si tiene conexiones de Excel) y valida que
# Consulta1 tenga IPTs y Fecha_Actualizacion reciente. Siempre opera sobre una copia.
param(
  [Parameter(Mandatory)][string]$Archivo,
  [int]$MaxHoras = 30
)
$ErrorActionPreference = 'Stop'

function Com([scriptblock]$Paso) {
  for ($i = 0; ; $i++) {
    try { return & $Paso } catch {
      $h = $_.Exception.HResult, $_.Exception.InnerException.HResult
      if ($i -ge 600 -or -not ($h -contains -2147418111 -or $h -contains -2147417846)) { throw }
      Start-Sleep -Seconds 1
    }
  }
}

function To-DateTime($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [double] -or $value -is [int] -or $value -is [decimal]) {
    try { return [DateTime]::FromOADate([double]$value) } catch { return $null }
  }
  if ($value -is [DateTime]) { return $value }
  $parsed = [DateTime]::MinValue
  if ([DateTime]::TryParse([string]$value, [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeLocal, [ref]$parsed)) { return $parsed }
  return $null
}

$ruta = (Resolve-Path $Archivo).Path
$excel = New-Object -ComObject Excel.Application
Add-Type -Name W -Namespace WmsAuto -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'
[uint32]$excelPid = 0
[void][WmsAuto.W]::GetWindowThreadProcessId([IntPtr]$excel.Hwnd, [ref]$excelPid)
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false
$wb = $null
try {
  $wb = Com { $excel.Workbooks.Open($ruta, 0) }
  $table = $null
  foreach ($sheet in $wb.Worksheets) {
    foreach ($candidate in $sheet.ListObjects) {
      if ($candidate.Name -eq 'Consulta1') { $table = $candidate; break }
    }
    if ($table) { break }
  }
  if (-not $table) { throw 'No se encontró la tabla Consulta1 en el libro de ingresos APT.' }
  foreach ($required in @('Nro_Documento', 'Fecha_Actualizacion')) {
    try { $null = Com { $table.ListColumns.Item($required) } }
    catch { throw "La tabla Consulta1 no tiene la columna obligatoria $required." }
  }

  $connections = [int](Com { $wb.Connections.Count })
  Com { $wb.RefreshAll() }
  Com { $excel.CalculateUntilAsyncQueriesDone() }
  $rows = [int](Com { $table.ListRows.Count })
  if ($rows -lt 1) { throw 'Consulta1 no tiene ingresos.' }
  $documents = Com { $table.ListColumns.Item('Nro_Documento').DataBodyRange.Value2 }
  $updates = Com { $table.ListColumns.Item('Fecha_Actualizacion').DataBodyRange.Value2 }
  $documentValues = @($documents | ForEach-Object { $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
  if ($documentValues.Count -lt 1) { throw 'No hay ningún Nro_Documento/IPT en el archivo.' }
  $dateValues = @($updates | ForEach-Object { $_ } | Where-Object { $null -ne $_ })
  if ($dateValues.Count -eq 0) { throw 'Fecha_Actualizacion está vacía; no se cargará un libro sin validar su vigencia.' }
  $latest = $null
  foreach ($value in $dateValues) {
    $parsed = To-DateTime $value
    if ($parsed -and (-not $latest -or $parsed -gt $latest)) { $latest = $parsed }
  }
  if (-not $latest) { throw 'No se pudo interpretar Fecha_Actualizacion.' }
  $ageHours = ((Get-Date) - $latest).TotalHours
  if ($ageHours -lt -1) { throw "Fecha_Actualizacion es futura ($latest); revise el reloj del origen." }
  if ($ageHours -gt $MaxHoras) { throw "Actualizable APT vencido: Fecha_Actualizacion $latest tiene $([math]::Round($ageHours,1)) h (máximo $MaxHoras h). No se cargó." }
  Com { $wb.Save() }
  if ($connections -eq 0) {
    Write-Output "OK $rows filas; $($documentValues.Count) IPT informados; actualización validada hace $([math]::Round($ageHours,1)) h. El libro no tiene conexiones de Excel: se validó su Fecha_Actualizacion sin inventar un refresco de origen."
  } else {
    Write-Output "OK $rows filas; $($documentValues.Count) IPT informados; conexiones de Excel refrescadas; actualización hace $([math]::Round($ageHours,1)) h."
  }
} finally {
  try {
    if ($wb) { try { Com { $wb.Close($false) } } catch {} }
    try { Com { $excel.Quit() } } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel) }
  } finally {
    [GC]::Collect()
    $process = Get-Process -Id $excelPid -ErrorAction SilentlyContinue
    if ($process -and -not $process.WaitForExit(30000) -and $process.MainWindowHandle -eq 0) { Stop-Process -Id $excelPid -Force }
  }
}
