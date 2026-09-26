const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const AdmZip = require('adm-zip')
const express = require('express')
const { Authflow, Titles } = require('prismarine-auth')
const { RealmAPI } = require('prismarine-realms')

const renderDir = __dirname
const repoDir = path.resolve(renderDir, '..')
const dataDir = process.env.DATA_DIR || path.join(renderDir, '.data')
const authDir = process.env.AUTH_CACHE_DIR || path.join(dataDir, 'auth-cache')
const workDir = path.join(dataDir, 'work')
const worldDir = path.join(workDir, 'world')
const downloadDir = path.join(workDir, 'download')
const mapDir = path.join(dataDir, 'map')
const metadataPath = path.join(dataDir, 'map-state.json')
const mcworldPath = path.join(downloadDir, 'realm.mcworld')
const unminedCli = process.env.UNMINED_CLI || path.join(renderDir, '.unmined', 'unmined-cli')

const realmId = String(process.env.REALM_ID || '33911323')
const updateMinutes = Math.max(60, Number(process.env.UPDATE_INTERVAL_MINUTES || 60))
const zoomIn = Math.max(0, Number(process.env.ZOOM_IN || 2))
const zoomOut = Math.max(0, Number(process.env.ZOOM_OUT || 10))
const clientExtraZoom = Math.max(0, Math.min(6, Number(process.env.CLIENT_EXTRA_ZOOM || 4)))
const chunkProcessors = Math.max(1, Number(process.env.UNMINED_CHUNK_PROCESSORS || 1))
const unminedHeapLimit = process.env.UNMINED_GC_HEAP_LIMIT || '10000000'
const tileCacheSeconds = Math.max(60, Number(process.env.TILE_CACHE_SECONDS || 600))
const assetCacheSeconds = Math.max(300, Number(process.env.ASSET_CACHE_SECONDS || 3600))
const refreshToken = String(process.env.REFRESH_TOKEN || '')
const port = Number(process.env.PORT || 10000)

const app = express()

function loadMetadata () {
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  } catch {
    return {}
  }
}

function saveMetadata (metadata) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
}

const persisted = loadMetadata()

const state = {
  ready: fs.existsSync(path.join(mapDir, 'index.html')),
  running: false,
  realmId,
  realmName: persisted.realmName || null,
  activeSlot: persisted.activeSlot || null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSuccessAt: persisted.lastSuccessAt || null,
  lastRealmHash: persisted.lastRealmHash || null,
  lastError: null,
  lastAction: null,
  updateMinutes,
  zoomIn,
  zoomOut,
  clientExtraZoom,
  chunkProcessors
}

function log (...args) {
  console.log(new Date().toISOString(), ...args)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function compactMemory () {
  if (global.gc) {
    try {
      global.gc()
    } catch {}
  }
}

function memorySnapshot () {
  const m = process.memoryUsage()
  return {
    rssMb: Math.round(m.rss / 1024 / 1024),
    heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(m.heapTotal / 1024 / 1024),
    externalMb: Math.round(m.external / 1024 / 1024)
  }
}

function isTransientNetworkError (error) {
  const text = String(
    (error && (error.code || error.message || error.statusCode || error.status)) || error || ''
  ).toUpperCase()

  return [
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    '429',
    '500',
    '502',
    '503',
    '504'
  ].some(code => text.includes(code))
}

async function withRetry (label, operation, attempts = 5) {
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) log(`Reintento ${attempt}/${attempts}: ${label}`)
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientNetworkError(error) || attempt === attempts) throw error

      const waitMs = Math.min(3000 * (2 ** (attempt - 1)), 24000)
      log(`Fallo temporal: ${error.message || error}. Reintentando en ${waitMs / 1000}s`)
      await sleep(waitMs)
    }
  }

  throw lastError
}

function directoryHasFiles (dir) {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
}

function restoreAuthCacheFromEnv () {
  if (directoryHasFiles(authDir)) return

  const encoded = process.env.AUTH_CACHE_ZIP_BASE64
  if (!encoded) {
    log('AUTH_CACHE_ZIP_BASE64 no esta configurado. Si hace falta, Microsoft mostrara un codigo de inicio de sesion en los logs.')
    return
  }

  try {
    fs.mkdirSync(authDir, { recursive: true })
    const zip = new AdmZip(Buffer.from(encoded.replace(/\s+/g, ''), 'base64'))
    zip.extractAllTo(authDir, true)
    log('Cache de autenticacion Microsoft restaurada desde variable segura.')
    compactMemory()
  } catch (error) {
    log('No se pudo restaurar AUTH_CACHE_ZIP_BASE64:', error.message)
  }
}

function createApi () {
  fs.mkdirSync(authDir, { recursive: true })

  const authflow = new Authflow(
    'mundo-minecraft-realm-map',
    authDir,
    {
      flow: 'live',
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo'
    },
    (code) => {
      console.log('\n====================================================')
      console.log(' ACCION NECESARIA: INICIO DE SESION MICROSOFT')
      console.log('====================================================')
      if (code.message) {
        console.log(code.message)
      } else {
        console.log('Abre:', code.verification_uri || 'https://www.microsoft.com/link')
        console.log('Codigo:', code.user_code)
      }
      console.log('Usa la cuenta Microsoft que tiene acceso al Realm.')
      console.log('====================================================\n')
    }
  )

  return RealmAPI.from(authflow, 'bedrock')
}

async function getRealms (api) {
  const result = await withRetry('consultar Realms', () => api.getRealms())
  return Array.isArray(result) ? result : []
}

async function downloadRealm ({ force = false } = {}) {
  const api = createApi()
  const realms = await getRealms(api)
  const realm = realms.find(item => String(item.id) === realmId)

  if (!realm) {
    throw new Error(`No se encontro el Realm ${realmId} para esta cuenta.`)
  }

  const slotId = String(realm.activeSlot)
  state.realmName = realm.name
  state.activeSlot = slotId

  log(`Realm: ${realm.name} | ID: ${realm.id} | slot: ${slotId}`)

  const download = await withRetry(
    'solicitar enlace de descarga del Realm',
    () => api.getRealmWorldDownload(String(realm.id), slotId, 'latest')
  )

  let buffer = await withRetry(
    'descargar archivo del mundo',
    () => download.getBuffer()
  )

  const bytes = buffer.length
  const realmHash = crypto.createHash('sha256').update(buffer).digest('hex')

  fs.mkdirSync(downloadDir, { recursive: true })
  fs.writeFileSync(mcworldPath, buffer)
  log(`Realm descargado: ${(bytes / 1024 / 1024).toFixed(2)} MB | hash: ${realmHash.slice(0, 12)}`)

  buffer = null
  compactMemory()

  const mapExists = fs.existsSync(path.join(mapDir, 'index.html'))
  if (!force && mapExists && state.lastRealmHash === realmHash) {
    fs.rmSync(mcworldPath, { force: true })
    log('El Realm descargado es identico al ultimo mapa. Se omite extraccion y renderizado.')
    return { changed: false, hash: realmHash, realmName: realm.name, activeSlot: slotId }
  }

  const nextWorldDir = path.join(workDir, 'world-next')
  fs.rmSync(nextWorldDir, { recursive: true, force: true })
  fs.mkdirSync(nextWorldDir, { recursive: true })

  const zip = new AdmZip(mcworldPath)
  zip.extractAllTo(nextWorldDir, true)
  fs.rmSync(mcworldPath, { force: true })
  compactMemory()

  if (!fs.existsSync(path.join(nextWorldDir, 'level.dat')) ||
      !fs.existsSync(path.join(nextWorldDir, 'db'))) {
    throw new Error('El mundo descargado no contiene level.dat y db/.')
  }

  fs.rmSync(worldDir, { recursive: true, force: true })
  fs.renameSync(nextWorldDir, worldDir)

  return { changed: true, hash: realmHash, realmName: realm.name, activeSlot: slotId }
}

function runProcess (command, args) {
  return new Promise((resolve, reject) => {
    compactMemory()

    const childEnv = {
      ...process.env,
      // 0x10000000 = 256 MiB. Dejamos margen para Node, librerias nativas y SO.
      DOTNET_GCHeapHardLimit: unminedHeapLimit,
      DOTNET_GCConserveMemory: '9',
      COMPlus_gcServer: '0'
    }

    const useNice = process.platform === 'linux'
    const executable = useNice ? 'nice' : command
    const finalArgs = useNice ? ['-n', '15', command, ...args] : args

    const child = spawn(executable, finalArgs, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: childEnv
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      compactMemory()
      if (code === 0) return resolve()
      reject(new Error(`${command} termino con codigo ${code} / señal ${signal || 'ninguna'}`))
    })
  })
}

function injectServiceWorkerRegistration () {
  const index = path.join(mapDir, 'index.html')
  if (!fs.existsSync(index)) return

  let html = fs.readFileSync(index, 'utf8')
  if (html.includes('/sw.js')) return

  const registration = `
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
</script>
`

  if (html.includes('</body>')) {
    html = html.replace('</body>', registration + '</body>')
  } else {
    html += registration
  }

  fs.writeFileSync(index, html)
}

function applyClientRendererEnhancements () {
  const propertiesPath = path.join(mapDir, 'unmined.map.properties.js')
  const viewerPath = path.join(mapDir, 'unmined.js')

  if (fs.existsSync(propertiesPath)) {
    let properties = fs.readFileSync(propertiesPath, 'utf8')

    if (/clientExtraZoom:\s*\d+/.test(properties)) {
      properties = properties.replace(
        /clientExtraZoom:\s*\d+/,
        `clientExtraZoom: ${clientExtraZoom}`
      )
    } else {
      properties = properties.replace(
        'var UnminedMapProperties = {',
        `var UnminedMapProperties = {\n    clientExtraZoom: ${clientExtraZoom},`
      )
    }

    fs.writeFileSync(propertiesPath, properties)
  }

  if (!fs.existsSync(viewerPath)) return

  let viewer = fs.readFileSync(viewerPath, 'utf8')

  if (!viewer.includes('/* OCAYORK_CLIENT_OVERZOOM */')) {
    viewer = viewer.replace(
      'const dpiScale = window.devicePixelRatio ?? 1.0;',
      `const dpiScale = window.devicePixelRatio ?? 1.0;
        /* OCAYORK_CLIENT_OVERZOOM */
        const clientExtraZoom = Math.max(0, this.#options.clientExtraZoom ?? 0);
        const deviceMemory = navigator.deviceMemory ?? 4;
        const clientTileCacheSize = deviceMemory >= 8 ? 1536 : (deviceMemory >= 4 ? 896 : 384);
        const clientPreload = deviceMemory >= 8 ? 3 : (deviceMemory >= 4 ? 2 : 1);`
    )

    viewer = viewer.replace(
      'var tileGrid = new ol.tilegrid.TileGrid({',
      `const viewResolutions = resolutions.slice();
        if (clientExtraZoom > 0 && resolutions.length > 0) {
            const finestResolution = resolutions[resolutions.length - 1];
            for (let i = 1; i <= clientExtraZoom; i++) {
                viewResolutions.push(finestResolution / Math.pow(2, i));
            }
        }

        var tileGrid = new ol.tilegrid.TileGrid({`
    )

    viewer = viewer.replace(
      'new ol.layer.Tile({\n                source:',
      `new ol.layer.Tile({
                preload: clientPreload,
                useInterimTilesOnError: true,
                updateWhileAnimating: true,
                updateWhileInteracting: true,
                source:`
    )

    viewer = viewer.replace(
      'tilePixelRatio: dpiScale,\n                    tileSize:',
      `tilePixelRatio: dpiScale,
                    interpolate: false,
                    tileSize:`
    )

    viewer = viewer.replace(
      'resolutions: tileGrid.getResolutions(),\n                maxZoom: mapZoomLevels,',
      `resolutions: viewResolutions,
                maxZoom: mapZoomLevels + clientExtraZoom,`
    )

    viewer = viewer.replace(
      'constrainResolution: true,',
      'constrainResolution: false,'
    )

    fs.writeFileSync(viewerPath, viewer)
  }

  const cssPath = path.join(mapDir, 'index.css')
  if (fs.existsSync(cssPath)) {
    let css = fs.readFileSync(cssPath, 'utf8')
    if (!css.includes('OCAYORK_CLIENT_RENDERING')) {
      css += `

/* OCAYORK_CLIENT_RENDERING
   El navegador hace el overzoom y usa aceleracion grafica/canvas local.
   No se generan tiles adicionales en Render para estos niveles extra. */
#map { touch-action: none; }
.ol-viewport {
  backface-visibility: hidden;
}
`
      fs.writeFileSync(cssPath, css)
    }
  }

  log(`Render cliente habilitado: +${clientExtraZoom} niveles de overzoom sin tiles extra del servidor.`)
}

async function renderMap () {
  if (!fs.existsSync(unminedCli)) {
    throw new Error(`No se encontro uNmINeD CLI en ${unminedCli}`)
  }

  fs.mkdirSync(mapDir, { recursive: true })

  const args = [
    'web',
    'render',
    `--world=${worldDir}`,
    `--output=${mapDir}`,
    '--imageformat=webp',
    '--webp-format=lossy',
    '--webp-quality=90',
    '--webp-method=3',
    `--chunkprocessors=${chunkProcessors}`,
    `--zoomin=${zoomIn}`,
    `--zoomout=${zoomOut}`
  ]

  log(`Generando mapa: zoom-in ${zoomIn}, zoom-out ${zoomOut}, chunkprocessors ${chunkProcessors}`)
  await runProcess(unminedCli, args)

  const unminedIndex = path.join(mapDir, 'unmined.index.html')
  const index = path.join(mapDir, 'index.html')

  if (fs.existsSync(unminedIndex)) {
    fs.copyFileSync(unminedIndex, index)
  }

  if (!fs.existsSync(index)) {
    throw new Error('uNmINeD no genero index.html/unmined.index.html.')
  }

  for (const file of ['custom.markers.js', 'custom.pin.png']) {
    const source = path.join(repoDir, file)
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(mapDir, file))
    }
  }

  applyClientRendererEnhancements()
  injectServiceWorkerRegistration()
  state.ready = true
}

async function updateMap ({ force = false } = {}) {
  if (state.running) {
    log('Se omite la actualizacion porque la anterior aun esta ejecutandose.')
    return false
  }

  state.running = true
  state.lastStartedAt = new Date().toISOString()
  state.lastError = null
  state.lastAction = force ? 'actualizacion manual forzada' : 'actualizacion programada'

  try {
    log(`=== Iniciando ${state.lastAction} ===`)
    const result = await downloadRealm({ force })

    if (result.changed) {
      await renderMap()
      state.lastAction = 'mapa regenerado'
    } else {
      state.lastAction = 'sin cambios; render omitido'
    }

    state.lastRealmHash = result.hash
    state.lastSuccessAt = new Date().toISOString()

    saveMetadata({
      realmName: state.realmName,
      activeSlot: state.activeSlot,
      lastRealmHash: state.lastRealmHash,
      lastSuccessAt: state.lastSuccessAt
    })

    log(`=== Actualizacion correcta: ${state.lastAction} ===`)
    return true
  } catch (error) {
    state.lastError = error.stack || error.message || String(error)
    log('ERROR actualizando mapa:', error)
    return false
  } finally {
    state.lastFinishedAt = new Date().toISOString()
    state.running = false
    compactMemory()
  }
}

function statusPage () {
  const safeError = state.lastError
    ? state.lastError.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))
    : ''

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OCAYORK - Mapa del Realm</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#111827;color:#e5e7eb;margin:0;padding:40px}
main{max-width:760px;margin:auto;background:#1f2937;border-radius:18px;padding:28px}
h1{margin-top:0}.muted{color:#9ca3af}code,pre{background:#111827;border-radius:8px;padding:4px 8px}pre{overflow:auto;padding:14px}
.ok{color:#86efac}.warn{color:#fde68a}.bad{color:#fca5a5}
</style>
</head>
<body><main>
<h1>OCAYORK - mapa automatico</h1>
<p class="${state.running ? 'warn' : state.ready ? 'ok' : 'warn'}">
${state.running ? 'Actualizando el Realm ahora mismo…' : state.ready ? 'Mapa listo.' : 'Preparando el primer mapa…'}
</p>
<p>Realm: <strong>${state.realmName || realmId}</strong></p>
<p>Actualizacion: cada <strong>${updateMinutes} minutos</strong>. Zoom: +${zoomIn} / -${zoomOut}.</p>
<p class="muted">Ultima actualizacion correcta: ${state.lastSuccessAt || 'todavia ninguna'}</p>
${safeError ? `<h2 class="bad">Ultimo error</h2><pre>${safeError}</pre>` : ''}
<script>setTimeout(()=>location.reload(),15000)</script>
</main></body></html>`
}

app.disable('x-powered-by')

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.status(200).json({ ok: true, ready: state.ready, running: state.running })
})

// Keepalive: solo responde estado. Nunca descarga el Realm ni ejecuta uNmINeD.
app.get('/ping', (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.status(200).json({
    ok: true,
    service: 'ocayork-map',
    ready: state.ready,
    runningUpdate: state.running,
    uptimeSeconds: Math.round(process.uptime()),
    memory: memorySnapshot(),
    lastSuccessAt: state.lastSuccessAt,
    lastAction: state.lastAction
  })
})

app.get('/status', (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ ...state, memory: memorySnapshot() })
})

// Actualizacion pesada protegida para evitar que terceros consuman CPU/RAM.
app.all('/refresh', (req, res) => {
  if (!refreshToken) {
    return res.status(403).json({
      ok: false,
      error: 'REFRESH_TOKEN no esta configurado. /refresh esta deshabilitado.'
    })
  }

  const provided = String(req.get('x-refresh-token') || req.query.token || '')
  if (provided !== refreshToken) {
    return res.status(401).json({ ok: false, error: 'Token incorrecto.' })
  }

  if (state.running) {
    return res.status(409).json({ ok: false, error: 'Ya hay una actualizacion ejecutandose.' })
  }

  const force = String(req.query.force || '') === '1'
  updateMap({ force })
  res.status(202).json({ ok: true, accepted: true, force })
})

// Service Worker con cache limitada: evita recargar JS/CSS/tiles vistos,
// pero revalida tiles para no quedarse con un mapa viejo.
app.get('/sw.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8')
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.send(`
const CACHE = 'ocayork-map-v3';
const MAX_TILE_ENTRIES = 1200;

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILE_ENTRIES) return;
  const extra = keys.length - MAX_TILE_ENTRIES;
  await Promise.all(keys.slice(0, extra).map(key => cache.delete(key)));
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter(name => name.startsWith('ocayork-map-') && name !== CACHE)
      .map(name => caches.delete(name))
  );
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const path = url.pathname.toLowerCase();
  const isTile = path.endsWith('.webp') || path.includes('/tiles/');
  const isAsset = /\\.(js|css|png|jpg|jpeg|svg|woff2?)$/.test(path);

  if (isTile) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(async response => {
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.startsWith('image/')) {
          await cache.put(req, response.clone());
          trimCache(cache);
        }
        return response;
      }).catch(() => cached);

      return cached || network;
    })());
    return;
  }

  if (isAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const response = await fetch(req);
      if (response.ok) await cache.put(req, response.clone());
      return response;
    })());
  }
});
`)
})

app.use(express.static(mapDir, {
  index: 'index.html',
  fallthrough: true,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase()

    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate')
      return
    }

    if (ext === '.webp' || filePath.includes(`${path.sep}tiles${path.sep}`)) {
      res.setHeader(
        'Cache-Control',
        `public, max-age=${tileCacheSeconds}, stale-while-revalidate=86400`
      )
      return
    }

    if (['.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.woff', '.woff2'].includes(ext)) {
      res.setHeader(
        'Cache-Control',
        `public, max-age=${assetCacheSeconds}, stale-while-revalidate=86400`
      )
    }
  }
}))

// MISSING_MAP_ASSET_404
// Nunca devolver index.html para una URL de tile faltante: el navegador podria
// cachear HTML como si fuera una imagen y dejar cuadros blancos persistentes.
app.get(/\.(?:webp|png|jpe?g|gif|svg)$/i, (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.status(404).end()
})

app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate')
  if (fs.existsSync(path.join(mapDir, 'index.html'))) {
    return res.sendFile(path.join(mapDir, 'index.html'))
  }
  res.status(200).send(statusPage())
})

fs.mkdirSync(dataDir, { recursive: true })
restoreAuthCacheFromEnv()

app.listen(port, '0.0.0.0', () => {
  log(`Servidor web escuchando en puerto ${port}`)
  log(`Realm ID: ${realmId}`)
  log(`Actualizacion del mapa cada ${updateMinutes} minutos`)
  log(`Zoom real servidor: +${zoomIn}/-${zoomOut}; overzoom cliente adicional: +${clientExtraZoom}; chunkprocessors: ${chunkProcessors}`)
  log(`Cache: tiles ${tileCacheSeconds}s, assets ${assetCacheSeconds}s, SW max 1200 tiles`)
  log('Keepalive liviano disponible en /ping')

  setTimeout(() => updateMap(), 1000)
  setInterval(() => updateMap(), updateMinutes * 60 * 1000)
})
