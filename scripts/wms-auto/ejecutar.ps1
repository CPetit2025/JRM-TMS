# Robot local de ingresos para etiquetado. Lee solo C:\WMS\entrada.xlsx.
[CmdletBinding()]
param(
  [switch]$Instalar,
  [switch]$Programar,
  [string]$Entrada = 'C:\WMS\entrada.xlsx',
  [string]$Url = 'https://jrm-wms-staging.vercel.app',
  [string]$Hora = '07:00',
  [switch]$Revisar
)
$ErrorActionPreference = 'Stop'
$destino = Join-Path $env:LOCALAPPDATA 'JRM-TMS\wms-auto'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }

function Register-WmsTask {
  if (-not (Test-Path (Join-Path $destino 'config.json'))) { throw 'Instale primero con -Instalar.' }
  $parts = $Hora.Split(':')
  if ($parts.Count -ne 2 -or [int]$parts[0] -gt 23 -or [int]$parts[1] -gt 59) { throw 'Use -Hora HH:mm.' }
  $at = (Get-Date).Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
  if ($at -le (Get-Date)) { $at = $at.AddDays(1) }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$destino\ejecutar.ps1`""
  $trigger = New-ScheduledTaskTrigger -Daily -At $at
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'JRM WMS ingresos para etiquetas' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Output "Programado diariamente a las $Hora. Requiere sesión Windows iniciada."
}

if ($Instalar) {
  if (-not (Test-Path -LiteralPath $Entrada -PathType Leaf)) { throw "No existe $Entrada" }
  $uriWms = [Uri]$Url
  if ($uriWms.Scheme -ne 'https' -or $uriWms.Host -notin @('jrm-wms-staging.vercel.app','jrm-wms.vercel.app') -or $uriWms.UserInfo -or $uriWms.Query -or $uriWms.Fragment -or $uriWms.AbsolutePath -ne '/' -or -not $uriWms.IsDefaultPort) {
    throw 'La instalación requiere el sitio independiente de WMS Staging o WMS Producción.'
  }
  if (-not (Test-Path $node)) { throw 'Instale Node.js LTS y vuelva a ejecutar.' }
  New-Item -ItemType Directory -Force (Join-Path $destino 'logs'), (Join-Path $destino 'trabajo') | Out-Null
  Get-ChildItem -LiteralPath $PSScriptRoot -File | Copy-Item -Destination $destino -Force
  Push-Location $destino
  try {
    & (Join-Path (Split-Path $node) 'npm.cmd') install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'npm install falló.' }
  } finally { Pop-Location }
  @{ entrada = (Resolve-Path -LiteralPath $Entrada).Path; url = $Url.TrimEnd('/') } |
    ConvertTo-Json | Set-Content (Join-Path $destino 'config.json') -Encoding UTF8
  $cred = Get-Credential -Message 'Cuenta WMS con permiso de carga. La contraseña queda cifrada localmente con DPAPI.'
  if (-not $cred) { throw 'Instalación cancelada: falta la cuenta WMS.' }
  $cred | Export-Clixml (Join-Path $destino 'credencial.xml')
  Write-Output "Instalado en $destino. Ejecute primero: & `"$destino\ejecutar.ps1`" -Revisar"
  if ($Programar) { Register-WmsTask }
  exit 0
}

if ($Programar) { Register-WmsTask; exit 0 }

$log = Join-Path $destino ("logs\$(Get-Date -Format 'yyyy-MM-dd_HHmm').log")
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
Start-Transcript -Path $log | Out-Null
$code = 1
try {
  $cfg = Get-Content (Join-Path $destino 'config.json') -Raw | ConvertFrom-Json
  $work = Join-Path $destino 'trabajo'
  $file = Join-Path $work 'entrada.xlsx'
  Copy-Item -LiteralPath $cfg.entrada -Destination $file -Force
  $hash = $cfg.url + '|' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  $state = Join-Path $destino 'ultimo-hash.txt'
  if (-not $Revisar -and (Test-Path $state) -and (Get-Content $state -Raw).Trim() -eq $hash) {
    Write-Output 'Sin cambios en C:\WMS\entrada.xlsx; no se volvió a cargar.'
    $code = 0
  } else {
    $cred = Import-Clixml (Join-Path $destino 'credencial.xml')
    $env:WMS_URL = $cfg.url
    $env:WMS_USUARIO = $cred.UserName
    $env:WMS_CLAVE = $cred.GetNetworkCredential().Password
    $extra = @()
    if ($Revisar) { $extra = @('--revisar') }
    $ok = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      & $node (Join-Path $destino 'cargar-entrada.mjs') @extra $file
      if ($LASTEXITCODE -eq 0) { $ok = $true; break }
      if ($attempt -lt 3) { Start-Sleep -Seconds (5 * $attempt) }
    }
    if (-not $ok) { throw 'Falló la carga WMS tras tres intentos; revise el log.' }
    if (-not $Revisar) { $hash | Set-Content $state -NoNewline }
    $code = 0
  }
} catch {
  Write-Output "ERROR $($_.Exception.Message)"
} finally {
  Remove-Item Env:WMS_CLAVE, Env:WMS_USUARIO, Env:WMS_URL -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
}
exit $code
