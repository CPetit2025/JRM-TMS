# Carga automática del ERP a /apt/datos: refresca los dos Excel y los sube con el robot. Ver docs/carga-erp-automatica.md.
#   Instalar (una vez):  .\ejecutar.ps1 -Instalar -Actualizable <ruta> -Stock <ruta> [-Hora 07:00] (luego cada 3 horas hasta 12 h después)
#   Ejecutar ahora:      & "$env:LOCALAPPDATA\JRM-TMS\erp-auto\ejecutar.ps1" [-Revisar]
param(
  [switch]$Instalar,
  [string]$Actualizable,
  [string]$Stock,
  [string]$Hora = '07:00',
  [switch]$Revisar
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
  $accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$destino\ejecutar.ps1`""
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

$log = Join-Path $PSScriptRoot "logs\$(Get-Date -Format 'yyyy-MM-dd_HHmm').log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
Get-ChildItem (Split-Path $log) -Filter *.log | Sort-Object Name -Descending | Select-Object -Skip 400 | Remove-Item
Start-Transcript $log | Out-Null
try {
  $cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
  # Primero el Stock: el Actualizable tiene un vínculo a ese libro
  & (Join-Path $PSScriptRoot 'refrescar.ps1') -Archivos $cfg.stock, $cfg.actualizable
  if ($LASTEXITCODE) { throw 'No se refrescaron los Excel; no se cargó nada' }
  $credencial = Join-Path $PSScriptRoot 'credencial.xml'
  if (-not (Test-Path $credencial)) { throw 'Falta el usuario del TMS del robot: repita la instalación (-Instalar)' }
  $cred = Import-Clixml $credencial
  $env:TMS_USUARIO = $cred.UserName
  $env:TMS_CLAVE = $cred.GetNetworkCredential().Password
  $extra = @(); if ($Revisar) { $extra = @('--revisar') }
  [Console]::OutputEncoding = [Text.Encoding]::UTF8  # Node escribe UTF-8; sin esto los acentos salen rotos en el log
  & $node (Join-Path $PSScriptRoot 'cargar.mjs') @extra $cfg.actualizable $cfg.stock 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE) { throw 'La carga en el TMS falló' }
  $codigo = 0
} catch {
  Write-Output "ERROR $($_.Exception.Message)"
  $codigo = 1
} finally {
  Remove-Item Env:TMS_CLAVE -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
}
exit $codigo
