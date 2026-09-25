const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { Authflow, Titles } = require('prismarine-auth')
const { RealmAPI } = require('prismarine-realms')

const automationDir = __dirname
const configPath = path.join(automationDir, 'config.json')
const cacheDir = path.join(automationDir, '.auth-cache')
const workDir = path.join(automationDir, 'work')
const worldDir = path.join(workDir, 'world')
const downloadDir = path.join(workDir, 'download')
const mcworldPath = path.join(downloadDir, 'realm.mcworld')

function createApi () {
  const authflow = new Authflow(
    'mundo-minecraft-realm-map',
    cacheDir,
    {
      flow: 'live',
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo'
    },
    (code) => {
      console.log('\n=== INICIO DE SESIÓN MICROSOFT ===')
      if (code.message) {
        console.log(code.message)
      } else {
        console.log('Abre:', code.verification_uri)
        console.log('Código:', code.user_code)
      }
      console.log('Usa la MISMA cuenta Microsoft que es propietaria o tiene acceso al Realm.\n')
    }
  )

  return RealmAPI.from(authflow, 'bedrock')
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
      if (attempt > 1) {
        console.log(`Reintento ${attempt}/${attempts}: ${label}...`)
      }
      return await operation()
    } catch (error) {
      lastError = error

      if (!isTransientNetworkError(error) || attempt === attempts) {
        throw error
      }

      const waitMs = Math.min(3000 * (2 ** (attempt - 1)), 24000)
      console.warn(
        `Fallo temporal de red en "${label}": ${error.message || error}`
      )
      console.warn(`Esperando ${Math.round(waitMs / 1000)} segundos antes de reintentar...`)
      await sleep(waitMs)
    }
  }

  throw lastError
}

async function getRealms (api) {
  const realms = await withRetry('consultar Realms', () => api.getRealms())
  return Array.isArray(realms) ? realms : []
}

async function listRealms () {
  const api = createApi()
  const realms = await getRealms(api)

  if (realms.length === 0) {
    console.log('No se encontraron Realms para esta cuenta.')
    return
  }

  console.log('\nRealms disponibles:\n')
  console.table(realms.map((realm) => ({
    id: String(realm.id),
    nombre: realm.name,
    propietario: realm.owner || '',
    estado: realm.state,
    slotActivo: realm.activeSlot,
    miembro: realm.member
  })))
}

function readConfig () {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      'Falta automation/config.json. Ejecuta primero setup.ps1 o copia config.example.json.'
    )
  }

  const rawConfig = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')
  const config = JSON.parse(rawConfig)

  if (!config.realmId) {
    throw new Error('config.json no tiene realmId.')
  }

  return config
}

async function downloadRealm () {
  const config = readConfig()
  const api = createApi()
  const realms = await getRealms(api)
  const realm = realms.find(item => String(item.id) === String(config.realmId))

  if (!realm) {
    throw new Error(
      'No se encontró el Realm configurado. Ejecuta "npm run realms" y revisa realmId.'
    )
  }

  const slotId = String(realm.activeSlot)

  console.log('\nRealm:', realm.name)
  console.log('ID:', realm.id)
  console.log('Slot activo:', slotId)
  console.log('Solicitando la copia más reciente al Realm...')

  const download = await withRetry(
    'solicitar enlace de descarga del Realm',
    () => api.getRealmWorldDownload(
      String(realm.id),
      slotId,
      'latest'
    )
  )

  const buffer = await withRetry(
    'descargar archivo del mundo',
    () => download.getBuffer()
  )

  fs.mkdirSync(downloadDir, { recursive: true })
  fs.writeFileSync(mcworldPath, buffer)

  console.log(
    'Descargado:',
    (buffer.length / 1024 / 1024).toFixed(2),
    'MB'
  )

  fs.rmSync(worldDir, { recursive: true, force: true })
  fs.mkdirSync(worldDir, { recursive: true })

  const zip = new AdmZip(buffer)
  zip.extractAllTo(worldDir, true)

  const hasLevelDat = fs.existsSync(path.join(worldDir, 'level.dat'))
  const hasDb = fs.existsSync(path.join(worldDir, 'db'))

  if (!hasLevelDat || !hasDb) {
    throw new Error(
      'La descarga terminó, pero el mundo extraído no contiene level.dat y db/.'
    )
  }

  const metadata = {
    realmId: String(realm.id),
    realmName: realm.name,
    activeSlot: realm.activeSlot,
    downloadedAt: new Date().toISOString(),
    bytes: buffer.length
  }

  fs.writeFileSync(
    path.join(workDir, 'last-download.json'),
    JSON.stringify(metadata, null, 2)
  )

  console.log('Mundo extraído en:', worldDir)
}

async function main () {
  const command = (process.argv[2] || 'list').toLowerCase()

  if (command === 'list') {
    await listRealms()
    return
  }

  if (command === 'download') {
    await downloadRealm()
    return
  }

  throw new Error('Comando desconocido. Usa "list" o "download".')
}

main().catch((error) => {
  console.error('\nERROR:', error.message)
  if (process.env.DEBUG_REALM_MAP === '1') {
    console.error(error)
  }
  process.exit(1)
})
