# Sincroniza la web con Android y compila el APK de depuracion (100% CLI).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Entorno (funciona aunque no esten seteadas las variables de usuario)
if (-not $env:JAVA_HOME) {
    $jdk = Get-ChildItem 'E:\tools' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $jdk) { throw 'JDK no encontrado. Corre scripts/setup-android-cli.ps1 primero.' }
    $env:JAVA_HOME = $jdk.FullName
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = 'E:\android-sdk' }
if (-not $env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = 'E:\gradle' }
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

Push-Location $root
try {
    Write-Host '==> cap sync (copia www/ al proyecto Android)'
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'cap sync fallo' }

    # local.properties para que Gradle encuentre el SDK sin ANDROID_HOME
    $lp = Join-Path $root 'android\local.properties'
    $sdkDir = $env:ANDROID_HOME -replace '\\', '\\\\' -replace ':', '\:'
    Set-Content -Path $lp -Value "sdk.dir=$sdkDir" -Encoding ascii

    Write-Host '==> gradlew assembleDebug (primer build descarga Gradle, tarda)'
    Push-Location (Join-Path $root 'android')
    try {
        & .\gradlew.bat assembleDebug
        if ($LASTEXITCODE -ne 0) { throw 'gradlew fallo (revisa el error arriba)' }
    } finally {
        Pop-Location
    }

    $apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path $apk)) { throw 'APK no encontrado en la ruta esperada' }
    $out = Join-Path $root 'MultiChat.apk'
    Copy-Item $apk $out -Force
    $size = [math]::Round((Get-Item $out).Length / 1MB, 1)
    Write-Host ''
    Write-Host "APK listo: $out ($size MB)"
    Write-Host 'Instalar: copialo al telefono y abrilo (permite "origenes desconocidos"),'
    Write-Host 'o con el telefono conectado: adb install -r MultiChat.apk'
} finally {
    Pop-Location
}
