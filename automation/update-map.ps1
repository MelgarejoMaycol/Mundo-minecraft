param(
    [switch]$SkipDeploy
)

$ErrorActionPreference = "Stop"

$automationDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $automationDir
$configPath = Join-Path $automationDir "config.json"
$workDir = Join-Path $automationDir "work"
$worldDir = Join-Path $workDir "world"
$renderDir = Join-Path $workDir "rendered"
$logsDir = Join-Path $automationDir "logs"

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$logFile = Join-Path $logsDir ("update-" + (Get-Date -Format "yyyy-MM-dd") + ".log")

Start-Transcript -Path $logFile -Append | Out-Null

try {
    Write-Host ""
    Write-Host "==============================================="
    Write-Host " Minecraft Realm -> uNmINeD -> Vercel"
    Write-Host "==============================================="
    Write-Host ("Inicio: " + (Get-Date))

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js no está instalado o no está en PATH."
    }

    if (-not (Test-Path $configPath)) {
        throw "Falta automation\config.json. Ejecuta setup.ps1 primero."
    }

    Push-Location $automationDir
    try {
        if (-not (Test-Path (Join-Path $automationDir "node_modules"))) {
            Write-Host "Instalando dependencias de Node.js..."
            npm install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install falló."
            }
        }

        Write-Host ""
        Write-Host "1/3 Descargando el mundo más reciente del Realm..."
        node realm.js download
        if ($LASTEXITCODE -ne 0) {
            throw "No se pudo descargar el Realm."
        }
    }
    finally {
        Pop-Location
    }

    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    $unminedCli = $config.unminedCli

    if ([string]::IsNullOrWhiteSpace($unminedCli) -or -not (Test-Path $unminedCli)) {
        throw "No encuentro uNmINeD CLI en '$unminedCli'. Corrige automation\config.json."
    }

    $renderOkMarker = Join-Path $renderDir ".render-ok"

    if ((Test-Path $renderDir) -and -not (Test-Path $renderOkMarker)) {
        Write-Host "Limpiando una exportación anterior incompleta..."
        Remove-Item $renderDir -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $renderDir | Out-Null

    Write-Host ""
    Write-Host "2/3 Actualizando el mapa con uNmINeD..."
    Write-Host "Formato de tiles: WebP"
    & $unminedCli web render "--world=$worldDir" "--output=$renderDir" "--imageformat=webp"

    if ($LASTEXITCODE -ne 0) {
        throw "uNmINeD terminó con código $LASTEXITCODE."
    }

    Set-Content -Path $renderOkMarker -Value (Get-Date).ToString("o") -Encoding ASCII

    $unminedIndex = Join-Path $renderDir "unmined.index.html"
    $webIndex = Join-Path $renderDir "index.html"

    if (Test-Path $unminedIndex) {
        Copy-Item $unminedIndex $webIndex -Force
    }

    if (-not (Test-Path $webIndex)) {
        throw "uNmINeD no generó index.html/unmined.index.html."
    }

    if ($config.preserveCustomMarkers -ne $false) {
        $customMarkers = Join-Path $repoDir "custom.markers.js"
        $customPin = Join-Path $repoDir "custom.pin.png"

        if (Test-Path $customMarkers) {
            Copy-Item $customMarkers (Join-Path $renderDir "custom.markers.js") -Force
        }

        if (Test-Path $customPin) {
            Copy-Item $customPin (Join-Path $renderDir "custom.pin.png") -Force
        }
    }

    if ($SkipDeploy) {
        Write-Host ""
        Write-Host "Mapa generado. Se omitió el despliegue a Vercel."
        Write-Host "Carpeta:" $renderDir
        return
    }

    Write-Host ""
    Write-Host "3/3 Publicando en Vercel..."

    $vercelProject = Join-Path $renderDir ".vercel\project.json"

    if (-not (Test-Path $vercelProject)) {
        $nl = [Environment]::NewLine
        $message = "Esta carpeta todavía no está vinculada con Vercel." + $nl +
                   "Ejecuta una sola vez desde: " + $renderDir + $nl +
                   "npx --yes vercel@latest login" + $nl +
                   "npx --yes vercel@latest link"
        throw $message
    }

    Push-Location $renderDir
    try {
        npx --yes vercel@latest --prod --yes
        if ($LASTEXITCODE -ne 0) {
            throw "El despliegue de Vercel falló."
        }
    }
    finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "Actualización terminada correctamente."
    Write-Host ("Fin: " + (Get-Date))
}
catch {
    Write-Error $_
    exit 1
}
finally {
    try {
        Stop-Transcript | Out-Null
    }
    catch {
    }
}
