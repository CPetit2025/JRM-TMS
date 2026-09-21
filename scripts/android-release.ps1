param(
  [ValidateSet('init', 'build', 'publish')]
  [string]$Action = 'build'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$signing = Join-Path $root 'artifacts/android/signing'
$keystore = Join-Path $signing 'jrm-tms-release.p12'
$credential = Join-Path $signing 'password.dpapi'
$alias = 'jrm-tms-release'
$keytool = Join-Path $env:JAVA_HOME 'bin/keytool.exe'

if (!(Test-Path -LiteralPath $keytool)) { throw 'No se encontró keytool en JAVA_HOME.' }
New-Item -ItemType Directory -Path $signing -Force | Out-Null

$previous = @{}
foreach ($name in @('JRM_KEYSTORE_PATH', 'JRM_KEYSTORE_PASSWORD', 'JRM_KEY_ALIAS', 'JRM_KEY_PASSWORD')) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
  if ($Action -eq 'init') {
    if ((Test-Path -LiteralPath $keystore) -or (Test-Path -LiteralPath $credential)) {
      throw 'Ya existe una firma local. No se reemplazará el keystore de publicación.'
    }
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $env:JRM_KEYSTORE_PASSWORD = $password
    $env:JRM_KEY_PASSWORD = $password
    & $keytool -genkeypair -keystore $keystore -storetype PKCS12 -alias $alias `
      -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=JRM-TMS, O=JRM, C=PE' `
      '-storepass:env' 'JRM_KEYSTORE_PASSWORD' '-keypass:env' 'JRM_KEY_PASSWORD' -noprompt
    if ($LASTEXITCODE -ne 0) { throw 'Falló la generación del keystore.' }
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $credential -NoNewline
    Write-Output "Firma creada en $keystore"
    Write-Output 'La contraseña local está cifrada para este usuario de Windows. Guarda una copia recuperable en una bóveda segura antes de depender de actualizaciones.'
    return
  }

  if (!(Test-Path -LiteralPath $keystore) -or !(Test-Path -LiteralPath $credential)) {
    throw 'No existe firma local. Usa primero: .\scripts\android-release.ps1 init'
  }
  $secure = Get-Content -LiteralPath $credential -Raw | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $env:JRM_KEYSTORE_PATH = $keystore
  $env:JRM_KEYSTORE_PASSWORD = $password
  $env:JRM_KEY_ALIAS = $alias
  $env:JRM_KEY_PASSWORD = $password
  Push-Location $root
  try {
    & npm run build:apk
    if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación Android.' }
    if ($Action -eq 'publish') {
      & npm run publish:apk
      if ($LASTEXITCODE -ne 0) { throw 'Falló la publicación Android.' }
    }
  } finally { Pop-Location }
} finally {
  foreach ($name in $previous.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
  }
  $password = $null
}
