# PLAN — MultiChat: chat unificado (YouTube + Twitch + Kick) → APK

## 0. Respuesta directa a tus preguntas

- **¿Con Python y Node alcanza para el APK?** No alcanza: hace falta **JDK + Android SDK (solo por CLI)**. No hace falta Android Studio (eso pesa ~10 GB); con las *command-line tools* + Gradle (que se descarga solo vía wrapper) se compila todo por terminal. Tamaño real: **~1–1.5 GB**, no 10 GB.
- **¿Python o Node es más viable?** **Node.** La app corre 100 % dentro de un WebView (JS), Node solo sirve de toolchain (npm/Capacitor). Python no aporta nada aquí: su ruta a APK (Kivy + Buildozer) exige Docker/Linux y baja toolchains gigantes — inviable en equipo de bajos recursos.
- **Sin servidor (todo en el dispositivo):** la APK conecta sola a las 3 plataformas. No necesitas hosting ni PC encendida.

## 1. Stack elegido

| Parte | Elección | Motivo |
|---|---|---|
| UI + lógica | HTML/JS/CSS puros (ES modules), **sin bundler** | cero build step, ideal bajos recursos |
| Empaquetado APK | **Capacitor** (`@capacitor/*`) por CLI | genera proyecto Gradle compilable por terminal |
| Compilación | `gradlew.bat assembleDebug` (wrapper descarga Gradle) | sin Android Studio |
| HTTP sin CORS | `CapacitorHttp` nativo habilitado en config | fetch a Kick/YouTube sin proxies |
| Almacenamiento | `localStorage` | config de canales, sin plugins extra |

## 2. Fuentes de chat (lectura, en tiempo real)

| Plataforma | Método | Credencial |
|---|---|---|
| **Twitch** | WebSocket `wss://irc-ws.chat.twitch.tv:443`, anon `justinfan####`, parseo PRIVMSG | ninguna |
| **YouTube** | **Híbrido**: sin API key → polling InnerTube no oficial (key web pública de YouTube, cero configuración); con API key en Ajustes → Data API v3 `liveChatMessages.list` (oficial, 1 unidad/llamada, 10.000/día ≈ +13 h de stream) | opcional |
| **Kick** | Bootstrap HTTP (`kick.com/api/v2/channels/{slug}` + token `parrott`) → WebSocket chat (`chat_v2`, protocolo Phoenix) | ninguna |

- Adapter Kick propio (~150 líneas), protocolo verificado contra la fuente MIT `@retconned/kick-js` (npm, actualizado 2026) — esa lib usa `ws`/`axios` (solo Node), así que replicamos con `WebSocket` + `CapacitorHttp` nativos.
- **Versión web (GitHub Pages)**: mismo código en navegador — Twitch y Kick sin clave, YouTube solo con API key (InnerTube devuelve 403 con Origin externo; verificado). Config e historial en `localStorage` (por dominio), deploy con `.github/workflows/pages.yml`.
- **YouTube sin API key = modo por defecto** (polling InnerTube no oficial, cero configuración: se pega el enlace o `@canal` y funciona); con API key en Ajustes pasa al endpoint oficial.
- Arquitectura de adapters con interfaz única `connect() / disconnect() / onMessage(cb) / send()` (el `send` queda como stub para la fase futura de envío).

## 3. Estructura del proyecto

```
C:\apps\multichat\
├── PLAN.md
├── package.json
├── capacitor.config.json
├── www/                    # la app web (lo que va dentro del APK)
│   ├── index.html          # pantalla config + chat unificado
│   ├── style.css           # tema oscuro, badges por plataforma
│   ├── app.js              # orquestador, autoscrol, límite 500 msgs
│   ├── store.js            # localStorage (canales, API key, historial 5 min)
│   └── adapters/
│       ├── base.js         # interfaz común + reconexión con backoff
│       ├── twitch.js       # IRC over WS
│       ├── youtube.js      # híbrido: InnerTube (sin clave) / liveChatMessages (clave)
│       └── kick.js         # bootstrap HTTP + WS chat
├── android/                # generado por `npx cap add android`
├── scripts/
│   ├── setup-android-cli.ps1   # descarga cmdline-tools, sdkmanager, env vars
│   └── build-apk.ps1           # cap sync + gradlew assembleDebug + copia APK
└── docs/SETUP.md           # guía de instalación + cómo conseguir la API key
```

## 4. Instalación CLI (una sola vez) — todo por terminal

⚠️ **Disco:** C: solo tiene **2.9 GB libres** → SDK de Android y caché de Gradle van a **E: (43 GB libres)**.

1. **JDK 17** (≈190 MB): `winget install EclipseAdoptium.Temurin.17.JDK` (o zip portable).
2. **Android cmdline-tools** (~130 MB) → `E:\android-sdk\cmdline-tools\latest`.
3. `sdkmanager.bat --sdk_root=E:\android-sdk "platform-tools" "platforms;android-35" "build-tools;35.0.0"` + aceptar licencias (~400 MB).
4. Variables de usuario: `JAVA_HOME`, `ANDROID_HOME=E:\android-sdk`, `GRADLE_USER_HOME=E:\gradle` (para que la caché no llene C:), PATH con `cmdline-tools\latest\bin` y `platform-tools`.
5. **Gradle**: NO se instala — el wrapper de Capacitor lo baja solo (~130 MB a E:).
6. Verificación: `java -version`, `sdkmanager --list_installed`.

## 5. Fases de construcción

### Fase 1 — App web + 3 adapters (verificable en navegador)
- UI: pantalla de ajustes (canal Twitch, canal/URL de YT + API key opcional, canal Kick) y lista de chat unificada con badge/color por plataforma (Twitch púrpura, Kick verde, YT rojo), timestamp, autoscrol, pausa al hacer scroll manual.
- Adapters con interfaz común y estado de conexión visible (conectado/reintentando/error).
- Prueba: servidor estático (`python -m http.server -d www` o `npx serve`) — Twitch y YouTube se validan en el navegador; Kick se valida en el dispositivo (CORS).

### Fase 2 — APK por CLI
- `npm i @capacitor/core @capacitor/cli @capacitor/android`
- `capacitor.config.json`: `appId: "com.multichat.app"`, `webDir: "www"`, `server.androidScheme: "https"`, `plugins.CapacitorHttp.enabled: true`
- `npx cap add android` → escribir `android/local.properties` con `sdk.dir=E:\\android-sdk`
- `cd android && .\gradlew.bat assembleDebug` → `android\app\build\outputs\apk\debug\app-debug.apk` (~3–5 MB)
- Instalar en el teléfono: `adb install app-debug.apk` (o copiar el APK y habilitar "instalar de orígenes desconocidos"). Debug firma solo, suficiente para uso personal.

### Fase 3 — Pulido
- Reconexión backoff, guardado/carga de config, estados por plataforma, APK **release** firmado 100 % CLI (`keytool` + `apksigner` de build-tools) si quieres distribuirlo.
- `docs/SETUP.md` con la guía (crear API key YouTube, instalar APK).
- Pantalla encendida (Wake Lock API) + historial de los últimos 5 min de chat persistido en `localStorage` (visibles al reabrir la app).

### Fase 4 (futuro, ya pedido "leer ahora, enviar después")
- Activar `send()` por adapter: Twitch (OAuth pass + PRIVMSG), Kick (login + evento de envío WS), YouTube (OAuth + `liveChatMessages.insert`). La interfaz queda lista desde la Fase 1.

## 6. Riesgos / notas

- **Kick es API no oficial** → puede cambiar; aislado en su adapter, fallback = mensaje "Kick no disponible" sin romper el resto.
- **YouTube**: sin clave = InnerTube no oficial (puede cambiar, aislado en su adapter); con clave = oficial (10.000 consultas/día gratis, solo lectura).
- **Espacio C:** si la build se queda sin espacio, se mueve el proyecto completo a E: (mismo flujo).
- Versiones exactas (JDK 17 vs 21, API level) se ajustan a lo que pida la plantilla Capacitor vigente al ejecutar.

## 7. Criterios de aceptación

1. `app-debug.apk` se genera solo con comandos CLI (sin abrir Android Studio nunca).
2. En el teléfono, los 3 chats aparecen unificados en tiempo real (<2 s en WS, ~5 s en YT).
3. Sin conexión: la UI muestra estados de reintento, no se congela.
4. El repo queda documentado para repetir el build desde cero.
