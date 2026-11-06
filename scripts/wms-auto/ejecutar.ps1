# Robot de ingresos APT para WMS. Trabaja sobre una copia del Excel y carga mediante
# /almacen/apt/datos. La tarea programada es independiente de la del robot TMS.
param(
  [switch]$Instalar,
  [switch]$Programar,
  [string]$Entrada,
  [string]$Url = 'https://jrm-tms-git-feature-warehouse-wms-portal-cpetit2025s-projects.vercel.app',
  [string]$Hora = '07:00',
  [switch]$Revisar
)
$ErrorActionPreference = 'Stop'
$destino = Join-Path $env:LOCALAPPDATA 'JRM-TMS\wms-auto'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }

if ($Instalar) {
  if (-not $Entrada) { throw 'Indique -Entrada con la ruta local del Actualizable APT.' }
  if (-not (Test-Path -LiteralPath $Entrada -PathType Leaf)) { throw "No existe el archivo: $Entrada" }
  $hostWms = ([Uri]$Url).Host
  if ($hostWms -notlike '*git-feature-warehouse-wms-portal*' -or $hostWms -notlike '*.vercel.app' -or $hostWms -eq 'jrm-tms.vercel.app') {
    throw 'Por seguridad, instale el robot apuntando al preview WMS, no a Producción.'
  }
  if (-not (Test-Path $node)) { throw 'Instale Node.js LTS y vuelva a ejecutar.' }
  New-Item -ItemType Directory -Force (Join-Path $destino 'logs') | Out-Null
  Copy-Item (Join-Path $PSScriptRoot '*') $destino -Force
  Push-Location $destino
  try { & (Join-Path (Split-Path $node) 'npm.cmd') install --omit=dev --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm install falló' } } finally { Pop-Location }
  @{ entrada = (Resolve-Path -LiteralPath $Entrada).Path; url = $Url.TrimEnd('/'); maxHoras = 30 } |
    ConvertTo-Json | Set-Content (Join-Path $destino 'config.json') -Encoding UTF8
  Get-Credential -Message 'Cuenta aprobada para cargar el Actualizable APT en WMS (password cifrado con DPAPI)' |
    Export-Clixml (Join-Path $destino 'credencial.xml')
  Write-Output "Instalación lista en $destino. Ejecute primero: & `"$destino\ejecutar.ps1`" -Revisar"
  if ($Programar) { & $PSCommandPath -Programar -Hora $Hora }
  exit 0
}

if ($Programar) {
  if (-not (Test-Path (Join-Path $destino 'config.json'))) { throw 'Instale primero el robot con -Instalar.' }
  $accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$destino\ejecutar.ps1`""
  $cuando = New-ScheduledTaskTrigger -Daily -At $Hora
  $cuando.Repetition = (New-ScheduledTaskTrigger -Once -At $Hora -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Hours 12 -Minutes 5)).Repetition
  $quien = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'JRM WMS ingresos APT' -Action $accion -Trigger $cuando -Principal $quien -Settings $ajustes -Force | Out-Null
  Write-Output "Tarea «JRM WMS ingresos APT» instalada cada 3 horas desde las $Hora. Requiere sesión de Windows iniciada."
  exit 0
}

$log = Join-Path $PSScriptRoot "logs\$(Get-Date -Format 'yyyy-MM-dd_HHmm').log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
Get-ChildItem (Split-Path $log) -Filter *.log | Sort-Object Name -Descending | Select-Object -Skip 400 | Remove-Item
Start-Transcript $log | Out-Null
$codigo = 1
try {
  $cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
  $trabajo = Join-Path $PSScriptRoot 'trabajo'
  New-Item -ItemType Directory -Force $trabajo | Out-Null
  $entrada = Join-Path $trabajo (Split-Path $cfg.entrada -Leaf)
  Copy-Item -LiteralPath $cfg.entrada -Destination $entrada -Force
  & (Join-Path $PSScriptRoot 'refrescar.ps1') -Archivo $entrada -MaxHoras $cfg.maxHoras
  if ($LASTEXITCODE) { throw 'El libro no pasó las validaciones de actualización; no se cargó nada.' }
  $credencial = Join-Path $PSScriptRoot 'credencial.xml'
  if (-not (Test-Path $credencial)) { throw 'Falta la credencial WMS; repita la instalación.' }
  $cred = Import-Clixml $credencial
  $env:WMS_URL = $cfg.url
  $env:WMS_USUARIO = $cred.UserName
  $env:WMS_CLAVE = $cred.GetNetworkCredential().Password
  $extra = @(); if ($Revisar) { $extra = @('--revisar') }
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $ErrorActionPreference = 'Continue'
  & $node (Join-Path $PSScriptRoot 'cargar.mjs') @extra $entrada 2>&1 | ForEach-Object { "$_" }
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE) { throw 'La carga en el WMS falló; revise este log antes de reintentar.' }
  $codigo = 0
} catch {
  Write-Output "ERROR $($_.Exception.Message)"
} finally {
  Remove-Item Env:WMS_CLAVE -ErrorAction SilentlyContinue
  Remove-Item Env:WMS_USUARIO -ErrorAction SilentlyContinue
  Remove-Item Env:WMS_URL -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
}
exit $codigo
