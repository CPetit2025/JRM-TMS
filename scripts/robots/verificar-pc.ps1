# Verifica si esta PC puede correr los robots de actualización del TMS y del WMS (carga ERP e ingresos WMS).
# No instala nada, no necesita administrador y no cambia la configuración de la PC.
# Uso (PowerShell, con el usuario de Windows que dejará los robots):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\verificar-pc.ps1
# Al final muestra un resumen; envíe una foto o copie el texto.
param(
  [string]$Erp = 'C:\ERP',
  [string]$Wms = 'C:\WMS'
)
$ErrorActionPreference = 'Continue'
$res = [System.Collections.Generic.List[object]]::new()
function Paso($nombre, [scriptblock]$prueba) {
  try { $detalle = & $prueba; $res.Add([pscustomobject]@{ Resultado = 'OK'; Prueba = $nombre; Detalle = "$detalle" }) }
  catch { $res.Add([pscustomobject]@{ Resultado = 'FALLA'; Prueba = $nombre; Detalle = $_.Exception.Message }) }
}

Paso 'Equipo y usuario' { "$env:COMPUTERNAME · $env:USERDOMAIN\$env:USERNAME" }

# 1) Archivos actualizables
foreach ($f in @("$Erp\Actualizable Despacho.xlsm", "$Erp\StockBodegaDespacho.xlsm", "$Wms\entrada.xlsx", "$Wms\Traspado de Almacen APT.xlsx")) {
  Paso "Archivo $f" { $i = Get-Item -LiteralPath $f -ErrorAction Stop; "{0:N1} MB · modificado {1:dd/MM/yyyy HH:mm}" -f ($i.Length / 1MB), $i.LastWriteTime }
}

# 2) Excel de escritorio controlable en segundo plano (necesario para refrescar las consultas del ERP)
Paso 'Excel de escritorio (automatización)' {
  $x = New-Object -ComObject Excel.Application
  try { $v = $x.Version; "Excel $v" } finally { $x.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($x) }
}

# 3) Node.js (instalado o portable en la carpeta del usuario)
Paso 'Node.js' {
  $n = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $n) { $n = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
  if (-not (Test-Path $n)) { throw 'No está instalado. Se puede usar Node portable (zip) en la carpeta del usuario sin administrador.' }
  # Los robots necesitan Node 18 o superior (playwright-core y fetch global).
  $v = (& $n --version).Trim()
  if ([int]($v.TrimStart('v').Split('.')[0]) -lt 18) { throw "Node $v es muy antiguo: los robots requieren Node 18 o superior ($n)" }
  "$v · $n"
}

# 4) Crear una tarea programada del propio usuario (y borrarla al instante)
Paso 'Tareas programadas del usuario' {
  $nombre = 'JRM-prueba-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
  $accion = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0'
  $cuando = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(1)
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $cuando -ErrorAction Stop | Out-Null
  Unregister-ScheduledTask -TaskName $nombre -Confirm:$false
  'Se puede crear y borrar una tarea del usuario'
}

# 5) Ejecutar scripts de PowerShell (los robots son .ps1)
Paso 'Política de scripts' { $p = Get-ExecutionPolicy -List | Where-Object { $_.ExecutionPolicy -in 'AllSigned','Restricted' -and $_.Scope -in 'MachinePolicy','UserPolicy' }; if ($p) { throw "Bloqueada por política de grupo: $($p.Scope)=$($p.ExecutionPolicy)" }; 'Permitido con -ExecutionPolicy Bypass' }

# 6) Red: servidor del ERP y servicios en internet
Paso 'Servidor ERP (DATAFLEX)' { if (-not (Test-Connection DATAFLEX -Count 1 -Quiet)) { throw 'No responde DATAFLEX (puede bloquear ping; se confirma al refrescar el Excel)' }; 'Responde' }
foreach ($h in @('eojfsbogysifxrlrnjvx.supabase.co', 'glecgvomkaqmkfkhtxhi.supabase.co', 'wms.jrmlogistica.app', 'www.jrmlogistica.app')) {
  Paso "Internet $h" {
    # Cualquier respuesta del servidor (incluso 401/404) confirma la conexión; solo falla si no hay respuesta.
    try { Invoke-WebRequest -Uri "https://$h" -Method Head -UseBasicParsing -TimeoutSec 15 | Out-Null; 'Conecta (HTTPS)' }
    catch { if ($_.Exception.Response) { 'Conecta (HTTPS)' } else { throw "Sin conexión HTTPS (proxy o firewall): $($_.Exception.Message)" } }
  }
}

# 7) Energía: suspensión con corriente (la PC debe seguir encendida en los horarios de carga)
Paso 'Suspensión con corriente' {
  # La salida de powercfg depende del idioma, pero el orden no: mínimo, máximo, incremento, actual AC y actual DC.
  # El valor de corriente alterna (enchufada) es el penúltimo «0x…».
  $hex = @(powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null | Select-String '0x[0-9a-fA-F]{8}' | ForEach-Object { $_.Matches[0].Value })
  if ($hex.Count -lt 2) { return 'No se pudo leer: verifique que la PC no se suspenda en los horarios de carga' }
  $min = [Convert]::ToInt64($hex[-2], 16) / 60
  if ($min -gt 0) { "Se suspende a los $min min sin uso: conviene desactivarla o dejar la sesión activa" } else { 'Nunca se suspende' }
}

$res | Format-Table -AutoSize -Wrap
$fallas = @($res | Where-Object Resultado -eq 'FALLA')
if ($fallas.Count) { Write-Host "`nResultado: $($fallas.Count) punto(s) por resolver. Envíe esta pantalla." -ForegroundColor Yellow }
else { Write-Host "`nResultado: esta PC puede correr los robots." -ForegroundColor Green }
