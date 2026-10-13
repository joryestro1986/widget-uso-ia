# Widget de uso de IA

Ventanita flotante para Windows que muestra cuánto te **queda** del límite semanal de **Codex** y de **Claude**, y opcionalmente tu saldo de **DeepSeek**.

- Aros de progreso: llenos = 100 % restante. Verde arriba de 40 %, amarillo entre 15 y 40 %, rojo abajo de 15 %.
- Debajo de cada aro: el % restante y cuánto falta para el reinicio ("5 d 9 h"). En DeepSeek, el saldo en dólares.
- Sin marco, siempre encima, casi transparente, arrastrable y recuerda su posición.
- Ícono en la bandeja: clic muestra/oculta, clic derecho → Cerrar. No aparece en la barra de tareas.
- Se actualiza cada minuto y arranca al iniciar sesión.

## Instalación

Necesitas [Node.js](https://nodejs.org) 20 o más nuevo.

```bash
git clone https://github.com/joryestro1986/widget-uso-ia.git
cd widget-uso-ia
npm install
npm start
```

Si `npm start` dice que falta Electron, corre `node node_modules/electron/install.js`.
Si aun así `node_modules/electron/dist` solo tiene la carpeta `locales` (pasa con Node 24), descomprime a mano el zip que ya se descargó:

```powershell
$zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v*-win32-x64.zip" | Select-Object -First 1
Expand-Archive $zip.FullName node_modules\electron\dist -Force
Set-Content node_modules\electron\path.txt "electron.exe" -NoNewline
```

Al abrirse por primera vez se registra para arrancar al iniciar sesión.

## De dónde salen los datos

**Codex** — sin red ni token. Lee la última línea con `rate_limits` de los archivos más recientes en `~/.codex/sessions/AAAA/MM/DD/*.jsonl` y toma la ventana semanal (`window_minutes = 10080`).

**Claude** — `GET https://api.anthropic.com/api/oauth/usage` con el token de `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`). Toma el límite `weekly_all`. Guarda la respuesta 3 minutos.
- Es un endpoint **no documentado**: puede cambiar.
- Si solo usas la app de escritorio de Claude, ese archivo no trae el token: corre una vez `claude auth login` en el CLI.
- El token dura 8 horas y solo el CLI lo renueva. Cuando está por vencer, el widget corre `claude -p "ok" --model haiku` (a lo más un intento cada 10 minutos). **Eso gasta unos pocos tokens, unas tres veces al día.**
- En macOS el token está en el Llavero, no en ese archivo: este widget no lo lee ahí.

**DeepSeek (opcional)** — copia `config.example.json` a `config.json` y pon tu API key. Usa `GET https://api.deepseek.com/user/balance`. DeepSeek no tiene límite semanal, es saldo prepagado: el aro lleno es tu última recarga (o `deepseek_recarga` si lo pones). `config.json` está en `.gitignore`.

## Privacidad

- El servidor interno solo escucha en `127.0.0.1` y nunca devuelve tokens ni llaves.
- Nada sale a internet salvo las consultas de uso a Anthropic y, si la configuras, a DeepSeek.
- El widget no escribe en el archivo de credenciales de Claude ni renueva el OAuth por su cuenta.

## Limitaciones

- Probado en Windows 11 con varios monitores de escala distinta.
- En juegos en pantalla completa *exclusiva* la ventana queda tapada; se ve con "pantalla completa en ventana".
- Gemini no está: no hay una forma oficial de consultar la cuota que queda.

Logos de [Simple Icons](https://simpleicons.org) (CC0). Las marcas pertenecen a sus dueños.

## Licencia

MIT
