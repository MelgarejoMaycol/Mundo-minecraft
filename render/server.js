const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { pipeline } = require('stream/promises')
const AdmZip = require('adm-zip')
const unzipper = require('unzipper')
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
const updateMinutes = Math.max(60, Number(process.env.UPDATE_INTERVAL_MINUTES || 360))
const initialUpdateDelaySeconds = Math.max(1, Number(process.env.INITIAL_UPDATE_DELAY_SECONDS || 5))
const zoomIn = Math.max(0, Number(process.env.ZOOM_IN || 0))
const zoomOut = Math.max(0, Number(process.env.ZOOM_OUT || 10))
const clientExtraZoom = Math.max(0, Math.min(3, Number(process.env.CLIENT_EXTRA_ZOOM || 3)))
const chunkProcessors = Math.max(1, Number(process.env.UNMINED_CHUNK_PROCESSORS || 1))
const unminedHeapLimit = process.env.UNMINED_GC_HEAP_LIMIT || '10000000'
const webpQuality = Math.max(50, Math.min(100, Number(process.env.WEBP_QUALITY || 85)))
const webpMethod = Math.max(0, Math.min(6, Number(process.env.WEBP_METHOD || 2)))
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
  lastErrorAt: null,
  lastAction: null,
  phase: 'idle',
  renderProgressPercent: null,
  renderedTileLines: 0,
  renderStartedAt: null,
  nextUpdateAt: null,
  updateMinutes,
  zoomIn,
  zoomOut,
  clientExtraZoom,
  chunkProcessors,
  webpQuality,
  webpMethod
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

function setPhase (phase) {
  state.phase = phase
  log(`Fase: ${phase}`)
}

async function extractWorldArchive (sourcePath, destinationDir) {
  await pipeline(
    fs.createReadStream(sourcePath),
    unzipper.Extract({ path: destinationDir })
  )
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
  setPhase('consultando-realm')
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

  setPhase('descargando-realm')
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

  setPhase('extrayendo-mundo')
  await extractWorldArchive(mcworldPath, nextWorldDir)
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

function parseUnminedLine (line) {
  const progress = line.match(/\[(\d+(?:\.\d+)?)%\]/)
  if (progress) {
    state.renderProgressPercent = Math.max(0, Math.min(100, Number(progress[1])))
  }

  if (/Rendering tile\b/i.test(line)) {
    state.renderedTileLines += 1
  }
}

function pipeProcessOutput (stream, target) {
  let pending = ''

  stream.on('data', chunk => {
    target.write(chunk)
    pending += chunk.toString('utf8')

    const lines = pending.split(/\r?\n/)
    pending = lines.pop() || ''
    for (const line of lines) parseUnminedLine(line)
  })

  stream.on('end', () => {
    if (pending) parseUnminedLine(pending)
  })
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
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv
    })

    pipeProcessOutput(child.stdout, process.stdout)
    pipeProcessOutput(child.stderr, process.stderr)

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
  if (html.includes('OCAYORK_STORAGE_PERSIST_V2')) return

  const registration = `
<script>
/* OCAYORK_STORAGE_PERSIST_V2 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
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
        const isMobile = window.matchMedia?.('(pointer: coarse)')?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const deviceMemory = navigator.deviceMemory ?? (isMobile ? 2 : 4);
        const clientTileCacheSize = isMobile ? 256 : (deviceMemory >= 8 ? 1024 : 512);
        const clientPreload = isMobile ? 1 : (deviceMemory >= 8 ? 2 : 1);`
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

  if (!viewer.includes('/* OCAYORK_PERSISTENT_TILE_CACHE */')) {
    viewer = viewer.replace(
      'source: new ol.source.XYZ({',
      `source: new ol.source.XYZ({
                    /* OCAYORK_PERSISTENT_TILE_CACHE */
                    cacheSize: clientTileCacheSize,`
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
  setPhase('renderizando-mapa')
  state.renderProgressPercent = 0
  state.renderedTileLines = 0
  state.renderStartedAt = new Date().toISOString()

  const args = [
    'web',
    'render',
    `--world=${worldDir}`,
    `--output=${mapDir}`,
    '--imageformat=webp',
    '--webp-format=lossy',
    `--webp-quality=${webpQuality}`,
    `--webp-method=${webpMethod}`,
    `--chunkprocessors=${chunkProcessors}`,
    `--zoomin=${zoomIn}`,
    `--zoomout=${zoomOut}`
  ]

  log(`Generando mapa: zoom-in ${zoomIn}, zoom-out ${zoomOut}, chunkprocessors ${chunkProcessors}, WebP q${webpQuality}/m${webpMethod}`)
  await runProcess(unminedCli, args)
  state.renderProgressPercent = 100
  setPhase('finalizando-mapa')

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
  state.lastErrorAt = null
  state.renderProgressPercent = null
  state.renderedTileLines = 0
  state.renderStartedAt = null
  state.lastAction = force ? 'actualizacion manual forzada' : 'actualizacion programada'
  setPhase('iniciando')

  try {
    log(`=== Iniciando ${state.lastAction} ===`)
    const result = await downloadRealm({ force })

    if (result.changed) {
      await renderMap()
      state.lastAction = 'mapa regenerado'
    } else {
      applyClientRendererEnhancements()
      injectServiceWorkerRegistration()
      state.lastAction = 'sin cambios; render omitido; caché cliente verificada'
    }

    setPhase('idle')
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
    state.lastError = error.message || String(error)
    state.lastErrorAt = new Date().toISOString()
    setPhase('error')
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
<p>Actualizacion: cada <strong>${updateMinutes} minutos después de terminar la anterior</strong>. Zoom real: +${zoomIn} / -${zoomOut}; zoom cliente: +${clientExtraZoom}.</p>
<p>Fase: <strong>${state.phase}</strong>${state.renderProgressPercent != null ? ` · render ${state.renderProgressPercent.toFixed(2)}%` : ''}</p>
<p class="muted">Ultima actualizacion correcta: ${state.lastSuccessAt || 'todavia ninguna'}</p>
<p class="muted">Proxima comprobacion: ${state.nextUpdateAt || 'se programará al terminar la actual'}</p>
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

// Service Worker persistente: se mantiene en un unico archivo versionado del repositorio.
app.get('/sw.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8')
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.sendFile(path.join(repoDir, 'sw.js'))
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

let updateTimer = null

function scheduleNextUpdate () {
  if (updateTimer) clearTimeout(updateTimer)

  const delayMs = updateMinutes * 60 * 1000
  state.nextUpdateAt = new Date(Date.now() + delayMs).toISOString()

  updateTimer = setTimeout(async () => {
    state.nextUpdateAt = null
    await updateMap()
    scheduleNextUpdate()
  }, delayMs)
}

app.listen(port, '0.0.0.0', () => {
  log(`Servidor web escuchando en puerto ${port}`)
  log(`Realm ID: ${realmId}`)
  log(`Actualizacion secuencial: ${updateMinutes} minutos despues de terminar cada ciclo`)
  log(`Zoom real servidor: +${zoomIn}/-${zoomOut}; overzoom cliente adicional: +${clientExtraZoom}; chunkprocessors: ${chunkProcessors}`)
  log(`WebP: calidad ${webpQuality}, metodo ${webpMethod}`)
  log(`Cache: tiles ${tileCacheSeconds}s, assets ${assetCacheSeconds}s, SW persistente separado`)
  log(`DATA_DIR: ${dataDir}`)
  log('Keepalive liviano disponible en /ping')

  setTimeout(async () => {
    await updateMap()
    scheduleNextUpdate()
  }, initialUpdateDelaySeconds * 1000)
})
