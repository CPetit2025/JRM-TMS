# Carga automática del ERP a /apt/datos: refresca los dos Excel y los sube con el robot. Ver docs/carga-erp-automatica.md.
#   Instalar (una vez):  .\ejecutar.ps1 -Instalar -Actualizable <ruta> -Stock <ruta> [-Hora 07:00] (luego cada 3 horas hasta 12 h después)
#   Ejecutar ahora:      & "$env:LOCALAPPDATA\JRM-TMS\erp-auto\ejecutar.ps1" [-Revisar]
#   «Actualizar ahora» (una vez, además de lo anterior):  .\ejecutar.ps1 -InstalarSolicitudes -SupabaseUrl <url base TMS> -SupabaseAnon <clave pública>
#     Agrega una tarea que cada minuto pregunta si alguien pidió una actualización desde la web; las horas fijas no cambian.
param(
  [switch]$Instalar,
  [string]$Actualizable,
  [string]$Stock,
  [string]$Hora = '07:00',
  [switch]$Revisar,
  [switch]$InstalarSolicitudes,
  [switch]$Solicitudes,
  [string]$SupabaseUrl,
  [string]$SupabaseAnon
)
$ErrorActionPreference = 'Stop'
$destino = Join-Path $env:LOCALAPPDATA 'JRM-TMS\erp-auto'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }

if ($Instalar) {
  if (-not $Actualizable -or -not $Stock) { throw 'Indique -Actualizable y -Stock (rutas de los dos Excel)' }
  New-Item -ItemType Directory -Force (Join-Path $destino 'logs') | Out-Null
  Copy-Item (Join-Path $PSScriptRoot '*') $destino -Force
  Push-Location $destino
  try { & (Join-Path (Split-Path $node) 'npm.cmd') install --omit=dev --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm install falló' } } finally { Pop-Location }
  @{ actualizable = (Resolve-Path $Actualizable).Path; stock = (Resolve-Path $Stock).Path } | ConvertTo-Json | Set-Content (Join-Path $destino 'config.json') -Encoding UTF8
  # Usuario del TMS para el robot: queda cifrado con DPAPI (solo este usuario de Windows en este equipo puede leerlo)
  Get-Credential -Message 'Usuario y contraseña del TMS para la carga automática del ERP' | Export-Clixml (Join-Path $destino 'credencial.xml')
  $accion = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$destino\ejecutar.ps1`""
  # Todos los días desde -Hora, cada 3 horas durante 12 h (07, 10, 13, 16 y 19 h): cada carga ocupa la base unos 13 min
  $cuando = New-ScheduledTaskTrigger -Daily -At $Hora
  $cuando.Repetition = (New-ScheduledTaskTrigger -Once -At $Hora -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Hours 12 -Minutes 5)).Repetition
  # Excel necesita la sesión de Windows iniciada: la tarea corre solo con el usuario conectado
  $quien = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'JRM-TMS carga ERP' -Action $accion -Trigger $cuando -Principal $quien -Settings $ajustes -Force | Out-Null
  Write-Output "Instalado en $destino; tarea «JRM-TMS carga ERP» cada 3 horas desde las $Hora (5 veces al día). Pruebe con: & `"$destino\ejecutar.ps1`" -Revisar"
  exit 0
}

if ($InstalarSolicitudes) {
  if (-not $SupabaseUrl -or -not $SupabaseAnon) { throw 'Indique -SupabaseUrl y -SupabaseAnon (URL y clave pública de la base TMS)' }
  if ($SupabaseUrl -notmatch 'eojfsbogysifxrlrnjvx') { throw 'Indique la base del TMS (https://eojfsbogysifxrlrnjvx.supabase.co)' }
  if (-not (Test-Path (Join-Path $destino 'config.json'))) { throw 'Primero instale la carga a horas fijas (-Instalar)' }
  # Actualiza los scripts sin tocar la configuración ni la cuenta guardadas
  Copy-Item (Join-Path $PSScriptRoot '*') $destino -Force -Exclude 'config.json', 'credencial.xml'
  $cfgPath = Join-Path $destino 'config.json'
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $cfg | Add-Member -NotePropertyName supabaseUrl -NotePropertyValue $SupabaseUrl.TrimEnd('/') -Force
  $cfg | Add-Member -NotePropertyName supabaseAnon -NotePropertyValue $SupabaseAnon -Force
  $cfg | ConvertTo-Json | Set-Content $cfgPath -Encoding UTF8
  $accion = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$destino\ejecutar.ps1`" -Solicitudes"
  $cuando = New-ScheduledTaskTrigger -Daily -At '00:00'
  $cuando.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
  $quien = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'JRM-TMS carga ERP (Actualizar ahora)' -Action $accion -Trigger $cuando -Principal $quien -Settings $ajustes -Force | Out-Null
  Write-Output 'Instalada la tarea «JRM-TMS carga ERP (Actualizar ahora)»: cada minuto atiende las solicitudes de la web. La carga a horas fijas sigue igual.'
  exit 0
}

if ($Solicitudes) {
  # Corre cada minuto: solo pregunta si toca. Sin solicitud no deja log (serían 1.440 por día).
  $cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
  if (-not $cfg.supabaseUrl) { exit 0 }
  $cred = Import-Clixml (Join-Path $PSScriptRoot 'credencial.xml')
  $env:TMS_SUPABASE_URL = $cfg.supabaseUrl; $env:TMS_SUPABASE_ANON = $cfg.supabaseAnon
  $env:TMS_USUARIO = $cred.UserName; $env:TMS_CLAVE = $cred.GetNetworkCredential().Password
  # La base WMS y su cuenta salen del robot de ingresos WMS, si está instalado
  $wmsDir = Join-Path (Split-Path $PSScriptRoot) 'wms-auto'
  if ((Test-Path (Join-Path $wmsDir 'config.json')) -and (Test-Path (Join-Path $wmsDir 'credencial.xml'))) {
    $wc = Get-Content (Join-Path $wmsDir 'config.json') -Raw | ConvertFrom-Json
    $cw = Import-Clixml (Join-Path $wmsDir 'credencial.xml')
    $env:WMS_SUPABASE_URL = $wc.supabaseUrl; $env:WMS_SUPABASE_ANON = $wc.supabaseAnon
    $env:WMS_USUARIO = $cw.UserName; $env:WMS_CLAVE = $cw.GetNetworkCredential().Password
  }
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $ErrorActionPreference = 'Continue'
  try {
    $salida = & $node (Join-Path $PSScriptRoot 'solicitudes.mjs') inicio 2>&1 | ForEach-Object { "$_" }
    $json = $salida | Where-Object { $_ -like '{*' } | Select-Object -Last 1
    if ($json) {
      # Misma carga completa que la de horas fijas, con su propio log
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ejecutar.ps1')
      $resultado = if ($LASTEXITCODE -eq 0) { 'ok' } else { 'error' }
      $ultimo = Get-ChildItem (Join-Path $PSScriptRoot 'logs') -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      $linea = if ($ultimo) { (Select-String -Path $ultimo.FullName -Pattern '^(OK|ERROR|AVISO) ' | Select-Object -Last 1).Line }
      if (-not $linea) { $linea = "Actualización solicitada desde la web: $resultado" }
      $env:ERP_SOLICITUD = $json
      & $node (Join-Path $PSScriptRoot 'solicitudes.mjs') fin $resultado ($linea -replace '"', "'") 2>&1 | ForEach-Object { "$_" }
    }
  } finally {
    Remove-Item Env:TMS_CLAVE, Env:WMS_CLAVE, Env:ERP_SOLICITUD -ErrorAction SilentlyContinue
  }
  exit 0
}

# Una sola carga a la vez: la de horas fijas y la de «Actualizar ahora» no se pisan (Excel y la base).
try { $candado = [IO.File]::Open((Join-Path $PSScriptRoot 'carga.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Write-Output 'ERROR Otra carga del ERP está en curso; se omite esta.'; exit 3 }

$log = Join-Path $PSScriptRoot "logs\$(Get-Date -Format 'yyyy-MM-dd_HHmm').log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
Get-ChildItem (Split-Path $log) -Filter *.log | Sort-Object Name -Descending | Select-Object -Skip 400 | Remove-Item
Start-Transcript $log | Out-Null
try {
  $cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
  # Primero el Stock: el Actualizable tiene un vínculo a ese libro
  # Se trabaja sobre una copia: los originales pueden estar abiertos por el usuario (con cambios) y no se tocan
  $trabajo = Join-Path $PSScriptRoot 'trabajo'
  New-Item -ItemType Directory -Force $trabajo | Out-Null
  $stock = Join-Path $trabajo (Split-Path $cfg.stock -Leaf)
  $actualizable = Join-Path $trabajo (Split-Path $cfg.actualizable -Leaf)
  Copy-Item $cfg.stock $stock -Force
  Copy-Item $cfg.actualizable $actualizable -Force
  & (Join-Path $PSScriptRoot 'refrescar.ps1') -Archivos $stock, $actualizable
  if ($LASTEXITCODE) { throw 'No se refrescaron los Excel; no se cargó nada' }
  $credencial = Join-Path $PSScriptRoot 'credencial.xml'
  if (-not (Test-Path $credencial)) { throw 'Falta el usuario del TMS del robot: repita la instalación (-Instalar)' }
  $cred = Import-Clixml $credencial
  $env:TMS_USUARIO = $cred.UserName
  $env:TMS_CLAVE = $cred.GetNetworkCredential().Password
  $extra = @(); if ($Revisar) { $extra = @('--revisar') }
  [Console]::OutputEncoding = [Text.Encoding]::UTF8  # Node escribe UTF-8; sin esto los acentos salen rotos en el log
  # Lo que Node escribe en stderr es parte del log, no un error de PowerShell (con Stop cortaba la salida)
  $ErrorActionPreference = 'Continue'
  & $node (Join-Path $PSScriptRoot 'cargar.mjs') @extra $actualizable $stock 2>&1 | ForEach-Object { "$_" }
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE) { throw 'La carga en el TMS falló' }
  # Mismos archivos al WMS (fuente del stock de referencia), con la cuenta del robot de ingresos WMS si está instalado
  $credWms = Join-Path (Split-Path $PSScriptRoot) 'wms-auto\credencial.xml'
  if (Test-Path $credWms) {
    $cw = Import-Clixml $credWms
    $env:WMS_USUARIO = $cw.UserName
    $env:WMS_CLAVE = $cw.GetNetworkCredential().Password
    $ErrorActionPreference = 'Continue'
    & $node (Join-Path $PSScriptRoot 'cargar-wms.mjs') @extra $actualizable $stock 2>&1 | ForEach-Object { "$_" }
    $ErrorActionPreference = 'Stop'
    Remove-Item Env:WMS_CLAVE, Env:WMS_USUARIO -ErrorAction SilentlyContinue
    if ($LASTEXITCODE) { throw 'La carga en el TMS se aplicó, pero la del WMS falló' }
  } else { Write-Output 'AVISO Sin cuenta del robot WMS (wms-auto): no se cargó el WMS' }
  $codigo = 0
} catch {
  Write-Output "ERROR $($_.Exception.Message)"
  $codigo = 1
} finally {
  Remove-Item Env:TMS_CLAVE -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
  $candado.Dispose()
}
exit $codigo
