# MultiChat — Guía

Chat unificado en tiempo real de **YouTube + Twitch + Kick** en una sola pantalla,
todo en el dispositivo (sin servidor, sin cuentas).

## Compilar el APK

Requisitos: Windows con Java 21 y Android SDK CLI (ya instalados por este repo en `E:\`).

```powershell
# 1) Una sola vez: instala JDK 21 + SDK (si no existen)
powershell -ExecutionPolicy Bypass -File scripts\setup-android-cli.ps1

# 2) Compilar (hace sync de www/ + gradle assembleDebug)
powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
# Sale: MultiChat.apk (en la raíz del repo) — instálalo en el móvil
```

Instalar en el móvil (con depuración USB activa o pasando el archivo):

```powershell
E:\android-sdk\platform-tools\adb.exe install -r MultiChat.apk
```

## Versión web (GitHub Pages)

Sí: la app es HTML/JS puro y todo lo que hay que retener (canales, API key,
historial de 5 min) vive en `localStorage` — no necesita servidor.

| | APK | Web (GitHub Pages) |
|---|---|---|
| Twitch sin clave | ✓ | ✓ |
| Kick sin clave | ✓ | ✓ |
| YouTube sin clave | ✓ | ✓ (scraping del chat; sin clave) |
| YouTube con API key | ✓ | ✓ |

Publicar:

1. Sube el repo: `git add -A && git commit -m "MultiChat"` y `git push` a un repo de GitHub.
2. En GitHub: **Settings → Pages → Source: GitHub Actions**.
3. Cada push a `main` despliega `www/` (workflow `.github/workflows/pages.yml`).

En la web, `localStorage` es por-dominio: la configuración de `usuario.github.io`
es independiente de la de la APK (configúrala una vez en Ajustes).

## Configurar los canales (en la app)

Abre la app → botón de ajustes (⚙) → rellena lo que quieras (puedes dejar plataformas vacías):

| Campo | Qué poner | Clave necesaria |
|---|---|---|
| Canal de Twitch | nombre del canal, ej. `canal_ejemplo` | No |
| Canal o stream de YouTube | `@canal`, nombre, URL de canal o URL del directo | No (en web: URL del directo) |
| API key de YouTube | opcional (ver abajo) | — |
| Canal de Kick | nombre del canal, ej. `canal_ejemplo` | No |

Guarda y los tres conectores arrancan solos (píldoras TW/YT/KI en verde = conectado).

### YouTube sin clave (APK)

En la APK pegas el enlace del directo (`https://www.youtube.com/watch?v=...`),
el `@handle` o el nombre del canal y la app usa el chat interno de YouTube
(misma vía que el propio reproductor web). Cero configuración.

Si pones un **canal**, busca el directo activo de ese canal automáticamente
(si el canal está en vivo pero con chat desactivado, lo dice en pantalla).

### YouTube en la web (sin clave): scraping

YouTube **no deja** que otras páginas llamen a su API de chat (403 con Origin
externo, sin CORS; probado). La web lo resuelve leyendo el **popout del chat**
(`live_chat?is_popout=1`), que devuelve el HTML con los mensajes recientes, a
través de proxies GET con CORS (r.jina.ai → allorigins → codetabs, con
rotación automática si alguno cae). Sin cuentas, sin claves, sin despliegues.

- Pega en Ajustes la **URL del directo** (`https://www.youtube.com/watch?v=...`).
- En la web con scraping no se puede resolver un `@canal` (eso necesita POST →
  API key o la APK); el enlace del directo sí funciona siempre.
- Cada ~4-5 s se refresca; los mensajes se deduplican por id.

### YouTube con API key (opcional)

1. [Google Cloud Console](https://console.cloud.google.com/) → proyecto nuevo
2. API y servicios → habilitar **YouTube Data API v3**
3. Credenciales → **Crear clave de API** → pegarla en la app

Ojo con la cuota: la consulta de mensajes del chat cuesta **500 unidades** y la
cuota por defecto son 10.000/día → da para ~20 consultas (unas 5 min de chat).
Para directos largos en la web usa el scraping sin clave de arriba, o pide
aumento de cuota en la consola de Google.

## Comportamiento de la pantalla

- **Pantalla encendida**: mientras usas la app se mantiene encendida
  (Wake Lock API del WebView; si tu móvil lo rechaza, vuelve a tocar la pantalla
  y se reintenta).
- **Historial de 5 minutos**: los últimos 5 min de mensajes se guardan en el
  dispositivo; si cierras y reabres la app, siguen ahí (máx. 300 mensajes).
  El chat en vivo solo recibe mensajes del directo, no permite escribir (v1: solo lectura).

## Tests

```powershell
npm test                                          # Twitch + Kick (red)
node scripts/test-youtube.mjs                     # YouTube: busca un live de prueba
node scripts/test-youtube.mjs https://www.youtube.com/watch?v=...  # un directo concreto
node scripts/test-web-scrape.mjs                   # modo web (scraping, directo concreto)
$env:YT_API_KEY='...'; node scripts/test-youtube.mjs  # modo oficial con clave
```

## Notas de desarrollo

- Frontend: `www/` (HTML/JS vanilla, sin bundler). Tras editar, `npm run apk` (o `npx cap sync android`).
- `npm run serve` → sirve la UI en el navegador: Twitch y Kick sin clave, y
  YouTube por scraping del chat (pega la URL del directo).
- Estructura: `www/adapters/{twitch,youtube,kick}.js` (conectores),
  `www/app.js` (unión), `www/store.js` (configuración + historial).
