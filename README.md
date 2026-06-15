<h1 align="center">
  <img src="public/logo.png" alt="Msic Logo" width="96"/>
  <br/>
  Msic — Music App
</h1>

<p align="center">
  <strong>Tu reproductor de música personal, libre y sin límites.</strong>
  <br/>
  Radio inteligente · Importación de playlists · Reproducción en background
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Android-3DDC84?style=flat-square&logo=android&logoColor=white"/>
  <img src="https://img.shields.io/badge/built_with-Tauri-FFC131?style=flat-square&logo=tauri&logoColor=black"/>
  <img src="https://img.shields.io/badge/framework-Next.js-000000?style=flat-square&logo=nextdotjs"/>
  <img src="https://img.shields.io/badge/language-Kotlin-7F52FF?style=flat-square&logo=kotlin&logoColor=white"/>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"/>
</p>

<p align="center">
  <a href="https://github.com/studioengio-eng/msic-music-app/raw/main/releases/Msic%201.0.apk">
    <img src="https://img.shields.io/badge/Download_APK-Msic_1.0-4CAF50?style=for-the-badge&logo=android" alt="Download APK"/>
  </a>
</p>

---

## ✨ Características

- 🎵 **Radio infinita** — basada en iTunes, que siempre encuentra más música del artista que estás escuchando sin repetirse
- 🔍 **Búsqueda libre** — busca cualquier canción, álbum o artista sin restricciones
- 📋 **Importación de playlists** — importa desde Spotify (Apple Music y YouTube Music en desarrollo)
- 🔁 **Modos de repetición** — Repetir 1, Repetir todo o desactivado
- 🔀 **Shuffle** — mezcla tu cola de reproducción
- 🎨 **UI premium** — diseño oscuro con glassmorphism y animaciones fluidas
- 📱 **Background playback** — sigue sonando con la pantalla apagada o usando otras apps
- 🎧 **Notificación multimedia** — controla la reproducción desde la barra de notificaciones

---

## 🚀 Tecnologías

| Capa | Tecnología |
|------|-----------|
| Frontend | Next.js 15 + React 19 + TypeScript |
| UI | Vanilla CSS, Framer Motion, Lucide Icons |
| App shell | Tauri v2 (Rust) |
| Android nativo | Kotlin + ExoPlayer (Media3) |
| Audio | NewPipe Extractor (stream de YouTube) |
| Radio | Apple iTunes Search API |
| Importación | Spotify Embed, YouTube, Apple Music (scraping) |

---

## 🛠️ Compilación local

### Requisitos
- [Node.js 20+](https://nodejs.org)
- [Rust toolchain](https://rustup.rs)
- [Android Studio](https://developer.android.com/studio) con SDK 34+ y NDK
- [Tauri CLI v2](https://tauri.app/start/): `cargo install tauri-cli`

### Pasos

```bash
# 1. Instalar dependencias frontend
npm install

# 2. Compilar y lanzar en Android (modo debug)
npm run tauri android dev

# 3. O generar un APK
npm run tauri android build
```

---

## 📁 Estructura del proyecto

```
msic/
├── src/                        # Frontend Next.js
│   └── app/
│       ├── page.tsx            # Componente principal & lógica de radio
│       ├── playlist-import.ts  # Importador de playlists
│       └── page.module.css     # Estilos
├── src-tauri/                  # Backend Rust / Tauri
│   └── gen/android/app/src/main/java/com/msic/
│       ├── api/                # ITunesRadio, NewPipe, SearchManager
│       └── player/             # ExoPlayer, PlaybackBridge, QueueManager
└── public/                     # Assets estáticos
```

---

## 📜 Licencia

MIT © 2026 — Msic Contributors
