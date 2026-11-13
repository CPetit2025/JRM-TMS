# Robot de ingresos WMS para etiquetado, al estilo del robot del ERP del TMS (scripts/erp-auto). Ver docs/robot-wms-recepcion.md.
#   Instalar (una vez):  .\ejecutar.ps1 -Instalar -SupabaseUrl <url base WMS> -SupabaseAnon <clave pública> [-Entrada C:\WMS\entrada.xlsx] [-Traspaso 'C:\WMS\Traspado de Almacen APT.xlsx'] [-Url https://wms.jrmlogistica.app]
#   Carga dos actualizables del ERP: entradas de ALM PT y traspasos de pernería a APT (se reciben y etiquetan igual).
#   La tarea corre cada minuto y solo pregunta a la base si toca: cada 5 minutos o al pulsar «Actualizar ahora» en la web.
#   Probar sin cargar:   & "$env:LOCALAPPDATA\JRM-TMS\wms-auto\ejecutar.ps1" -Revisar
param(
  [switch]$Instalar,
  [string]$Entrada = 'C:\WMS\entrada.xlsx',
  [string]$Traspaso = 'C:\WMS\Traspado de Almacen APT.xlsx',
  [string]$Url = 'https://wms.jrmlogistica.app',
  [string]$SupabaseUrl,
  [string]$SupabaseAnon,
  [switch]$Revisar
)
$ErrorActionPreference = 'Stop'
$destino = Join-Path $env:LOCALAPPDATA 'JRM-TMS\wms-auto'
$nombreTarea = 'JRM WMS ingresos para etiquetas'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }

if ($Instalar) {
  if (-not (Test-Path -LiteralPath $Entrada -PathType Leaf)) { throw "No existe $Entrada" }
  if (-not $SupabaseUrl -or -not $SupabaseAnon) { throw 'Indique -SupabaseUrl y -SupabaseAnon (URL y clave pública de la base WMS).' }
  if ($SupabaseUrl -match 'eojfsbogysifxrlrnjvx') { throw 'Esa es la base del TMS; el robot WMS no puede usarla.' }
  if (-not (Test-Path $node)) { throw 'Instale Node.js LTS y vuelva a ejecutar.' }
  New-Item -ItemType Directory -Force (Join-Path $destino 'logs'), (Join-Path $destino 'trabajo') | Out-Null
  Get-ChildItem -LiteralPath $PSScriptRoot -File | Copy-Item -Destination $destino -Force
  Push-Location $destino
  try {
    & (Join-Path (Split-Path $node) 'npm.cmd') install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'npm install falló.' }
  } finally { Pop-Location }
  @{ entrada = (Resolve-Path -LiteralPath $Entrada).Path; traspaso = $(if (Test-Path -LiteralPath $Traspaso -PathType Leaf) { (Resolve-Path -LiteralPath $Traspaso).Path } else { $null }); url = $Url.TrimEnd('/'); supabaseUrl = $SupabaseUrl.TrimEnd('/'); supabaseAnon = $SupabaseAnon } |
    ConvertTo-Json | Set-Content (Join-Path $destino 'config.json') -Encoding UTF8
  # Cuenta WMS del robot (permiso almacen-carga): queda cifrada con DPAPI, solo este usuario de Windows en este equipo la lee
  $cred = Get-Credential -Message 'Cuenta WMS con permiso de carga para el robot de ingresos'
  if (-not $cred) { throw 'Instalación cancelada: falta la cuenta WMS.' }
  $cred | Export-Clixml (Join-Path $destino 'credencial.xml')
  # Cada minuto todo el día; la base decide cuándo toca. conhost --headless evita que se asome una ventana cada minuto.
  $accion = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$destino\ejecutar.ps1`""
  $cuando = New-ScheduledTaskTrigger -Daily -At '00:00'
  $cuando.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
  # Excel necesita la sesión de Windows iniciada: la tarea corre solo con el usuario conectado
  $quien = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $nombreTarea -Action $accion -Trigger $cuando -Principal $quien -Settings $ajustes -Force | Out-Null
  Write-Output "Instalado en $destino; tarea «$nombreTarea»: actualiza cada 5 minutos y al pulsar «Actualizar ahora». Pruebe con: & `"$destino\ejecutar.ps1`" -Revisar"
  exit 0
}

$cfg = Get-Content (Join-Path $destino 'config.json') -Raw | ConvertFrom-Json
$credencial = Join-Path $destino 'credencial.xml'
if (-not (Test-Path $credencial)) { throw 'Falta la cuenta WMS del robot: repita la instalación (-Instalar).' }
$cred = Import-Clixml $credencial
$env:WMS_URL = $cfg.url
$env:WMS_SUPABASE_URL = $cfg.supabaseUrl
$env:WMS_SUPABASE_ANON = $cfg.supabaseAnon
$env:WMS_USUARIO = $cred.UserName
$env:WMS_CLAVE = $cred.GetNetworkCredential().Password
[Console]::OutputEncoding = [Text.Encoding]::UTF8  # Node escribe UTF-8; sin esto los acentos salen rotos en el log
$logs = Join-Path $destino 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

# ¿Toca? (cada 5 min o pedido desde la web). Si no, termina sin log: corre cada minuto.
$run = $null
if (-not $Revisar) {
  $ErrorActionPreference = 'Continue'
  $salida = & $node (Join-Path $destino 'robot.mjs') inicio 2>&1 | ForEach-Object { "$_" }
  $fallo = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($fallo -or -not $salida) {
    Remove-Item Env:WMS_CLAVE, Env:WMS_USUARIO -ErrorAction SilentlyContinue
    if ($fallo) { "$(Get-Date -Format s) $salida" | Add-Content (Join-Path $logs 'ciclo-errores.log') }
    exit [int][bool]$fallo
  }
  $run = $salida | Select-Object -Last 1 | ConvertFrom-Json
}

$log = Join-Path $logs "$(Get-Date -Format 'yyyy-MM-dd_HHmm').log"
Get-ChildItem $logs -Filter '20*.log' | Sort-Object Name -Descending | Select-Object -Skip 400 | Remove-Item
Start-Transcript $log | Out-Null
$codigo = 1
$mensaje = ''
try {
  if ($run) { Write-Output "Ejecución $($run.kind) n.° $($run.id)" }
  # Se trabaja sobre una copia: el original puede estar abierto por el usuario y no se toca
  $trabajo = Join-Path $destino 'trabajo'
  New-Item -ItemType Directory -Force $trabajo | Out-Null
  # Libros a cargar: entradas (obligatorio) y traspasos de pernería (si está configurado y existe)
  $libros = @(@{ nombre = 'entrada'; origen = $cfg.entrada })
  if ($cfg.traspaso -and (Test-Path -LiteralPath $cfg.traspaso -PathType Leaf)) { $libros += @{ nombre = 'traspaso'; origen = $cfg.traspaso } }
  foreach ($l in $libros) { $l.archivo = Join-Path $trabajo "$($l.nombre).xlsx"; Copy-Item -LiteralPath $l.origen -Destination $l.archivo -Force }
  & (Join-Path $destino 'refrescar.ps1') -Archivos ($libros | ForEach-Object { $_.archivo })
  if ($LASTEXITCODE) { throw 'No se actualizó el Excel desde el ERP; no se cargó nada.' }
  $extra = @(); if ($Revisar) { $extra = @('--revisar') }
  $resumen = @()
  foreach ($l in $libros) {
    # Lo que Node escribe en stderr es parte del log, no un error de PowerShell
    $ErrorActionPreference = 'Continue'
    $lineas = @(& $node (Join-Path $destino 'cargar-entrada.mjs') @extra $l.archivo 2>&1 | ForEach-Object { "$_" })
    $ok = -not $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $lineas | Write-Output
    $m = $lineas | Where-Object { $_ -match '^(OK|ERROR|Revisión)' } | Select-Object -Last 1
    if (-not $ok) { throw "$($l.nombre): $(if ($m) { $m -replace '^ERROR ', '' } else { 'falló la carga WMS; revise el log.' })" }
    $resumen += "$($l.nombre): $($m -replace '^OK ', '')"
  }
  $mensaje = "OK $($resumen -join ' · ')"
  Write-Output $mensaje
  $codigo = 0
} catch {
  $mensaje = "ERROR $($_.Exception.Message)"
  Write-Output $mensaje
} finally {
  if ($run) {
    $resultado = if ($codigo) { 'error' } else { 'ok' }
    $ErrorActionPreference = 'Continue'
    & $node (Join-Path $destino 'robot.mjs') fin $run.id $resultado ($mensaje -replace '"', "'") 2>&1 | ForEach-Object { "$_" }
    $ErrorActionPreference = 'Stop'
  }
  Remove-Item Env:WMS_CLAVE, Env:WMS_USUARIO -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
}
exit $codigo
