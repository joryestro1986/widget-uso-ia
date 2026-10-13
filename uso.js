// Lectura del uso semanal de Codex (archivos locales) y Claude (endpoint OAuth de Anthropic).
// Nunca imprime ni devuelve el token.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const HOME = os.homedir()
const SEMANA = 10080

// ---------- Codex ----------

function archivosRecientes(raiz, max) {
  const out = []
  const nums = d => { try { return fs.readdirSync(d).filter(n => /^\d+$/.test(n)).sort().reverse() } catch { return [] } }
  for (const a of nums(raiz)) for (const m of nums(path.join(raiz, a))) for (const d of nums(path.join(raiz, a, m))) {
    const dir = path.join(raiz, a, m, d)
    let fs_ = []
    try { fs_ = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')) } catch {}
    for (const f of fs_) {
      const p = path.join(dir, f)
      try { out.push({ p, t: fs.statSync(p).mtimeMs }) } catch {}
    }
    if (out.length >= max) return out.sort((x, y) => y.t - x.t).slice(0, max)
  }
  return out.sort((x, y) => y.t - x.t).slice(0, max)
}

function cola(p, bytes) {
  const fd = fs.openSync(p, 'r')
  try {
    const tam = fs.fstatSync(fd).size
    const n = Math.min(tam, bytes)
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, tam - n)
    return buf.toString('utf8')
  } finally { fs.closeSync(fd) }
}

function usoCodex() {
  const raiz = path.join(HOME, '.codex', 'sessions')
  if (!fs.existsSync(raiz)) return { ok: false, error: 'No encontré ~/.codex/sessions' }
  for (const { p } of archivosRecientes(raiz, 6)) {
    let lineas
    try { lineas = cola(p, 512 * 1024).split('\n') } catch { continue }
    for (let i = lineas.length - 1; i >= 0; i--) {
      if (!lineas[i].includes('"rate_limits"')) continue
      let rl
      try { rl = JSON.parse(lineas[i]).payload?.rate_limits } catch { continue }
      if (!rl) continue
      const sem = [rl.primary, rl.secondary].find(v => v && v.window_minutes === SEMANA)
      if (!sem) continue
      const reinicio = sem.resets_at ? sem.resets_at * 1000 : null
      const vencido = reinicio && reinicio <= Date.now()
      return { ok: true, restante: vencido ? 100 : clamp(100 - Number(sem.used_percent || 0)), reinicio: vencido ? null : reinicio }
    }
  }
  return { ok: false, error: 'Sin datos de Codex todavía' }
}

// ---------- Claude ----------

const CRED = path.join(HOME, '.claude', '.credentials.json')
const CACHE_MS = 3 * 60 * 1000
const MARGEN_VENCE_MS = 30 * 60 * 1000
const ENTRE_REFRESCOS_MS = 10 * 60 * 1000
let cache = null // { t, datos }
let ultimoRefresco = 0
let refrescando = null

function leerOauth() {
  try { return JSON.parse(fs.readFileSync(CRED, 'utf8')).claudeAiOauth || null } catch { return null }
}

// El token dura 8 h y sólo el CLI lo renueva: una llamada mínima hace que lo reescriba.
// Gasta unos pocos tokens; a lo más un intento cada 10 minutos.
function refrescarConCli() {
  if (refrescando) return refrescando
  if (Date.now() - ultimoRefresco < ENTRE_REFRESCOS_MS) return Promise.resolve(false)
  ultimoRefresco = Date.now()
  // La configuración MCP vacía va en un archivo para no pelear con las comillas de cmd.exe
  const mcp = path.join(os.tmpdir(), 'widget-uso-ia-mcp.json')
  fs.writeFileSync(mcp, '{"mcpServers":{}}')
  refrescando = new Promise(res => {
    const hijo = spawn('claude', ['-p', 'ok', '--model', 'haiku', '--strict-mcp-config', '--mcp-config', mcp],
      { shell: true, windowsHide: true, stdio: 'ignore' })
    const reloj = setTimeout(() => { try { hijo.kill() } catch {} }, 90000)
    hijo.on('error', () => { clearTimeout(reloj); res(false) })
    hijo.on('exit', c => { clearTimeout(reloj); res(c === 0) })
  }).finally(() => { refrescando = null })
  return refrescando
}

async function consultar(token) {
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) return { status: r.status }
  return { status: 200, json: await r.json() }
}

async function usoClaude() {
  if (cache && Date.now() - cache.t < CACHE_MS) return cache.datos
  let o = leerOauth()
  if (!o || !o.accessToken) {
    return { ok: false, error: 'Corre una vez: claude auth login' }
  }
  if (o.expiresAt && o.expiresAt - Date.now() < MARGEN_VENCE_MS) {
    await refrescarConCli()
    o = leerOauth() || o
  }
  let datos
  try {
    let r = await consultar(o.accessToken)
    if (r.status === 401 && await refrescarConCli()) {
      o = leerOauth() || o
      r = await consultar(o.accessToken)
    }
    if (r.status !== 200) {
      datos = { ok: false, error: r.status === 401 ? 'Token vencido: abre claude en la terminal' : 'Anthropic respondió ' + r.status }
    } else {
      const sem = (r.json.limits || []).find(l => l.kind === 'weekly_all')
      const usado = sem ? sem.percent : r.json.seven_day?.utilization
      const reinicio = sem ? sem.resets_at : r.json.seven_day?.resets_at
      datos = usado == null
        ? { ok: false, error: 'La respuesta ya no trae weekly_all' }
        : { ok: true, restante: clamp(100 - Number(usado)), reinicio: reinicio ? Date.parse(reinicio) : null }
    }
  } catch (e) {
    datos = { ok: false, error: 'Sin conexión con Anthropic' }
  }
  cache = { t: Date.now(), datos }
  return datos
}

// ---------- DeepSeek ----------
// No tiene límite semanal: es saldo prepagado. El aro lleno es la última recarga
// (el saldo más alto visto desde que subió), o "deepseek_recarga" en config.json.

const CONFIG = path.join(__dirname, 'config.json')
const ESTADO_DS = path.join(__dirname, 'estado-deepseek.json')
let cacheDs = null

function leerJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

function hayDeepseek() { return !!leerJson(CONFIG)?.deepseek_api_key }

async function usoDeepseek() {
  if (cacheDs && Date.now() - cacheDs.t < CACHE_MS) return cacheDs.datos
  const cfg = leerJson(CONFIG) || {}
  let datos
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + cfg.deepseek_api_key, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) {
      datos = { ok: false, error: r.status === 401 ? 'Llave de DeepSeek inválida' : 'DeepSeek respondió ' + r.status }
    } else {
      const j = await r.json()
      const b = (j.balance_infos || []).find(x => x.currency === 'USD') || (j.balance_infos || [])[0]
      const saldo = Number(b?.total_balance || 0)
      const est = leerJson(ESTADO_DS) || {}
      // Si el saldo sube (recarga) o es la primera vez, ese saldo pasa a ser el aro lleno
      if (!est.tope || saldo > (est.ultimo ?? 0) + 0.005) est.tope = saldo
      est.ultimo = saldo
      try { fs.writeFileSync(ESTADO_DS, JSON.stringify(est)) } catch {}
      const tope = Number(cfg.deepseek_recarga) || est.tope || saldo
      datos = { ok: true, restante: tope > 0 ? clamp(saldo / tope * 100) : 0, saldo, moneda: b?.currency || 'USD',
                disponible: j.is_available !== false }
    }
  } catch {
    datos = { ok: false, error: 'Sin conexión con DeepSeek' }
  }
  cacheDs = { t: Date.now(), datos }
  return datos
}

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))) }

module.exports = { usoCodex, usoClaude, usoDeepseek, hayDeepseek }
