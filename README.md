# CipherClip — Private Encrypted Video Website Catalog

A local, privacy-first application built with **Vue 3** and **Node.js** that inspects websites for videos using a headless browser, captures a medium-sized (`480×270`) thumbnail of the largest/main playable video on the page, and stores your entire catalog encrypted with a custom master password.

---

## Starting the Application

Double-click **[start-catalog.bat](start-catalog.bat)** in Windows Explorer, or run from a terminal:

```powershell
npm start
```

This starts the private localhost server at `http://127.0.0.1:3847` and opens your browser automatically.

To run the automated end-to-end verification test suite:

```powershell
npm test
```

---

## Key Features

1. **Single-User Encrypted Vault (`AES-256-GCM` + `scrypt`)**:
   - Stored exclusively inside your Windows user profile at `%LOCALAPPDATA%\CipherClip\catalog.vault` (`C:\Users\<username>\AppData\Local\CipherClip\catalog.vault`), isolated from any other user accounts on the machine.
   - Encrypts **everything** at rest: URLs, page titles, folder structure, searchable tags, notes, and the base64 medium-sized JPEG thumbnails. Zero plaintext ever touches the disk.
   - Instant **Lock Vault** button (`Ctrl+L`) and 30-minute inactivity auto-lock wipe the decrypted state and key buffer from memory.
2. **Smart Video Detection, Dialog Stripping & Ad Exclusion**:
   - Scans the live rendered DOM for HTML5 `<video>` elements, embedded video `<iframe>` players (YouTube, Vimeo, Dailymotion, Twitch, Wistia, Loom, etc.), click-to-play player containers, and structured `VideoObject` / OpenGraph metadata.
   - **Play Button & Controls Verification**: Checks candidate players for native `controls`, play buttons (`[aria-label*="play"]`, `.vjs-big-play-button`, `.jw-display-icon-container`, `.plyr__control--overlaid`, centered play overlays, etc.), and control bars (timeline/scrubber, volume, fullscreen) to boost the main playable video player over background/ad videos.
   - **Ad Filtering**: Automatically filters out elements and ancestor containers matching ad signatures (`ad`, `ads`, `advert`, `sponsor`, `banner`, `preroll`, `vast`, `vpaid`, `ima-ad`, `outstream`, `exoclick`, `juicyads`, `trafficjunky`, etc.) and heavily penalizes muted, uncontrolled autoplay loops.
   - **Blocking Dialog & Modal Peeling**: Strips `<dialog>`, `[role="dialog"]`, `[aria-modal="true"]`, age-gates, consent/disclaimer popups, fixed/sticky overlays, and CSS `blur()` filters, and runs a 3×3 `document.elementsFromPoint(x, y)` hit-test across the player bounding box to hide any DOM element covering the video player before capturing the medium (`480×270`) thumbnail.
3. **Searchable Tags & Folder Organization**:
   - Organize entries into color-coded folders (including nested subfolders) with drag-and-drop or bulk move.
   - Associate multiple searchable tags with each entry, filter by clicking tags in the sidebar (`Match: ALL` or `Match: ANY`), or search via `#tag`, title, domain, or notes.
4. **Batch URL Processor**:
   - Paste a list of many URLs (or upload a `.txt`, `.csv`, or exported `.html` bookmarks file).
   - Processes each URL with a live progress bar and provides a complete summary of **Cataloged (Video Found)**, **Skipped (No Video)**, and **Failed** URLs.

---

## Privacy & Anti-Leak Architecture

### 1. Headless Browser Isolation (Scanning URLs & Capturing Thumbnails)
- **Personal Browser Profile Never Touched**: The headless extractor launches Chrome/Edge with a separate temporary `--user-data-dir` (`%TEMP%\cipherclip-headless-*`), so your personal Chrome/Edge `History`, `Cookies`, `Login Data`, and `Visited Links` databases are never accessed or modified.
- **Disposable Incognito Context Per URL**: Every individual URL scan creates an isolated, in-memory incognito context (`Target.createBrowserContext({ disposeOnDetach: true })`) that is destroyed immediately in the `finally` block as soon as the thumbnail is captured.
- **Zero-Cache & Zero-Crash-Dump Flags**: Headless Chrome/Edge is launched with:
  - `--incognito`
  - `--disk-cache-size=1` and `--media-cache-size=1`
  - `--disable-gpu-shader-disk-cache`
  - `--disable-breakpad`, `--disable-crash-reporter`, `--disable-domain-reliability`, `--disable-logging`, and `--no-pings`
- **Automatic Temp Directory Destruction & Startup Sweep**:
  - The headless browser process and its temporary directory are automatically destroyed **15 seconds** after scanning finishes (`idleShutdownMs = 15000`).
  - On startup, `_cleanupOrphanedTempDirs()` scans `%TEMP%` and deletes any leftover `cipherclip-headless-*` directories in case the application was previously force-closed.

### 2. Local UI Browser Protections (`http://127.0.0.1:3847`)
- **Localhost-Only Binding**: The server binds strictly to `127.0.0.1` (never `0.0.0.0`), so no other device on your local network can connect to it.
- **No External CDN Requests**: Vue 3 (`public/vendor/vue.global.prod.js`) and all styles/assets are served locally from `127.0.0.1` with `<meta name="referrer" content="no-referrer" />` and `Referrer-Policy: no-referrer`.
- **Browser History Protection**:
  - Your browser address bar only ever visits `http://127.0.0.1:3847/`. All URLs to be cataloged are transmitted in `POST` request bodies rather than URL query parameters.
  - **Private Window Launcher (`/api/open-private`)**: Clicking a cataloged website link on any card or in the entry detail modal does **not** open a standard `<a target="_blank">` tab in your normal browser (which would record the visited URL in your personal browser history). Instead, it invokes `/api/open-private`, which launches the URL in an **Incognito (`--incognito`) / InPrivate (`--inprivate`)** browser window so zero history is recorded.
- **Zero Disk Caching of Decrypted Data**: Every API response sends `Cache-Control: no-store, no-cache, must-revalidate, private` and `Pragma: no-cache`, preventing your browser from caching decrypted JSON or base64 thumbnails to disk.
- **Autofill Disabled**: All forms and inputs specify `autocomplete="off"` so pasted URLs and search queries are not saved in browser form autofill history.

### 3. Windows OS-Level DNS Cache Note
- As with any application on Windows that resolves domain names, the Windows DNS Client service temporarily caches resolved domain names in system RAM until reboot.
- It only caches domain names (never full URL paths, page titles, or thumbnails).
- If you ever wish to clear Windows' in-memory DNS cache manually after a session, you can run:
  ```powershell
  ipconfig /flushdns
  ```
