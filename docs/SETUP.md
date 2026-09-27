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
| YouTube sin clave | ✓ | ✗ (YouTube da 403 con Origin externo; hace falta relay o key) |
| YouTube con relay propio | ✓ (no hace falta) | ✓ (un despliegue gratis, ver abajo) |
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
| Canal o stream de YouTube | `@canal`, nombre, URL de canal o URL del directo | No en APK / relay o key en web |
| API key de YouTube | opcional (ver abajo) | — |
| Relay propio de YouTube | URL de tu worker (solo web, ver abajo) | — |
| Canal de Kick | nombre del canal, ej. `canal_ejemplo` | No |

Guarda y los tres conectores arrancan solos (píldoras TW/YT/KI en verde = conectado).

### YouTube sin clave (APK)

En la APK pegas el enlace del directo (`https://www.youtube.com/watch?v=...`),
el `@handle` o el nombre del canal y la app usa el chat interno de YouTube
(misma vía que el propio reproductor web). Cero configuración.

Si pones un **canal**, busca el directo activo de ese canal automáticamente
(si el canal está en vivo pero con chat desactivado, lo dice en pantalla).

### YouTube en la web: relay propio (recomendado, gratis y sin cuota)

El navegador llama a youtube.com desde otra página y YouTube responde
**403 sin CORS** (probado: también los proxies públicos no sirven para esto).
La solución es despliegarte tu propio relay de 40 líneas con Cloudflare
Workers (plan gratis, sin tarjeta):

```powershell
npm install -g wrangler        # una vez
wrangler login                 # cuenta gratis (GitHub)
npx wrangler deploy relay/worker.js --name multichat-relay
```

`wrangler` imprime tu URL (algo así como
`https://multichat-relay.TU-USUARIO.workers.dev`). En la app web:
**Ajustes → "Relay propio de YouTube" → pega la URL → Guardar**. Listo:
YouTube se mezcla en la lista unificada igual que en la APK.

El relay solo acepta `youtube.com`/`googleapis.com`, elimina el `Origin` que
YouTube rechaza y devuelve `Access-Control-Allow-Origin: *`. Código:
`relay/worker.js`.

### YouTube con API key (opcional)

1. [Google Cloud Console](https://console.cloud.google.com/) → proyecto nuevo
2. API y servicios → habilitar **YouTube Data API v3**
3. Credenciales → **Crear clave de API** → pegarla en la app

Ojo con la cuota: la consulta de mensajes del chat cuesta **500 unidades** y la
cuota por defecto son 10.000/día → da para ~20 consultas (unas 5 min de chat).
Para directos largos en la web usa el relay (sin cuota) o pide aumento de
cuota en la consola de Google.

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
node scripts/test-web-relay.mjs                   # modo web (relay local simulado)
$env:YT_API_KEY='...'; node scripts/test-youtube.mjs  # modo oficial con clave
```

## Notas de desarrollo

- Frontend: `www/` (HTML/JS vanilla, sin bundler). Tras editar, `npm run apk` (o `npx cap sync android`).
- `npm run serve` → sirve la UI en el navegador: Twitch y Kick funcionan tal
  cual; YouTube necesita relay propio o API key (en el APK no hace falta nada).
- Estructura: `www/adapters/{twitch,youtube,kick}.js` (conectores),
  `www/app.js` (unión), `www/store.js` (configuración + historial),
  `relay/worker.js` (relay web de YouTube).
