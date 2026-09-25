const fs = require('fs')
const path = require('path')
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
const mcworldPath = path.join(downloadDir, 'realm.mcworld')
const unminedCli = process.env.UNMINED_CLI || path.join(renderDir, '.unmined', 'unmined-cli')

const realmId = String(process.env.REALM_ID || '33911323')
const updateMinutes = Math.max(5, Number(process.env.UPDATE_INTERVAL_MINUTES || 15))
const zoomIn = Math.max(0, Number(process.env.ZOOM_IN || 3))
const zoomOut = Math.max(0, Number(process.env.ZOOM_OUT || 8))
const port = Number(process.env.PORT || 10000)

const app = express()

const state = {
  ready: false,
  running: false,
  realmId,
  realmName: null,
  activeSlot: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSuccessAt: null,
  lastError: null,
  updateMinutes,
  zoomIn,
  zoomOut
}

function log (...args) {
  console.log(new Date().toISOString(), ...args)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

async function downloadRealm () {
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

  const buffer = await withRetry(
    'descargar archivo del mundo',
    () => download.getBuffer()
  )

  fs.mkdirSync(downloadDir, { recursive: true })
  fs.writeFileSync(mcworldPath, buffer)
  log(`Realm descargado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`)

  const nextWorldDir = path.join(workDir, 'world-next')
  fs.rmSync(nextWorldDir, { recursive: true, force: true })
  fs.mkdirSync(nextWorldDir, { recursive: true })

  const zip = new AdmZip(buffer)
  zip.extractAllTo(nextWorldDir, true)

  if (!fs.existsSync(path.join(nextWorldDir, 'level.dat')) ||
      !fs.existsSync(path.join(nextWorldDir, 'db'))) {
    throw new Error('El mundo descargado no contiene level.dat y db/.')
  }

  fs.rmSync(worldDir, { recursive: true, force: true })
  fs.renameSync(nextWorldDir, worldDir)
}

function runProcess (command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve()
      reject(new Error(`${command} termino con codigo ${code} / señal ${signal || 'ninguna'}`))
    })
  })
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
    `--zoomin=${zoomIn}`,
    `--zoomout=${zoomOut}`
  ]

  log(`Generando mapa: zoom-in ${zoomIn}, zoom-out ${zoomOut}`)
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

  state.ready = true
}

async function updateMap () {
  if (state.running) {
    log('Se omite la actualizacion porque la anterior aun esta ejecutandose.')
    return
  }

  state.running = true
  state.lastStartedAt = new Date().toISOString()
  state.lastError = null

  try {
    log('=== Iniciando actualizacion del mapa ===')
    await downloadRealm()
    await renderMap()
    state.lastSuccessAt = new Date().toISOString()
    log('=== Mapa actualizado correctamente ===')
  } catch (error) {
    state.lastError = error.stack || error.message || String(error)
    log('ERROR actualizando mapa:', error)
  } finally {
    state.lastFinishedAt = new Date().toISOString()
    state.running = false
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
<p class="muted">Si los logs de Render muestran un codigo de Microsoft, abre microsoft.com/link y autorizalo con la cuenta que tiene acceso al Realm.</p>
<script>setTimeout(()=>location.reload(),15000)</script>
</main></body></html>`
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, ready: state.ready, running: state.running })
})

app.get('/status', (_req, res) => {
  res.json(state)
})

app.get('/refresh', (_req, res) => {
  updateMap()
  res.status(202).json({ accepted: true, running: true })
})

app.use(express.static(mapDir, { index: 'index.html', fallthrough: true }))

app.get('*', (_req, res) => {
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
  log(`Actualizacion cada ${updateMinutes} minutos`)
  log(`Zoom-in: ${zoomIn}; zoom-out: ${zoomOut}`)

  setTimeout(updateMap, 1000)
  setInterval(updateMap, updateMinutes * 60 * 1000)
})
