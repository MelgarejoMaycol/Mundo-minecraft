param(
    [int]$IntervalMinutes = 0
)

$ErrorActionPreference = "Stop"

$automationDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $automationDir "config.json"
$updateScript = Join-Path $automationDir "update-map.ps1"
$taskName = "Minecraft Realm Map - Auto Update"

if (-not (Test-Path $configPath)) {
    throw "Falta config.json. Ejecuta setup.ps1 primero."
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json

if ($IntervalMinutes -le 0) {
    $IntervalMinutes = [int]$config.intervalMinutes
}

if ($IntervalMinutes -lt 5) {
    throw "Usa un intervalo mínimo de 5 minutos."
}

$quote = [char]34
$argument = "-NoProfile -ExecutionPolicy Bypass -File " + $quote + $updateScript + $quote

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Descarga el Minecraft Bedrock Realm, actualiza el mapa uNmINeD y lo publica en Vercel." -Force | Out-Null

Write-Host ""
Write-Host "Tarea creada correctamente:"
Write-Host "  $taskName"
Write-Host "Intervalo:"
Write-Host "  cada $IntervalMinutes minutos"
Write-Host ""
Write-Host "Los logs quedan en automation\logs\"
