# OCAYORK Realm Map en Render

Este servicio descarga el Realm Bedrock, actualiza el mapa con uNmINeD y sirve los tiles directamente desde Render.

## Comportamiento actual

- Solo se ejecuta una actualización a la vez.
- Al terminar un ciclo espera `UPDATE_INTERVAL_MINUTES` antes de iniciar el siguiente.
- uNmINeD usa un solo procesador de chunks por defecto.
- El mapa existente no se borra antes de renderizar: uNmINeD conserva los tiles previos y actualiza los que cambian.
- El visor usa una caché de memoria reducida en celulares y una caché persistente separada para tiles.
- `/status` expone fase y porcentaje aproximado del render.
- `/ping` es liviano y nunca inicia una descarga o un render.

## Variables

- `REALM_ID`: ID del Realm.
- `UPDATE_INTERVAL_MINUTES`: por defecto 360 (6 horas después de terminar el ciclo anterior).
- `INITIAL_UPDATE_DELAY_SECONDS`: espera inicial antes del primer ciclo.
- `ZOOM_IN`: por defecto 0.
- `ZOOM_OUT`: por defecto 10.
- `CLIENT_EXTRA_ZOOM`: por defecto 3; el acercamiento adicional lo hace el navegador sin generar más tiles.
- `UNMINED_CHUNK_PROCESSORS`: por defecto 1.
- `UNMINED_GC_HEAP_LIMIT`: límite de memoria para uNmINeD.
- `WEBP_QUALITY`: por defecto 85.
- `WEBP_METHOD`: por defecto 2.
- `DATA_DIR`: opcional. Si el servicio tiene un disco persistente, debe apuntar al punto de montaje.
- `AUTH_CACHE_ZIP_BASE64`: ZIP Base64 de `automation/.auth-cache`. Es secreto.
- `REFRESH_TOKEN`: protege la actualización manual de `/refresh`.

## Persistencia

El servicio funciona en el plan gratuito, pero el disco local de una instancia gratuita es efímero. Por eso un reinicio completo de la instancia puede obligar a reconstruir el mapa del servidor.

El código ya está preparado para persistencia real: al añadir un disco persistente, configure `DATA_DIR` con su punto de montaje. El directorio contiene el mundo de trabajo, el mapa generado, la caché de autenticación y `map-state.json`.

La caché del navegador es independiente y conserva los tiles que el usuario ya visitó siempre que el sistema operativo/navegador no decida liberar almacenamiento.

## Endpoints

- `/`: mapa generado.
- `/health`: health check.
- `/ping`: estado mínimo y memoria.
- `/status`: estado detallado, fase y progreso.
- `/refresh`: actualización manual protegida.

## Exportar la caché Microsoft en Windows

Desde la raíz del repositorio:

```powershell
Compress-Archive -Path ".\automation\.auth-cache\*" -DestinationPath "$env:TEMP\minecraft-auth-cache.zip" -Force
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\minecraft-auth-cache.zip")) | Set-Clipboard
```

Pegue el contenido como variable secreta `AUTH_CACHE_ZIP_BASE64` en Render. No lo guarde en Git.
