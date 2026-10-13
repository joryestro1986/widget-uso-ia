// Widget de uso semanal: servidor HTTP local (sin dependencias) + ventana flotante de Electron.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { usoCodex, usoClaude, usoDeepseek, hayDeepseek } = require('./uso')

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

const ANCHO = 140
// Hasta 2 s después de abrir, Windows puede recorrerla al aplicar la escala del monitor: no se guarda
let arrastrable = false
const ALTO = 100
let ventana = null
let bandeja = null
let saliendo = false

// ---------- servidor local ----------

function servidor() {
  return new Promise(res => {
    const s = http.createServer(async (req, resp) => {
      if (req.url === '/api/uso') {
        const [codex, claude, deepseek] = await Promise.all([Promise.resolve().then(usoCodex), usoClaude(),
          hayDeepseek() ? usoDeepseek() : null])
        resp.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        return resp.end(JSON.stringify({ codex, claude, deepseek, ahora: Date.now() }))
      }
      if (req.url === '/' || req.url === '/index.html') {
        resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return resp.end(fs.readFileSync(path.join(__dirname, 'index.html')))
      }
      resp.writeHead(404); resp.end()
    })
    s.listen(0, '127.0.0.1', () => res(s.address().port))
  })
}

// ---------- posición recordada ----------

const archivoEstado = () => path.join(app.getPath('userData'), 'posicion.json')

function posicionGuardada() {
  try {
    const { x, y, w, h } = JSON.parse(fs.readFileSync(archivoEstado(), 'utf8'))
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea
      return x >= a.x - 20 && y >= a.y - 20 && x < a.x + a.width - 40 && y < a.y + a.height - 40
    })
    if (visible) return { x, y, w: Math.max(ANCHO, Number(w) || ANCHO), h: Number(h) || ALTO }
  } catch {}
  const a = screen.getPrimaryDisplay().workArea
  return { x: a.x + a.width - ANCHO - 24, y: a.y + 24, w: ANCHO, h: ALTO }
}

function guardarPosicion() {
  if (!ventana) return
  // También el ancho: así al abrir no vuelve a crecer hacia la izquierda y no se recorre
  const { x, y, width: w, height: h } = ventana.getBounds()
  try { fs.writeFileSync(archivoEstado(), JSON.stringify({ x, y, w, h })) } catch {}
}

// ---------- ícono de la bandeja (PNG 32×32 dibujado aquí: un aro) ----------

function pngAro() {
  const n = 32
  const filas = []
  for (let y = 0; y < n; y++) {
    const f = Buffer.alloc(1 + n * 4)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5)
      const ang = (Math.atan2(x - 15.5, -(y - 15.5)) + 2 * Math.PI) % (2 * Math.PI)
      const enAro = d > 9.5 && d < 14.5
      const color = ang < Math.PI ? [0xD9, 0x77, 0x57] : [0xF2, 0xF2, 0xF2]
      const i = 1 + x * 4
      if (enAro) { f[i] = color[0]; f[i + 1] = color[1]; f[i + 2] = color[2]; f[i + 3] = 255 }
    }
    filas.push(f)
  }
  const crc = b => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return ~c >>> 0 }
  const trozo = (tipo, datos) => {
    const t = Buffer.from(tipo), l = Buffer.alloc(4), c = Buffer.alloc(4)
    l.writeUInt32BE(datos.length); c.writeUInt32BE(crc(Buffer.concat([t, datos])))
    return Buffer.concat([l, t, datos, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(Buffer.concat(filas))), trozo('IEND', Buffer.alloc(0))])
}

function alternar() {
  if (!ventana) return
  if (ventana.isVisible()) ventana.hide()
  else { ventana.showInactive(); ventana.setAlwaysOnTop(true, 'screen-saver') }
}

// ---------- arranque ----------

app.whenReady().then(async () => {
  // Arrancar al iniciar sesión (sin empaquetar hay que pasar la ruta de la app)
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname)],
  })

  const puerto = await servidor()
  const { x, y, w, h } = posicionGuardada()
  ventana = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false, focusable: true,
    maximizable: false, minimizable: false, fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  ventana.setAlwaysOnTop(true, 'screen-saver')
  ventana.setVisibleOnAllWorkspaces(true)
  ventana.loadURL(`http://127.0.0.1:${puerto}/`)
  // Al crearse en un monitor con otra escala, Windows la recorre unos pixeles: eso no es un arrastre
  ventana.once('ready-to-show', () => { ventana.showInactive(); setTimeout(() => { arrastrable = true }, 2000) })
  ventana.on('moved', () => { if (arrastrable) guardarPosicion() })
  ventana.on('close', e => { if (!saliendo) { e.preventDefault(); ventana.hide() } })

  bandeja = new Tray(nativeImage.createFromBuffer(pngAro()))
  bandeja.setToolTip('Uso semanal: Codex y Claude')
  bandeja.on('click', alternar)
  bandeja.setContextMenu(Menu.buildFromTemplate([
    { label: 'Cerrar', click: () => { saliendo = true; guardarPosicion(); app.quit() } },
  ]))
})

// La página mide su tamaño (crece a lo ancho con DeepSeek) y lo manda; la ventana se ajusta
ipcMain.on('alto', (_e, alto, ancho) => {
  const h = Math.max(40, Math.min(400, Math.ceil(Number(alto) || ALTO)))
  const w = Math.max(ANCHO, Math.min(400, Math.ceil(Number(ancho) || ANCHO)))
  if (!ventana) return
  const [w0, h0] = ventana.getSize()
  // Crece hacia la izquierda: el borde derecho se queda donde estaba (vive en la esquina derecha)
  // Tolerancia de 2 px: en monitores con escala no entera el ancho medido baila un pixel
  if (Math.abs(w0 - w) > 2 || Math.abs(h0 - h) > 2) {
    const b = ventana.getBounds()
    ventana.setBounds({ x: b.x + b.width - w, y: b.y, width: w, height: h })
    if (arrastrable) guardarPosicion()
  }
})

app.on('second-instance', () => { if (ventana) { ventana.showInactive(); ventana.setAlwaysOnTop(true, 'screen-saver') } })
app.on('window-all-closed', e => e.preventDefault())
