// Ojo: ninguna función global de la página debe llamarse "widgetUso" (la página queda en blanco).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('widgetUso', {
  avisarAlto: (alto, ancho) => ipcRenderer.send('alto', alto, ancho),
})
