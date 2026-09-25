# OCAYORK Realm Map en Render

Este servicio web descarga el Realm Bedrock, genera un mapa con uNmINeD y lo sirve directamente desde Render.

## Variables

- `REALM_ID`: por defecto `33911323`.
- `UPDATE_INTERVAL_MINUTES`: por defecto `15`.
- `ZOOM_IN`: por defecto `3`.
- `ZOOM_OUT`: por defecto `8`.
- `AUTH_CACHE_ZIP_BASE64`: ZIP en Base64 de `automation/.auth-cache`. Es un secreto y nunca debe subirse al repositorio.

## Exportar la cache Microsoft en Windows

Desde la raiz del repositorio:

```powershell
Compress-Archive -Path ".\automation\.auth-cache\*" -DestinationPath "$env:TEMP\minecraft-auth-cache.zip" -Force
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\minecraft-auth-cache.zip")) | Set-Clipboard
```

Pegue el contenido del portapapeles directamente como variable secreta `AUTH_CACHE_ZIP_BASE64` en Render. No lo comparta por chat ni lo guarde en Git.

## Endpoints

- `/`: mapa generado.
- `/health`: health check.
- `/status`: estado de la ultima actualizacion.
- `/refresh`: solicita una actualizacion manual.

En una instancia gratuita, los archivos locales son efimeros. Si Render reinicia el servicio, el mapa se vuelve a generar desde el Realm. La variable `AUTH_CACHE_ZIP_BASE64` permite sembrar de nuevo la cache de Microsoft.
