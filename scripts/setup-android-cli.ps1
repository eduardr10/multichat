# Instalacion por CLI del toolchain Android (sin Android Studio).
# Idempotente: si un paso ya esta hecho, lo salta. Todo pesado va a E:.
$ErrorActionPreference = 'Stop'

$tools      = 'E:\tools'
$sdk        = 'E:\android-sdk'
$gradleHome = 'E:\gradle'

New-Item -ItemType Directory -Force -Path $tools, $sdk, $gradleHome | Out-Null

# --- 1) JDK 21 portable (Temurin zip, sin admin) -------------------------
$jdkDir = Get-ChildItem $tools -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $jdkDir) {
    Write-Host '[1/4] Descargando JDK 21 (Temurin)...'
    $jdkZip = Join-Path $tools 'jdk21.zip'
    Invoke-WebRequest -Uri 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' `
        -OutFile $jdkZip -UseBasicParsing
    Write-Host '      Extrayendo...'
    tar -xf $jdkZip -C $tools
    Remove-Item $jdkZip -Force
    $jdkDir = Get-ChildItem $tools -Directory -Filter 'jdk-21*' | Select-Object -First 1
} else {
    Write-Host "[1/4] JDK 21 ya instalado: $($jdkDir.FullName)"
}
$env:JAVA_HOME = $jdkDir.FullName
[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdkDir.FullName, 'User')

# --- 2) Android command-line tools ---------------------------------------
$cmBin = Join-Path $sdk 'cmdline-tools\latest\bin'
if (-not (Test-Path (Join-Path $cmBin 'sdkmanager.bat'))) {
    Write-Host '[2/4] Descargando Android command-line tools...'
    $cmZip = Join-Path $tools 'cmdline-tools.zip'
    $urls = @(
        'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip',
        'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
    )
    $downloaded = $false
    foreach ($url in $urls) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $cmZip -UseBasicParsing
            $downloaded = $true
            break
        } catch {
            Write-Host "      Fallo $url, pruebo la siguiente..."
        }
    }
    if (-not $downloaded) { throw 'No pude descargar command-line tools' }
    $tmp = Join-Path $tools 'cm-tmp'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    tar -xf $cmZip -C $tmp
    New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
    Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $sdk 'cmdline-tools\latest') -Force
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $cmZip -Force
} else {
    Write-Host '[2/4] command-line tools ya instalados'
}

# --- 3) Variables de entorno (usuario) -----------------------------------
$env:ANDROID_HOME = $sdk
$env:GRADLE_USER_HOME = $gradleHome
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('GRADLE_USER_HOME', $gradleHome, 'User')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$add = @($cmBin, (Join-Path $sdk 'platform-tools'))
foreach ($p in $add) {
    if ($userPath -notlike "*$p*") { $userPath = "$userPath;$p" }
}
[Environment]::SetEnvironmentVariable('Path', $userPath.Trim(';'), 'User')
$env:Path = "$env:JAVA_HOME\bin;$cmBin;$env:Path"
Write-Host '[3/4] Variables de entorno seteadas (JAVA_HOME, ANDROID_HOME, GRADLE_USER_HOME, PATH)'

# --- 4) Licencias + paquetes del SDK -------------------------------------
$sdkmanager = Join-Path $cmBin 'sdkmanager.bat'
if (-not (Test-Path (Join-Path $sdk 'platforms\android-36'))) {
    Write-Host '[4/4] Aceptando licencias e instalando paquetes del SDK (puede tardar)...'
    1..15 | ForEach-Object { 'y' } | & $sdkmanager --sdk_root=$sdk --licenses
    if ($LASTEXITCODE -ne 0) { throw 'Error aceptando licencias' }
    & $sdkmanager --sdk_root=$sdk 'platform-tools' 'platforms;android-36'
    if ($LASTEXITCODE -ne 0) { throw 'Error instalando platform-tools/platforms' }
    & $sdkmanager --sdk_root=$sdk 'build-tools;36.0.0'
    if ($LASTEXITCODE -ne 0) {
        Write-Host '      build-tools 36.0.0 no disponible, pruebo 35.0.0...'
        & $sdkmanager --sdk_root=$sdk 'build-tools;35.0.0'
        if ($LASTEXITCODE -ne 0) { throw 'Error instalando build-tools' }
    }
} else {
    Write-Host '[4/4] Paquetes del SDK ya instalados'
}

Write-Host ''
Write-Host '=== Verificacion ==='
& (Join-Path $env:JAVA_HOME 'bin\java.exe') -version
& $sdkmanager --sdk_root=$sdk --list_installed
Write-Host ''
Write-Host 'Listo. Los builds usan estas rutas via scripts/build-apk.ps1 (no requiere reiniciar).'
