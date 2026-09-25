$ErrorActionPreference = "Stop"

$automationDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $automationDir "config.json"
$updateScript = Join-Path $automationDir "update-map.ps1"
$taskScript = Join-Path $automationDir "register-task.ps1"

Write-Host ""
Write-Host "======================================================="
Write-Host " CONFIGURACION DEL MAPA AUTOMATICO DEL MINECRAFT REALM"
Write-Host "======================================================="
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js no esta instalado. Instala Node.js LTS y vuelve a ejecutar este script."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm no esta disponible."
}

Push-Location $automationDir
try {
    Write-Host "Instalando dependencias..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install fallo."
    }

    Write-Host ""
    Write-Host "Ahora se iniciara sesion con Microsoft y se mostraran tus Realms."
    Write-Host "Cuando aparezca el codigo, abre la direccion indicada e inicia sesion."
    Write-Host ""

    node realm.js list
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudieron consultar los Realms."
    }
}
finally {
    Pop-Location
}

Write-Host ""
$realmId = Read-Host "Copia y pega el ID del Realm que quieres mapear"

$defaultUnmined = "C:\unmined\unmined-cli.exe"
$unminedCli = Read-Host "Ruta de unmined-cli.exe [$defaultUnmined]"

if ([string]::IsNullOrWhiteSpace($unminedCli)) {
    $unminedCli = $defaultUnmined
}

if (-not (Test-Path $unminedCli)) {
    throw "No encuentro '$unminedCli'. Descarga uNmINeD CLI, extraelo y vuelve a ejecutar setup.ps1."
}

$intervalText = Read-Host "Cada cuantos minutos quieres actualizar el mapa [30]"
if ([string]::IsNullOrWhiteSpace($intervalText)) {
    $intervalMinutes = 30
}
else {
    $intervalMinutes = [int]$intervalText
}

$config = [ordered]@{
    realmId = "$realmId"
    unminedCli = "$unminedCli"
    intervalMinutes = $intervalMinutes
    preserveCustomMarkers = $true
}

$configJson = $config | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $configJson, $utf8NoBom)

Write-Host ""
Write-Host "Configuracion guardada."
Write-Host "Descargando el Realm y generando el primer mapa..."
Write-Host ""

& $updateScript -SkipDeploy
if ($LASTEXITCODE -ne 0) {
    throw "No se pudo generar el primer mapa."
}

$renderDir = Join-Path $automationDir "work\rendered"

Write-Host ""
Write-Host "Ahora vamos a vincular la carpeta generada con tu proyecto de Vercel."
Write-Host "Cuando Vercel pregunte por el proyecto, selecciona el proyecto existente de Mundo Minecraft."
Write-Host ""

Push-Location $renderDir
try {
    npx --yes vercel@latest login
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo iniciar sesion en Vercel."
    }

    npx --yes vercel@latest link
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo vincular el proyecto de Vercel."
    }

    Write-Host ""
    Write-Host "Haciendo el primer despliegue..."
    npx --yes vercel@latest --prod --yes
    if ($LASTEXITCODE -ne 0) {
        throw "El primer despliegue fallo."
    }
}
finally {
    Pop-Location
}

Write-Host ""
$createTask = Read-Host "Quieres crear ahora la actualizacion automatica cada $intervalMinutes minutos? [S/n]"

if ([string]::IsNullOrWhiteSpace($createTask) -or $createTask.ToLower().StartsWith("s")) {
    & $taskScript -IntervalMinutes $intervalMinutes
}

Write-Host ""
Write-Host "Listo."
Write-Host "Puedes probar una actualizacion manual ejecutando automation\update-map.ps1"
Write-Host ""
