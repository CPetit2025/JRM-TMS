# Robot local de ingresos para etiquetas. Lee C:\WMS\entrada.xlsx; salida.xlsx queda intacto.
param([switch]$Instalar,[switch]$Programar,[string]$Entrada='C:\WMS\entrada.xlsx',[string]$Url='https://jrm-tms-git-feature-warehouse-wms-portal-cpetit2025s-projects.vercel.app',[string]$Hora='07:00',[switch]$Revisar)
$ErrorActionPreference='Stop';$destino=Join-Path $env:LOCALAPPDATA 'JRM-TMS\wms-auto';$node=(Get-Command node -ErrorAction SilentlyContinue).Source
if(-not $node){$node=Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'}
if($Instalar){
 if(-not(Test-Path -LiteralPath $Entrada -PathType Leaf)){throw "No existe $Entrada"};$hostWms=([Uri]$Url).Host
 if($hostWms -notlike '*git-feature-warehouse-wms-portal*' -or $hostWms -notlike '*.vercel.app' -or $hostWms -eq 'jrm-tms.vercel.app'){throw 'La instalación solo admite el preview WMS; producción queda bloqueada.'}
 if(-not(Test-Path $node)){throw 'Instale Node.js LTS y vuelva a ejecutar.'}
 New-Item -ItemType Directory -Force (Join-Path $destino 'logs'),(Join-Path $destino 'trabajo')|Out-Null
 Copy-Item (Join-Path $PSScriptRoot '*') $destino -Force
 Push-Location $destino;try{& (Join-Path (Split-Path $node) 'npm.cmd') install --omit=dev --no-audit --no-fund;if($LASTEXITCODE){throw 'npm install falló'}}finally{Pop-Location}
 @{entrada=(Resolve-Path -LiteralPath $Entrada).Path;url=$Url.TrimEnd('/')}|ConvertTo-Json|Set-Content (Join-Path $destino 'config.json') -Encoding UTF8
 $cred=Get-Credential -Message 'Cuenta WMS autorizada para importar ingresos. La contraseña se cifra localmente con DPAPI.';if(-not $cred){throw 'Instalación cancelada: falta la cuenta WMS.'};$cred|Export-Clixml (Join-Path $destino 'credencial.xml')
 Write-Output "Instalado en $destino. Primero ejecute: & `"$destino\ejecutar.ps1`" -Revisar"
 if($Programar){
 if(-not(Test-Path (Join-Path $destino 'config.json'))){throw 'Instale primero con -Instalar.'}
 $at=Get-Date
 $parts=$Hora.Split(':');$at=$at.Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1]);if($at -le (Get-Date)){$at=$at.AddDays(1)}
 $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$destino\ejecutar.ps1`""
 $trigger=New-ScheduledTaskTrigger -Daily -At $at
 $principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
 $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
 Register-ScheduledTask -TaskName 'JRM WMS ingresos para etiquetas' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force|Out-Null
 Write-Output "Programado diariamente a las $Hora. Requiere sesión Windows iniciada.";exit 0
}
$log=Join-Path $PSScriptRoot "logs\$(Get-Date -Format 'yyyy-MM-dd_HHmm').log";Start-Transcript $log|Out-Null;$code=1
try{
 $cfg=Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw|ConvertFrom-Json;$work=Join-Path $PSScriptRoot 'trabajo';$file=Join-Path $work 'entrada.xlsx'
 Copy-Item -LiteralPath $cfg.entrada -Destination $file -Force;$hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();$state=Join-Path $PSScriptRoot 'ultimo-hash.txt'
 if(-not $Revisar -and (Test-Path $state) -and (Get-Content $state -Raw).Trim() -eq $hash){Write-Output 'Sin cambios en C:\WMS\entrada.xlsx; no se volvió a cargar.';$code=0}
 else{
  $cred=Import-Clixml (Join-Path $PSScriptRoot 'credencial.xml');$env:WMS_URL=$cfg.url;$env:WMS_USUARIO=$cred.UserName;$env:WMS_CLAVE=$cred.GetNetworkCredential().Password
  $extra=@();if($Revisar){$extra=@('--revisar')};$ErrorActionPreference='Continue'
  & $node (Join-Path $PSScriptRoot 'cargar-entrada.mjs') @extra $file 2>&1|ForEach-Object{"$_"};$ErrorActionPreference='Stop'
  if($LASTEXITCODE){throw 'Falló la carga WMS; revise el log.'};if(-not $Revisar){$hash|Set-Content $state -NoNewline};$code=0
 }
}catch{Write-Output "ERROR $($_.Exception.Message)"}finally{Remove-Item Env:WMS_CLAVE,Env:WMS_USUARIO,Env:WMS_URL -ErrorAction SilentlyContinue;Stop-Transcript|Out-Null};exit $code
