const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 270;
const THUMBNAIL_QUALITY = 0.85;

/**
 * Generates a clean 480x270 SVG data URL placeholder when a URL is force-added
 * without a captured page/video screenshot.
 */
function generatePlaceholderThumbnailDataUrl(label = 'Video Page') {
  const safeLabel = String(label || 'Video Page')
    .replace(/[&<>"']/g, '')
    .slice(0, 36);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1e1b4b"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
    </defs>
    <rect width="480" height="270" fill="url(#bg)"/>
    <circle cx="240" cy="122" r="38" fill="rgba(99, 102, 241, 0.25)"/>
    <polygon points="230,106 230,138 258,122" fill="#c7d2fe"/>
    <text x="240" y="192" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="600" fill="#e2e8f0" text-anchor="middle">${safeLabel}</text>
    <text x="240" y="214" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="#94a3b8" text-anchor="middle">Manual Entry — Open to Paste Custom Thumbnail (Ctrl+V)</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * Locates a locally installed Chromium-based browser (Chrome or Edge) on Windows.
 */
function findBrowserExecutable() {
  if (
    process.env.CIPHERCLIP_BROWSER_PATH &&
    fs.existsSync(process.env.CIPHERCLIP_BROWSER_PATH)
  ) {
    return process.env.CIPHERCLIP_BROWSER_PATH;
  }

  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(
      programFiles,
      'BraveSoftware',
      'Brave-Browser',
      'Application',
      'brave.exe'
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Could not find Google Chrome or Microsoft Edge on this machine. Please set CIPHERCLIP_BROWSER_PATH.'
  );
}

/**
 * Lightweight Chrome DevTools Protocol (CDP) client using Node.js native WebSocket.
 */
class CDPConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        reject(new Error('Timed out connecting to headless browser WebSocket.'));
      }, 8000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${err.message || 'Unknown'}`));
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(
            typeof event.data === 'string'
              ? event.data
              : Buffer.from(event.data).toString('utf8')
          );
        } catch {
          return;
        }

        if (msg.id) {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
              entry.reject(
                new Error(msg.error.message || JSON.stringify(msg.error))
              );
            } else {
              entry.resolve(msg.result);
            }
          }
        } else if (msg.method) {
          const key = msg.sessionId
            ? `${msg.sessionId}:${msg.method}`
            : msg.method;
          const handlers = this.eventListeners.get(key) || [];
          for (const handler of [...handlers]) {
            try {
              handler(msg.params || {});
            } catch {
              // ignore handler errors
            }
          }
        }
      });

      ws.addEventListener('close', () => {
        for (const [, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('CDP connection closed.'));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}, sessionId = null, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open.'));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  onceEvent(method, sessionId = null, timeoutMs = 10000) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    return new Promise((resolve) => {
      let timer = null;
      const handler = (params) => {
        if (timer) clearTimeout(timer);
        const list = this.eventListeners.get(key) || [];
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
        resolve(params);
      };

      timer = setTimeout(() => {
        const list = this.eventListeners.get(key) || [];
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      if (!this.eventListeners.has(key)) {
        this.eventListeners.set(key, []);
      }
      this.eventListeners.get(key).push(handler);
    });
  }

  close() {
    try {
      if (this.ws) {
        this.ws.close();
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Normalizes a user-supplied URL string.
 */
function normalizeInputUrl(rawUrl) {
  let trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('Empty URL');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  const parsed = new URL(trimmed);
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

/**
 * Extracts known platform video IDs/thumbnails from URLs if present.
 */
function detectPlatformFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();

    // YouTube
    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtu.be' ||
      host === 'youtube-nocookie.com'
    ) {
      let videoId = null;
      if (host === 'youtu.be') {
        videoId = u.pathname.split('/').filter(Boolean)[0];
      } else if (u.pathname === '/watch') {
        videoId = u.searchParams.get('v');
      } else {
        const match = u.pathname.match(/^\/(embed|shorts|v|live)\/([^/?#]+)/);
        if (match) videoId = match[2];
      }
      if (videoId && /^[a-zA-Z0-9_-]{6,15}$/.test(videoId)) {
        return {
          provider: 'YouTube',
          videoId,
          thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          fallbackThumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        };
      }
    }

    // Vimeo
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const match = u.pathname.match(/\/(?:video\/)?(\d{5,15})/);
      if (match) {
        return {
          provider: 'Vimeo',
          videoId: match[1],
          thumbnailUrl: null,
        };
      }
    }

    // Dailymotion
    if (host === 'dailymotion.com' || host === 'dai.ly') {
      let videoId = null;
      if (host === 'dai.ly') {
        videoId = u.pathname.slice(1).split('/')[0];
      } else {
        const match = u.pathname.match(/\/(?:embed\/)?video\/([a-zA-Z0-9]+)/);
        if (match) videoId = match[1];
      }
      if (videoId) {
        return {
          provider: 'Dailymotion',
          videoId,
          thumbnailUrl: `https://www.dailymotion.com/thumbnail/video/${videoId}`,
        };
      }
    }

    // Direct video file URL
    if (/\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i.test(u.pathname)) {
      return {
        provider: host || 'Direct Video',
        isDirectFile: true,
        thumbnailUrl: null,
      };
    }
  } catch {
    // ignore URL parse error
  }
  return null;
}

/**
 * Fetches an external image URL and returns a base64 data URL if valid.
 */
async function fetchImageAsDataUrl(imageUrl, refererUrl = '') {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  if (imageUrl.startsWith('data:image/')) return imageUrl;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    if (refererUrl) {
      headers.Referer = refererUrl;
    }

    const res = await fetch(imageUrl, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = (res.headers.get('content-type') || 'image/jpeg')
      .split(';')[0]
      .trim();
    if (!contentType.startsWith('image/')) return null;

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    if (buf.length < 400) return null;

    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * In-page script evaluated inside headless Chrome to:
 * 1. Identify all video players on the page (HTML5 <video>, <iframe>, and click-to-play player containers)
 * 2. Check each candidate for interactive player controls (Play button, timeline/scrubber, volume, fullscreen)
 * 3. Detect and filter out advertisement videos (ad containers, ad networks, uncontrolled muted autoplay loops)
 * 4. Rank interactive main players first so the main playable video player always wins over ads.
 */
const IN_PAGE_DETECTION_SCRIPT = `
(() => {
  function absUrl(rel, base = document.baseURI || location.href) {
    if (!rel || typeof rel !== 'string') return null;
    const trimmed = rel.trim();
    if (!trimmed || trimmed.startsWith('blob:')) return null;
    if (trimmed.startsWith('data:image/')) return trimmed;
    try {
      return new URL(trimmed, base).toString();
    } catch {
      return null;
    }
  }

  function extractCssUrl(bgStr, base) {
    if (!bgStr || bgStr === 'none') return null;
    const match = bgStr.match(/url\\(["']?([^"')]+)["']?\\)/i);
    return match ? absUrl(match[1], base) : null;
  }

  // Ad detection regexes for element attributes/ancestors and media URLs
  const adAttrRegex = /(?:^|[\\s_-])(ad|ads|adv|advert|advertisement|sponsor|sponsored|promo|banner|preroll|midroll|postroll|outstream|vpaid|vast|ima-ad|ima_ad|ad-container|ad_container|ad-wrapper|ad-unit|ad-slot|adzone|ad-box|ad_box|adplayer|ad-player|exoclick|juicyads|trafficjunky|connatix|primis|teads|outbrain|taboola|mgid|revcontent|popunder|sticky-ad|floating-ad)(?:$|[\\s_-])/i;
  const adUrlRegex = /(doubleclick\\.net|googlesyndication\\.com|googleadservices|imasdk\\.googleapis\\.com|taboola|outbrain|amazon-adsystem|adnxs\\.com|criteo|moatads|rubiconproject|pubmatic|exoclick|tsyndicate|realsrv|juicyads|trafficjunky|connatix|primis|teads|vpaid|vast|[\\/_.-](?:ads|advert|preroll|banners|sponsor)[\\/_.-])/i;

  function isElementOrAncestorAd(el, stopAtNode = null) {
    let curr = el;
    let depth = 0;
    while (curr && curr !== document.body && curr !== document.documentElement && depth < 7) {
      if (stopAtNode && curr === stopAtNode) break;
      const tag = (curr.tagName || '').toLowerCase();
      if (tag === 'ins') return true;
      const idStr = String(curr.id || '');
      const clsStr = typeof curr.className === 'string' ? curr.className : '';
      const ariaStr = String(curr.getAttribute?.('aria-label') || '') + ' ' + String(curr.getAttribute?.('data-ad') || '');
      const combined = idStr + ' ' + clsStr + ' ' + ariaStr;
      if (adAttrRegex.test(combined)) {
        return true;
      }
      curr = curr.parentElement;
      depth++;
    }
    return false;
  }

  // Inspects a candidate player container and/or <video> for Play button and interactive player controls
  function inspectPlayerControls(containerEl, videoEl) {
    let hasNativeControls = Boolean(videoEl && (videoEl.controls || videoEl.hasAttribute?.('controls')));
    let hasPlayButton = hasNativeControls;
    let hasControlBar = hasNativeControls;
    const controlSignals = [];

    if (hasNativeControls) {
      controlSignals.push('native-controls');
    }

    const scopeEl = containerEl || videoEl;
    if (scopeEl && scopeEl.querySelectorAll) {
      // 1. Check for explicit Play buttons inside the player
      const playSelectors = [
        '[aria-label*="play" i]',
        '[title*="play" i]',
        '[data-title*="play" i]',
        '[class*="play-btn" i]',
        '[class*="play_btn" i]',
        '[class*="playbutton" i]',
        '[class*="play-button" i]',
        '[class*="play_button" i]',
        '[class*="big-play" i]',
        '[class*="btn-play" i]',
        '[class*="play-icon" i]',
        '[class*="icon-play" i]',
        '[class*="player-play" i]',
        '.vjs-big-play-button',
        '.vjs-play-control',
        '.jw-icon-playback',
        '.jw-display-icon-display',
        '.jw-display-icon-container',
        '.plyr__control--overlaid',
        '.fp-play',
        '.fp-ui',
        '.ytp-large-play-button',
        '.ytp-play-button',
        '.mejs__overlay-button',
        '.dplayer-play-icon',
        '.art-state',
        '.kt-player [class*="play" i]',
        'button[class*="play" i]',
        'div[role="button"][class*="play" i]'
      ].join(', ');

      try {
        const playNodes = scopeEl.querySelectorAll(playSelectors);
        if (playNodes.length > 0) {
          hasPlayButton = true;
          controlSignals.push('play-button');
        }
      } catch {}

      // 2. Check for player control bar / timeline scrubber / fullscreen / volume controls
      const barSelectors = [
        '[class*="control-bar" i]',
        '[class*="controlbar" i]',
        '[class*="player-controls" i]',
        '[class*="video-controls" i]',
        '.vjs-control-bar',
        '.jw-controlbar',
        '.plyr__controls',
        '.ytp-chrome-bottom',
        '.mejs__controls',
        '.fp-controls',
        '[class*="progress-bar" i]',
        '[class*="scrubber" i]',
        '[class*="timeline" i]',
        '[class*="seek-bar" i]',
        '[class*="time-rail" i]',
        '[aria-label*="fullscreen" i]',
        '[title*="fullscreen" i]',
        '[class*="fullscreen" i]',
        '[aria-label*="volume" i]',
        '[aria-label*="mute" i]'
      ].join(', ');

      try {
        const barNodes = scopeEl.querySelectorAll(barSelectors);
        if (barNodes.length > 0) {
          hasControlBar = true;
          controlSignals.push('control-bar');
        }
      } catch {}

      // 3. Also check if there is a centered button/SVG icon overlaying the middle of the player
      if (!hasPlayButton) {
        try {
          const pRect = scopeEl.getBoundingClientRect();
          if (pRect.width >= 240 && pRect.height >= 140) {
            const buttons = scopeEl.querySelectorAll('button, [role="button"], a, svg');
            for (const b of buttons) {
              const br = b.getBoundingClientRect();
              if (br.width >= 24 && br.width <= 160 && br.height >= 24 && br.height <= 160) {
                const bx = br.left + br.width / 2;
                const by = br.top + br.height / 2;
                const px = pRect.left + pRect.width / 2;
                const py = pRect.top + pRect.height / 2;
                if (Math.abs(bx - px) < pRect.width * 0.22 && Math.abs(by - py) < pRect.height * 0.22) {
                  hasPlayButton = true;
                  controlSignals.push('centered-play-overlay');
                  break;
                }
              }
            }
          }
        } catch {}
      }
    }

    return {
      hasNativeControls,
      hasPlayButton,
      hasControlBar,
      isInteractive: Boolean(hasNativeControls || hasPlayButton || hasControlBar),
      controlSignals
    };
  }

  // Helper: inspect a player container for any poster / preview image (ignoring ad images)
  function findPlayerPosterUrl(el) {
    if (!el) return null;
    const base = el.ownerDocument?.baseURI || location.href;

    if (el.poster && !adUrlRegex.test(el.poster)) return absUrl(el.poster, base);
    if (el.getAttribute && el.getAttribute('poster')) {
      const p = el.getAttribute('poster');
      if (!adUrlRegex.test(p)) return absUrl(p, base);
    }

    // Look for non-ad <video poster="...">
    if (el.querySelectorAll) {
      for (const v of el.querySelectorAll('video[poster]')) {
        if (isElementOrAncestorAd(v, el)) continue;
        const p = v.poster || v.getAttribute('poster');
        if (p && !adUrlRegex.test(p)) return absUrl(p, base);
      }
    }

    const posterAttrs = ['data-poster', 'data-thumb', 'data-thumbnail', 'data-preview', 'data-bg', 'data-lazy-poster'];
    for (const attr of posterAttrs) {
      const val = el.getAttribute?.(attr) || el.querySelector?.('[' + attr + ']')?.getAttribute(attr);
      if (val && !adUrlRegex.test(val)) return absUrl(val, base);
    }

    if (el.querySelectorAll) {
      const posterNodes = el.querySelectorAll(
        '.vjs-poster, .jw-preview, .plyr__poster, .fp-splash, .ytp-cued-thumbnail-overlay-image, [class*="poster" i], [class*="thumbnail" i], [class*="preview" i], [class*="splash" i], img'
      );
      for (const node of posterNodes) {
        if (isElementOrAncestorAd(node, el)) continue;
        if (node.tagName === 'IMG') {
          const src = node.currentSrc || node.src || node.getAttribute('data-src') || node.getAttribute('data-lazy-src');
          const r = node.getBoundingClientRect();
          if (src && !adUrlRegex.test(src) && (r.width >= 140 || node.naturalWidth >= 180)) {
            return absUrl(src, base);
          }
        }
        const style = (node.ownerDocument?.defaultView || window).getComputedStyle(node);
        const bgUrl = extractCssUrl(style.backgroundImage, base);
        if (bgUrl && !adUrlRegex.test(bgUrl)) return bgUrl;
      }
    }

    const elStyle = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
    const selfBg = extractCssUrl(elStyle.backgroundImage, base);
    if (selfBg && !adUrlRegex.test(selfBg)) return selfBg;

    return null;
  }

  function hasValidBox(el, minW = 40, minH = 40) {
    if (!el || !el.getBoundingClientRect) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= minW && r.height >= minH;
  }

  const meta = {
    title: (
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="twitter:title"]')?.content ||
      document.title ||
      ''
    ).trim(),
    ogType: (document.querySelector('meta[property="og:type"]')?.content || '').toLowerCase(),
    ogVideo: absUrl(
      document.querySelector('meta[property="og:video:secure_url"]')?.content ||
      document.querySelector('meta[property="og:video:url"]')?.content ||
      document.querySelector('meta[property="og:video"]')?.content ||
      document.querySelector('meta[name="twitter:player"]')?.content ||
      document.querySelector('meta[name="twitter:player:stream"]')?.content
    ),
    ogImage: absUrl(
      document.querySelector('meta[property="og:image:secure_url"]')?.content ||
      document.querySelector('meta[property="og:image"]')?.content ||
      document.querySelector('meta[name="twitter:image"]')?.content ||
      document.querySelector('link[rel="image_src"]')?.href
    ),
    ogVideoWidth: parseInt(document.querySelector('meta[property="og:video:width"]')?.content || '0', 10) || 0,
    ogVideoHeight: parseInt(document.querySelector('meta[property="og:video:height"]')?.content || '0', 10) || 0,
    jsonLdVideos: []
  };

  try {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    function scanJsonLd(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(scanJsonLd);
        return;
      }
      const typeVal = node['@type'];
      const types = Array.isArray(typeVal) ? typeVal : [typeVal];
      if (types.some(t => typeof t === 'string' && t.toLowerCase().includes('videoobject'))) {
        let thumb = node.thumbnailUrl || (node.thumbnail && (node.thumbnail.url || node.thumbnail.contentUrl));
        if (Array.isArray(thumb)) thumb = thumb[0];
        if (thumb && typeof thumb === 'object') thumb = thumb.url || thumb.contentUrl;
        meta.jsonLdVideos.push({
          name: node.name || node.headline || null,
          thumbnailUrl: absUrl(thumb),
          contentUrl: absUrl(node.contentUrl),
          embedUrl: absUrl(node.embedUrl),
          width: parseInt(node.width, 10) || 0,
          height: parseInt(node.height, 10) || 0,
          duration: node.duration || null,
          keywords: node.keywords || null,
          genre: node.genre || null
        });
      }
      for (const k of Object.keys(node)) {
        if (k !== '@context' && typeof node[k] === 'object') {
          scanJsonLd(node[k]);
        }
      }
    }
    for (const s of scripts) {
      try {
        scanJsonLd(JSON.parse(s.textContent));
      } catch {}
    }
  } catch {}

  for (const old of document.querySelectorAll('[data-cipherclip-candidate], [data-cipherclip-video-node]')) {
    old.removeAttribute('data-cipherclip-candidate');
    old.removeAttribute('data-cipherclip-video-node');
  }

  const candidates = [];
  const registeredContainers = new Set();
  let candidateIdx = 0;

  function registerCandidate(el, rawVideoEl, info) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let targetEl = el;
    let width = Math.round(rect.width);
    let height = Math.round(rect.height);

    if ((width < 80 || height < 60) && el.parentElement) {
      const pRect = el.parentElement.getBoundingClientRect();
      if (pRect.width >= 120 && pRect.height >= 80) {
        targetEl = el.parentElement;
        width = Math.round(pRect.width);
        height = Math.round(pRect.height);
      }
    }

    if (registeredContainers.has(targetEl)) return;
    registeredContainers.add(targetEl);

    const id = 'cc_vid_' + (++candidateIdx);
    targetEl.setAttribute('data-cipherclip-candidate', id);
    if (rawVideoEl && rawVideoEl.setAttribute) {
      rawVideoEl.setAttribute('data-cipherclip-video-node', id);
    }

    const controlsInfo = inspectPlayerControls(targetEl, rawVideoEl);
    const isAdDom = isElementOrAncestorAd(rawVideoEl || targetEl);
    const isAdUrl = Boolean(info.videoSrc && adUrlRegex.test(info.videoSrc));
    const isAd = Boolean(isAdDom || isAdUrl || info.isAd);

    // Check if this is an uncontrolled muted autoplay video (typical for banner/sidebar video ads)
    const isUncontrolledAutoplay = Boolean(
      rawVideoEl &&
      (rawVideoEl.autoplay || rawVideoEl.loop || !rawVideoEl.paused) &&
      rawVideoEl.muted &&
      !controlsInfo.isInteractive
    );

    const area = Math.max(0, width * height);
    const finalRect = targetEl.getBoundingClientRect();
    let score = area;

    // 1. Huge boost for interactive video players (Play button, native controls, or control bar)
    if (controlsInfo.isInteractive) {
      score *= 3.2;
      if (controlsInfo.hasPlayButton && controlsInfo.hasControlBar) {
        score *= 1.25;
      }
    } else if (info.type === 'iframe-embed') {
      // Known video iframe embeds (YouTube, Vimeo, etc.) render controls inside cross-origin frame
      score *= 2.4;
    }

    // 2. Boost for being inside <main>, <article>, [role="main"], or primary video stage
    if (targetEl.closest('main, article, [role="main"], #main, #content, #player, .video-player, .player-container, .main-player')) {
      score *= 1.4;
    }

    // 3. Boost for horizontal centering in upper/main viewport
    const centerX = finalRect.left + finalRect.width / 2;
    const viewportCenterDist = Math.abs(centerX - window.innerWidth / 2);
    if (viewportCenterDist < window.innerWidth * 0.28 && finalRect.top < 1400 && finalRect.top >= -100) {
      score *= 1.25;
    }

    // 4. Heavy penalty for uncontrolled muted autoplay / decorative loop videos
    if (isUncontrolledAutoplay || info.isDecorativeLoop) {
      score *= 0.08;
    }

    // 5. Extreme penalty for detected advertisement videos
    if (isAd) {
      score *= 0.01;
    }

    const detectedPoster = info.posterUrl || findPlayerPosterUrl(targetEl) || findPlayerPosterUrl(rawVideoEl);

    candidates.push({
      id,
      type: info.type || 'video',
      provider: info.provider || location.hostname.replace(/^www\\./i, ''),
      width: width || info.videoWidth || 640,
      height: height || info.videoHeight || 360,
      videoWidth: info.videoWidth || 0,
      videoHeight: info.videoHeight || 0,
      area,
      score: Math.round(score),
      posterUrl: detectedPoster,
      videoSrc: absUrl(info.videoSrc),
      durationSeconds: info.durationSeconds || null,
      isAd,
      isUncontrolledAutoplay,
      hasPlayButton: controlsInfo.hasPlayButton,
      hasControlBar: controlsInfo.hasControlBar,
      isInteractive: controlsInfo.isInteractive,
      controlSignals: controlsInfo.controlSignals,
      hasDirectVideoNode: Boolean(rawVideoEl),
      tagName: targetEl.tagName.toLowerCase(),
      top: Math.round(finalRect.top + window.scrollY),
      left: Math.round(finalRect.left + window.scrollX)
    });
  }

  // 1. Scan native <video> elements
  const videoElements = Array.from(document.querySelectorAll('video'));
  for (const v of videoElements) {
    const r = v.getBoundingClientRect();
    const sources = Array.from(v.querySelectorAll('source')).map(s => s.src || s.getAttribute('src')).filter(Boolean);
    const src = v.currentSrc || v.src || v.getAttribute('src') || sources[0] || '';
    const poster = v.poster || v.getAttribute('poster') || '';

    // Find the outer video player container (but don't snap to an ad sub-container if inside a larger player)
    const playerContainer = v.closest(
      '.html5-video-player, .video-js, .plyr--video, .plyr, .jwplayer, .flowplayer, .mejs__container, .dplayer, .artplayer-app, .kt-player, [class*="video-player" i], [class*="player-container" i], [class*="player-wrapper" i], [id*="video-player" i], [id*="player" i], [data-player]'
    );

    const hasMedia = Boolean(src || poster || v.readyState > 0 || v.videoWidth > 0 || playerContainer);
    if (!hasMedia && r.width < 120 && r.height < 80) continue;
    if (!hasValidBox(v, 40, 40) && !hasValidBox(playerContainer, 100, 60)) continue;

    // Check if this specific <video> is an in-player VAST/IMA ad inside a main player
    const isInPlayerAd = Boolean(
      playerContainer && isElementOrAncestorAd(v, playerContainer)
    );

    const isDecorativeLoop = Boolean(v.muted && v.loop && !v.controls && !poster);
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null;

    // If it's an in-player ad <video> inside a real player container, register the outer player container
    // WITHOUT binding the ad <video> node so we capture the main player/poster instead of the ad stream!
    registerCandidate(playerContainer || v, isInPlayerAd ? null : v, {
      type: 'html5-video',
      provider: location.hostname.replace(/^www\\./i, '') || 'HTML5 Video',
      videoWidth: isInPlayerAd ? 0 : (v.videoWidth || 0),
      videoHeight: isInPlayerAd ? 0 : (v.videoHeight || 0),
      posterUrl: isInPlayerAd ? null : (poster || null),
      videoSrc: isInPlayerAd ? null : (src || null),
      durationSeconds: isInPlayerAd ? null : duration,
      isDecorativeLoop,
      isAd: !playerContainer && isElementOrAncestorAd(v)
    });
  }

  // 2. Scan <iframe> video embeds
  const knownVideoIframeRegex = /(youtube(?:-nocookie)?\\.com\\/(?:embed|v|shorts)|player\\.vimeo\\.com|dailymotion\\.com\\/embed|geo\\.dailymotion\\.com\\/player|player\\.twitch\\.tv|fast\\.wistia\\.(?:net|com)|loom\\.com\\/embed|play\\.vidyard\\.com|streamable\\.com\\/(?:e|o|s)|rumble\\.com\\/embed|player\\.bilibili\\.com|tiktok\\.com\\/embed|brightcove|jwplatform\\.com|videodelivery\\.net|cloudflarestream\\.com|mediadelivery\\.net|mux\\.com|sproutvideo\\.com|vzaar\\.com|kaltura\\.com|panopto\\.com)/i;
  const genericVideoIframeRegex = /(?:[\\/?&._-](?:video|embed|player|watch|clip)[\\/?&._=-])/i;

  for (const iframe of document.querySelectorAll('iframe')) {
    if (!hasValidBox(iframe, 160, 100)) continue;
    const r = iframe.getBoundingClientRect();
    const rawSrc = iframe.src || iframe.getAttribute('data-src') || iframe.getAttribute('data-lazy-src') || '';
    if (adUrlRegex.test(rawSrc) || isElementOrAncestorAd(iframe)) continue;

    let innerVideo = null;
    let innerPoster = null;
    try {
      const idoc = iframe.contentDocument;
      if (idoc) {
        innerVideo = idoc.querySelector('video');
        innerPoster = findPlayerPosterUrl(innerVideo || idoc.body);
      }
    } catch {}

    const isKnownProvider = knownVideoIframeRegex.test(rawSrc);
    const hasVideoAllow = /autoplay|fullscreen|picture-in-picture|encrypted-media/i.test(iframe.getAttribute('allow') || '');
    const hasAllowFullscreen = iframe.hasAttribute('allowfullscreen') || iframe.hasAttribute('webkitallowfullscreen');
    const titleHint = /video|player|youtube|vimeo|embed/i.test((iframe.title || '') + ' ' + (iframe.className || '') + ' ' + (iframe.id || ''));
    const isGenericVideoUrl = genericVideoIframeRegex.test(rawSrc) && (hasVideoAllow || hasAllowFullscreen || titleHint);

    if (innerVideo || isKnownProvider || isGenericVideoUrl) {
      let provider = 'Embedded Video';
      try {
        provider = new URL(rawSrc, location.href).hostname.replace(/^www\\./i, '');
      } catch {}

      registerCandidate(iframe, innerVideo, {
        type: 'iframe-embed',
        provider,
        videoWidth: innerVideo?.videoWidth || Math.round(r.width),
        videoHeight: innerVideo?.videoHeight || Math.round(r.height),
        posterUrl: innerPoster,
        videoSrc: rawSrc || innerVideo?.currentSrc || null,
        durationSeconds: null,
        isDecorativeLoop: false
      });
    }
  }

  // 3. Scan interactive Click-to-Play / custom video player containers (where <video> is only created on click)
  const playerContainerSelectors = [
    'mux-player', 'cloudflare-stream', 'wistia-player', 'lite-youtube', 'lite-vimeo',
    '.video-js', '.jwplayer', '.plyr--video', '.flowplayer', '.kt-player', '.dplayer',
    '[id*="video-player" i]', '[id*="video_player" i]', '[id="player" i]', '[id="video" i]',
    '[class*="video-player" i]', '[class*="video_player" i]', '[class*="player-wrapper" i]',
    '[class*="player-container" i]', '[class*="video-container" i]', '[data-video-id]', '[data-player]'
  ].join(', ');

  for (const el of document.querySelectorAll(playerContainerSelectors)) {
    if (registeredContainers.has(el) || el.querySelector('[data-cipherclip-candidate]')) continue;
    if (!hasValidBox(el, 240, 135)) continue;
    if (isElementOrAncestorAd(el)) continue;

    const r = el.getBoundingClientRect();
    const controlsInfo = inspectPlayerControls(el, null);
    const poster = findPlayerPosterUrl(el);
    const innerVid = el.querySelector?.('video') || null;

    // Accept if it has a Play button/control bar, or a poster image, or is a custom web component player
    if (controlsInfo.isInteractive || poster || innerVid || /^(mux-player|cloudflare-stream|wistia-player|lite-youtube|lite-vimeo)$/i.test(el.tagName)) {
      registerCandidate(el, innerVid, {
        type: 'interactive-player',
        provider: location.hostname.replace(/^www\\./i, '') || 'Video Player',
        videoWidth: Math.round(r.width),
        videoHeight: Math.round(r.height),
        posterUrl: poster,
        videoSrc: el.getAttribute('src') || el.getAttribute('data-src') || null
      });
    }
  }

  // Filter out ad candidates if ANY non-ad candidate exists on the page
  const nonAdCandidates = candidates.filter(c => !c.isAd);
  const pool = nonAdCandidates.length > 0 ? nonAdCandidates : candidates;

  // Sort by score descending (interactive main players with play button/controls first, then largest area)
  pool.sort((a, b) => b.score - a.score || b.area - a.area);

  // ==================== TAG & CATEGORY AUTO-DISCOVERY ====================
  function discoverPageTags() {
    const discovered = [];
    const seenLower = new Set();

    // UI action labels / non-tag words to exclude
    const stopTagRegex = /^(tags?|categories|category|all\\s+tags?|all\\s+categories|more|show\\s+more|show\\s+less|less|view\\s+all|see\\s+all|load\\s+more|add\\s+tag|suggest\\s+tags?|edit\\s+tags?|edit|none|n\\/a|home|videos?|watch|share|report|download|embed|subscribe|follow|login|log\\s+in|sign\\s+in|sign\\s+up|register|reply|comments?|\\+|\\.\\.\\.|…|\\d+)$/i;

    // Matches "tag", "tags", "category", "categories" as distinct words/tokens or camelCase boundaries
    // (avoids false positives on "stage", "footage", "vintage", "advantage", "instagram", "catalog")
    const tagWordBoundaryRegex = /(?:^|[\\s_\\-:./]|(?=[A-Z]))(tags?|categories|category)(?:$|[\\s_\\-:./]|(?=[A-Z0-9]))/i;

    // Matches visible container labels like "Tags:", "Categories", "Category:", "Video Tags:"
    const labelHeadingRegex = /^(?:video\\s+|post\\s+|media\\s+|article\\s+|related\\s+)?(tags?|categories|category)\\s*:?$/i;

    // URL path patterns common to tag & category links
    const tagHrefRegex = /(?:\\/(?:tags?|categories|category|cat|c|t)\\/[^/?#]+|[?&](?:tags?|categories|category|cat)=[^&#]+)/i;

    function isInsideGlobalNavOrAd(el) {
      if (!el || !el.closest) return false;
      if (isElementOrAncestorAd(el)) return true;
      const navAncestor = el.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]');
      if (navAncestor) {
        if (!el.closest('[data-testid*="tag" i], [data-testid*="categor" i]')) {
          return true;
        }
      }
      return false;
    }

    function extractCleanAnchorTagText(a) {
      if (!a || a.tagName !== 'A') return null;
      if (a.querySelector('img, video, picture, canvas, iframe')) return null;

      const clone = a.cloneNode(true);
      for (const junk of Array.from(clone.querySelectorAll('svg, script, style'))) {
        junk.remove();
      }
      for (const child of Array.from(clone.querySelectorAll('*'))) {
        const t = (child.textContent || '').trim();
        if (/^(?:\\(?\\d[\\d,.]*[kKmM]?\\)?|\\+)$/.test(t)) {
          child.remove();
        }
      }

      let raw = (clone.textContent || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim();
      raw = raw
        .replace(/^[#•·▸►|+\\-\\s]+/, '')
        .replace(/\\s*\\(\\d[\\d,.]*[kKmM]?\\)\\s*$/, '')
        .replace(/\\s+\\d[\\d,.]*[kKmM]?$/, '')
        .replace(/\\s+/g, ' ')
        .trim();

      if (!raw || raw.length < 2 || raw.length > 36) return null;
      if (/^https?:\\/\\//i.test(raw)) return null;
      if (raw.split(/\\s+/).length > 4) return null;
      if (stopTagRegex.test(raw)) return null;

      return raw.toLowerCase();
    }

    function addTagCandidate(rawText, confidence = 1) {
      if (!rawText) return;
      const cleaned = String(rawText)
        .replace(/^[#•·\\s]+/, '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!cleaned || cleaned.length < 2 || cleaned.length > 36) return;
      if (stopTagRegex.test(cleaned)) return;
      if (cleaned.split(/\\s+/).length > 4) return;
      if (seenLower.has(cleaned)) return;
      seenLower.add(cleaned);
      discovered.push({ tag: cleaned, confidence });
    }

    function collectAnchorsFromContainer(container, baseConfidence) {
      if (!container) return;
      if (container.tagName === 'A') {
        if (!isInsideGlobalNavOrAd(container)) {
          const text = extractCleanAnchorTagText(container);
          if (text) addTagCandidate(text, baseConfidence);
        }
        return;
      }

      const anchors = container.querySelectorAll('a');
      if (anchors.length === 0) {
        const parentAnchor = container.closest?.('a');
        if (parentAnchor && !isInsideGlobalNavOrAd(parentAnchor)) {
          const text = extractCleanAnchorTagText(parentAnchor);
          if (text) addTagCandidate(text, baseConfidence);
        }
        return;
      }
      if (anchors.length > 60) return;

      for (const a of anchors) {
        if (isInsideGlobalNavOrAd(a)) continue;
        let depth = 0;
        let curr = a;
        while (curr && curr !== container && depth < 10) {
          curr = curr.parentElement;
          depth++;
        }
        if (depth > 7) continue;

        const text = extractCleanAnchorTagText(a);
        if (!text) continue;
        const href = a.getAttribute('href') || '';
        const hrefBonus = tagHrefRegex.test(href) ? 1 : 0;
        addTagCandidate(text, baseConfidence + hrefBonus);
      }
    }

    // 1. HIGHEST PRIORITY: Elements with data-testid / data-test / data-qa / data-cy containing "tag" or "categor"
    try {
      const testIdNodes = document.querySelectorAll(
        '[data-testid*="tag" i], [data-testid*="categor" i], [data-test*="tag" i], [data-test*="categor" i], [data-qa*="tag" i], [data-qa*="categor" i], [data-cy*="tag" i], [data-cy*="categor" i]'
      );
      for (const node of testIdNodes) {
        if (isInsideGlobalNavOrAd(node)) continue;
        collectAnchorsFromContainer(node, 10);
      }
    } catch {}

    // 2. HIGH PRIORITY: Explicit rel="tag" or itemprop="keywords"/"genre" anchors
    try {
      for (const a of document.querySelectorAll('a[rel~="tag" i], a[itemprop="keywords" i], a[itemprop="genre" i]')) {
        if (isInsideGlobalNavOrAd(a)) continue;
        const text = extractCleanAnchorTagText(a);
        if (text) addTagCandidate(text, 9);
      }
    } catch {}

    // 3. CONTAINER ATTRIBUTE MATCH: Elements whose class, id, aria-label, or data-* attribute
    // contains the word "tag", "tags", "category", or "categories" (case-insensitive)
    try {
      const allElements = document.querySelectorAll('div, section, ul, ol, dl, aside, p, span, article, a');
      for (const el of allElements) {
        if (isInsideGlobalNavOrAd(el)) continue;
        const idStr = String(el.id || '');
        const clsStr = typeof el.className === 'string' ? el.className : '';
        const ariaStr = String(el.getAttribute?.('aria-label') || '');
        let dataStr = '';
        if (el.attributes) {
          for (let i = 0; i < el.attributes.length; i++) {
            const attr = el.attributes[i];
            if (attr.name.startsWith('data-') || attr.name === 'itemprop') {
              dataStr += ' ' + attr.name + ' ' + attr.value;
            }
          }
        }
        const combinedAttr = idStr + ' ' + clsStr + ' ' + ariaStr + ' ' + dataStr;
        if (tagWordBoundaryRegex.test(combinedAttr)) {
          collectAnchorsFromContainer(el, 7);
        }
      }
    } catch {}

    // 4. CONTAINER VISIBLE LABEL / HEADING MATCH: Containers or headings with the word
    // "Tag", "Tags", "Category", or "Categories" (case-insensitive)
    try {
      const labelCandidates = document.querySelectorAll('span, strong, b, em, label, dt, th, h1, h2, h3, h4, h5, h6, p, div, li, section');
      for (const lbl of labelCandidates) {
        if (isInsideGlobalNavOrAd(lbl)) continue;

        let firstDirectText = '';
        for (const child of lbl.childNodes) {
          if (child.nodeType === 3 && child.textContent.trim()) {
            firstDirectText = child.textContent.trim();
            break;
          }
        }

        if (firstDirectText && firstDirectText.length <= 30 && labelHeadingRegex.test(firstDirectText)) {
          if (lbl.querySelectorAll('a').length > 0) {
            collectAnchorsFromContainer(lbl, 8);
            continue;
          }
        }

        if (lbl.querySelectorAll('a').length > 0) continue;

        const txt = (lbl.textContent || '').trim();
        if (!txt || txt.length > 30) continue;
        if (labelHeadingRegex.test(txt)) {
          if (lbl.nextElementSibling && lbl.nextElementSibling.querySelectorAll('a').length > 0) {
            collectAnchorsFromContainer(lbl.nextElementSibling, 8);
          }
          let anc = lbl.parentElement;
          for (let level = 0; level < 3 && anc && anc !== document.body; level++) {
            const anchorCount = anc.querySelectorAll('a').length;
            if (anchorCount > 0 && anchorCount <= 45) {
              collectAnchorsFromContainer(anc, 8 - level);
              break;
            }
            anc = anc.parentElement;
          }
        }
      }
    } catch {}

    // 5. STRUCTURED META FALLBACK (meta[property="video:tag"], meta[property="article:tag"], JSON-LD keywords/genre)
    try {
      for (const m of document.querySelectorAll('meta[property="video:tag" i], meta[property="article:tag" i], meta[property="book:tag" i]')) {
        if (m.content) addTagCandidate(m.content, 6);
      }
      for (const jv of meta.jsonLdVideos || []) {
        if (Array.isArray(jv.keywords)) {
          jv.keywords.forEach(k => addTagCandidate(k, 5));
        } else if (typeof jv.keywords === 'string') {
          jv.keywords.split(',').forEach(k => addTagCandidate(k, 5));
        }
        if (Array.isArray(jv.genre)) {
          jv.genre.forEach(g => addTagCandidate(g, 5));
        } else if (typeof jv.genre === 'string') {
          jv.genre.split(',').forEach(g => addTagCandidate(g, 5));
        }
      }
    } catch {}

    discovered.sort((a, b) => b.confidence - a.confidence);
    return discovered.slice(0, 20).map(d => d.tag);
  }

  const discoveredTags = discoverPageTags();

  return {
    pageTitle: meta.title || document.title || location.href,
    finalUrl: location.href,
    domain: location.hostname.replace(/^www\\./i, ''),
    meta,
    discoveredTags,
    candidates: pool
  };
})()
`;

class VideoExtractor {
  constructor() {
    this.browserPath = null;
    this.browserProc = null;
    this.cdp = null;
    this.userDataDir = null;
    this._startingPromise = null;
    this._idleTimer = null;
    this.idleShutdownMs = 15 * 1000; // Destroy headless process & temp dir 15s after scan finishes
    this._cleanupOrphanedTempDirs();
  }

  /**
   * Sweeps os.tmpdir() on startup to remove any leftover cipherclip-headless-* folders
   * in case a previous process was forcibly terminated.
   */
  _cleanupOrphanedTempDirs() {
    try {
      const tmp = os.tmpdir();
      for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('cipherclip-headless-')) {
          try {
            fs.rmSync(path.join(tmp, entry.name), { recursive: true, force: true });
          } catch {
            // ignore if locked
          }
        }
      }
    } catch {
      // ignore
    }
  }

  async _ensureBrowser() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }

    if (this.cdp && this.cdp.ws && this.cdp.ws.readyState === WebSocket.OPEN) {
      return this.cdp;
    }

    if (this._startingPromise) {
      return this._startingPromise;
    }

    this._startingPromise = (async () => {
      await this.close();
      this.browserPath = findBrowserExecutable();
      this.userDataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'cipherclip-headless-')
      );

      const args = [
        '--headless=new',
        '--incognito',
        '--disable-gpu',
        '--disable-gpu-shader-disk-cache',
        '--no-sandbox',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-extensions',
        '--disable-web-security',
        '--disable-site-isolation-trials',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-domain-reliability',
        '--disable-logging',
        '--no-pings',
        '--disk-cache-size=1',
        '--media-cache-size=1',
        '--autoplay-policy=no-user-gesture-required',
        '--hide-scrollbars',
        '--window-size=1280,800',
        `--user-data-dir=${this.userDataDir}`,
        '--remote-debugging-port=0',
        'about:blank',
      ];

      const wsUrl = await new Promise((resolve, reject) => {
        const proc = spawn(this.browserPath, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        });
        this.browserProc = proc;

        let stderrBuf = '';
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for headless browser to start.'));
        }, 10000);

        proc.stderr.on('data', (chunk) => {
          stderrBuf += chunk.toString('utf8');
          const match = stderrBuf.match(
            /DevTools listening on (ws:\/\/[^\r\n\s]+)/
          );
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        proc.on('exit', (code) => {
          clearTimeout(timer);
          if (!stderrBuf.includes('DevTools listening on')) {
            reject(
              new Error(`Headless browser exited prematurely with code ${code}`)
            );
          }
        });
      });

      const cdp = new CDPConnection(wsUrl);
      await cdp.connect();
      this.cdp = cdp;
      return cdp;
    })();

    try {
      return await this._startingPromise;
    } finally {
      this._startingPromise = null;
      this._scheduleIdleClose();
    }
  }

  _scheduleIdleClose() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this.close().catch(() => {});
    }, this.idleShutdownMs);
    if (this._idleTimer.unref) {
      this._idleTimer.unref();
    }
  }

  async close() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
    if (this.browserProc) {
      try {
        this.browserProc.kill();
      } catch {
        // ignore
      }
      this.browserProc = null;
    }
    if (this.userDataDir && fs.existsSync(this.userDataDir)) {
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup race on Windows
      }
      this.userDataDir = null;
    }
  }

  /**
   * Harvests up to 9 prominent images / video frames from the current page inside headless Chrome
   * and renders each onto a 480x270 medium JPEG canvas (Pinterest-style image picker).
   */
  async _harvestPageCandidateThumbnails(cdp, sessionId) {
    const candidates = [];

    try {
      const harvestRes = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(async () => {
            const W = ${THUMBNAIL_WIDTH};
            const H = ${THUMBNAIL_HEIGHT};
            const adRegex = /(doubleclick|googlesyndication|googleadservices|taboola|outbrain|exoclick|juicyads|trafficjunky|tsyndicate|realsrv|connatix|primis|[\\/_.-](?:ads|advert|banner|sponsor|pixel|tracker)[\\/_.-])/i;

            // Hide obvious fixed modal/cookie overlays first
            try {
              const dialogSelectors = ['dialog', '[role="dialog"]', '[aria-modal="true"]', '[class*="modal" i]', '[class*="popup" i]', '[class*="cookie" i]', '[class*="consent" i]', '[class*="age-gate" i]'];
              for (const sel of dialogSelectors) {
                for (const el of document.querySelectorAll(sel)) {
                  const st = window.getComputedStyle(el);
                  if (st.position === 'fixed' || st.position === 'sticky' || parseInt(st.zIndex || '0', 10) > 100) {
                    el.style.setProperty('display', 'none', 'important');
                  }
                }
              }
            } catch {}

            function renderToMediumDataUrl(drawable, sw, sh) {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = W;
                canvas.height = H;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#0f172a';
                ctx.fillRect(0, 0, W, H);

                const targetRatio = W / H;
                const imgRatio = sw / sh;

                ctx.save();
                ctx.filter = 'blur(16px) brightness(0.45)';
                ctx.drawImage(drawable, -20, -20, W + 40, H + 40);
                ctx.restore();

                let dw = W, dh = H, dx = 0, dy = 0;
                if (Math.abs(imgRatio - targetRatio) < 0.25) {
                  if (imgRatio > targetRatio) {
                    dh = H; dw = H * imgRatio; dx = (W - dw) / 2;
                  } else {
                    dw = W; dh = W / imgRatio; dy = (H - dh) / 2;
                  }
                } else {
                  if (imgRatio > targetRatio) {
                    dw = W; dh = W / imgRatio; dy = (H - dh) / 2;
                  } else {
                    dh = H; dw = H * imgRatio; dx = (W - dw) / 2;
                  }
                }
                ctx.drawImage(drawable, dx, dy, dw, dh);
                return canvas.toDataURL('image/jpeg', 0.84);
              } catch {
                return null;
              }
            }

            function loadExternalImg(url) {
              if (!url) return Promise.resolve(null);
              return new Promise(resolve => {
                const img = new Image();
                const timer = setTimeout(() => resolve(null), 2500);
                img.onload = () => { clearTimeout(timer); resolve(img); };
                img.onerror = () => { clearTimeout(timer); resolve(null); };
                img.src = url;
              });
            }

            const rawItems = [];
            const seenUrls = new Set();

            function addUrlCandidate(url, label, bonusScore = 1) {
              if (!url || typeof url !== 'string') return;
              try {
                const abs = new URL(url, document.baseURI || location.href).toString();
                if (seenUrls.has(abs) || adRegex.test(abs)) return;
                seenUrls.add(abs);
                rawItems.push({ type: 'url', url: abs, label, score: 300000 * bonusScore });
              } catch {}
            }

            // 1. Meta preview images (og:image, twitter:image)
            const ogImg = document.querySelector('meta[property="og:image:secure_url"]')?.content ||
                          document.querySelector('meta[property="og:image"]')?.content ||
                          document.querySelector('meta[name="twitter:image"]')?.content;
            if (ogImg) addUrlCandidate(ogImg, 'Page Preview Image (og:image)', 2.0);

            // 2. Any <video> elements or video posters
            for (const v of document.querySelectorAll('video')) {
              const r = v.getBoundingClientRect();
              if (v.poster) addUrlCandidate(v.poster, 'Video Poster', 2.2);
              if (v.readyState >= 2 && v.videoWidth >= 120 && v.videoHeight >= 80) {
                rawItems.push({
                  type: 'video-el',
                  el: v,
                  width: v.videoWidth,
                  height: v.videoHeight,
                  label: 'Video Frame (' + v.videoWidth + '×' + v.videoHeight + ')',
                  score: Math.max(r.width * r.height, v.videoWidth * v.videoHeight) * 2.5
                });
              }
            }

            // 3. All visible <img> elements on the page
            for (const img of document.querySelectorAll('img')) {
              const r = img.getBoundingClientRect();
              const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
              if (!src || adRegex.test(src)) continue;
              const w = Math.max(Math.round(r.width), img.naturalWidth || 0);
              const h = Math.max(Math.round(r.height), img.naturalHeight || 0);
              if (w < 120 || h < 80) continue;
              // Skip extreme banner aspect ratios (> 5:1)
              if (w / h > 5 || h / w > 4) continue;
              if (seenUrls.has(src)) continue;
              seenUrls.add(src);

              let score = (Math.round(r.width) || w) * (Math.round(r.height) || h);
              if (img.closest('main, article, [role="main"], #content, #main')) score *= 1.4;
              const label = (img.alt || img.title || 'Page Image').trim().slice(0, 42) || ('Image ' + w + '×' + h);

              rawItems.push({
                type: 'img-el',
                el: img,
                url: src,
                width: w,
                height: h,
                label: label + ' (' + w + '×' + h + ')',
                score
              });
            }

            // 4. Elements with large CSS background-image
            for (const el of document.querySelectorAll('div, section, a, figure, span, header')) {
              const r = el.getBoundingClientRect();
              if (r.width < 180 || r.height < 100) continue;
              const st = window.getComputedStyle(el);
              if (!st.backgroundImage || st.backgroundImage === 'none') continue;
              const m = st.backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/i);
              if (!m || !m[1]) continue;
              try {
                const abs = new URL(m[1], document.baseURI || location.href).toString();
                if (seenUrls.has(abs) || adRegex.test(abs)) continue;
                seenUrls.add(abs);
                const w = Math.round(r.width);
                const h = Math.round(r.height);
                rawItems.push({
                  type: 'url',
                  url: abs,
                  width: w,
                  height: h,
                  label: 'Background Preview (' + w + '×' + h + ')',
                  score: w * h * 1.1
                });
              } catch {}
            }

            rawItems.sort((a, b) => b.score - a.score);
            const topItems = rawItems.slice(0, 8);
            const results = [];

            for (let i = 0; i < topItems.length; i++) {
              const item = topItems[i];
              let drawable = null;
              let sw = item.width || 640;
              let sh = item.height || 360;

              if (item.type === 'video-el') {
                drawable = item.el;
              } else if (item.type === 'img-el' && item.el.complete && item.el.naturalWidth > 0) {
                drawable = item.el;
                sw = item.el.naturalWidth;
                sh = item.el.naturalHeight;
              } else if (item.url) {
                const loaded = await loadExternalImg(item.url);
                if (loaded && loaded.naturalWidth >= 100 && loaded.naturalHeight >= 70) {
                  drawable = loaded;
                  sw = loaded.naturalWidth;
                  sh = loaded.naturalHeight;
                }
              }

              if (drawable) {
                const dataUrl = renderToMediumDataUrl(drawable, sw, sh);
                if (dataUrl) {
                  results.push({
                    id: 'cand_' + (i + 1),
                    label: item.label || ('Image ' + sw + '×' + sh),
                    width: sw,
                    height: sh,
                    dataUrl
                  });
                }
              }
            }

            return results;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
        6500
      );

      if (Array.isArray(harvestRes?.result?.value)) {
        candidates.push(...harvestRes.result.value);
      }
    } catch {
      // ignore harvest error
    }

    // Also include a full Page Viewport Snapshot option
    try {
      const shot = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: 82,
          clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.375 },
        },
        sessionId,
        4000
      );
      if (shot?.data) {
        candidates.push({
          id: 'cand_viewport',
          label: 'Full Page Snapshot (1280×720)',
          width: 1280,
          height: 720,
          dataUrl: `data:image/jpeg;base64,${shot.data}`,
        });
      }
    } catch {
      // ignore screenshot error
    }

    return candidates;
  }

  /**
   * Harvests selectable candidate images from a URL on demand (Pinterest-style picker).
   */
  async harvestImagesFromUrl(rawUrl) {
    let targetUrl;
    try {
      targetUrl = normalizeInputUrl(rawUrl);
    } catch (err) {
      throw new Error(`Invalid URL: ${err.message}`);
    }

    const cdp = await this._ensureBrowser();
    let browserContextId = null;
    let targetId = null;
    let sessionId = null;

    try {
      const ctxRes = await cdp.send('Target.createBrowserContext', {
        disposeOnDetach: true,
      });
      browserContextId = ctxRes.browserContextId;

      const targetRes = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        width: 1280,
        height: 800,
        browserContextId,
      });
      targetId = targetRes.targetId;

      const attachRes = await cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      sessionId = attachRes.sessionId;

      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);

      const loadPromise = cdp.onceEvent('Page.loadEventFired', sessionId, 12000);
      await cdp.send('Page.navigate', { url: targetUrl }, sessionId, 15000);
      await loadPromise;

      await cdp.send(
        'Runtime.evaluate',
        {
          expression: `new Promise(r => {
            window.scrollTo(0, 350);
            setTimeout(() => { window.scrollTo(0, 0); setTimeout(r, 800); }, 350);
          })`,
          awaitPromise: true,
        },
        sessionId,
        5000
      );

      return await this._harvestPageCandidateThumbnails(cdp, sessionId);
    } finally {
      if (sessionId && targetId) {
        try {
          await cdp.send('Target.closeTarget', { targetId });
        } catch {}
      }
      if (browserContextId) {
        try {
          await cdp.send('Target.disposeBrowserContext', { browserContextId });
        } catch {}
      }
      this._scheduleIdleClose();
    }
  }

  /**
   * Auto-discovers tags and categories from a URL on demand.
   */
  async discoverTagsFromUrl(rawUrl) {
    let targetUrl;
    try {
      targetUrl = normalizeInputUrl(rawUrl);
    } catch (err) {
      throw new Error(`Invalid URL: ${err.message}`);
    }

    const cdp = await this._ensureBrowser();
    let browserContextId = null;
    let targetId = null;
    let sessionId = null;

    try {
      const ctxRes = await cdp.send('Target.createBrowserContext', {
        disposeOnDetach: true,
      });
      browserContextId = ctxRes.browserContextId;

      const targetRes = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        width: 1280,
        height: 800,
        browserContextId,
      });
      targetId = targetRes.targetId;

      const attachRes = await cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      sessionId = attachRes.sessionId;

      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);

      const loadPromise = cdp.onceEvent('Page.loadEventFired', sessionId, 12000);
      await cdp.send('Page.navigate', { url: targetUrl }, sessionId, 15000);
      await loadPromise;

      await cdp.send(
        'Runtime.evaluate',
        {
          expression: `new Promise(r => {
            window.scrollTo(0, 320);
            setTimeout(() => { window.scrollTo(0, 0); setTimeout(r, 700); }, 300);
          })`,
          awaitPromise: true,
        },
        sessionId,
        5000
      );

      const evalRes = await cdp.send(
        'Runtime.evaluate',
        {
          expression: IN_PAGE_DETECTION_SCRIPT,
          returnByValue: true,
        },
        sessionId,
        8000
      );

      const detection = evalRes?.result?.value;
      return Array.isArray(detection?.discoveredTags)
        ? detection.discoveredTags
        : [];
    } finally {
      if (sessionId && targetId) {
        try {
          await cdp.send('Target.closeTarget', { targetId });
        } catch {}
      }
      if (browserContextId) {
        try {
          await cdp.send('Target.disposeBrowserContext', { browserContextId });
        } catch {}
      }
      this._scheduleIdleClose();
    }
  }

  /**
   * Inspects a URL, detects the main playable video player (checking for Play button & controls
   * while filtering out advertisement videos), strips any blocking dialogs/modals/overlays,
   * and captures a medium-sized (480x270) JPEG thumbnail.
   */
  async inspectUrl(rawUrl) {
    let targetUrl;
    try {
      targetUrl = normalizeInputUrl(rawUrl);
    } catch (err) {
      return {
        found: false,
        status: 'failed',
        url: rawUrl,
        reason: `Invalid URL: ${err.message}`,
      };
    }

    const platformHint = detectPlatformFromUrl(targetUrl);
    const cdp = await this._ensureBrowser();
    let browserContextId = null;
    let targetId = null;
    let sessionId = null;

    try {
      const ctxRes = await cdp.send('Target.createBrowserContext', {
        disposeOnDetach: true,
      });
      browserContextId = ctxRes.browserContextId;

      const targetRes = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        width: 1280,
        height: 800,
        browserContextId,
      });
      targetId = targetRes.targetId;

      const attachRes = await cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      sessionId = attachRes.sessionId;

      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);

      await cdp.send(
        'Network.setUserAgentOverride',
        {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          acceptLanguage: 'en-US,en;q=0.9',
          platform: 'Win32',
        },
        sessionId
      );

      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId
      );

      const loadPromise = cdp.onceEvent('Page.loadEventFired', sessionId, 12000);
      const navRes = await cdp.send(
        'Page.navigate',
        { url: targetUrl },
        sessionId,
        15000
      );

      if (navRes.errorText && navRes.errorText !== 'net::ERR_ABORTED') {
        return {
          found: false,
          status: 'failed',
          url: targetUrl,
          reason: `Navigation error: ${navRes.errorText}`,
        };
      }

      await loadPromise;

      await cdp.send(
        'Runtime.evaluate',
        {
          expression: `new Promise(r => {
            window.scrollTo(0, 320);
            setTimeout(() => { window.scrollTo(0, 0); setTimeout(r, 900); }, 350);
          })`,
          awaitPromise: true,
        },
        sessionId,
        5000
      );

      const evalRes = await cdp.send(
        'Runtime.evaluate',
        {
          expression: IN_PAGE_DETECTION_SCRIPT,
          returnByValue: true,
        },
        sessionId,
        8000
      );

      const detection = evalRes?.result?.value;
      if (!detection) {
        return {
          found: false,
          status: 'failed',
          url: targetUrl,
          reason: 'Could not evaluate page DOM.',
        };
      }

      const candidates = Array.isArray(detection.candidates)
        ? detection.candidates
        : [];
      const jsonLdVideos = detection.meta?.jsonLdVideos || [];
      const hasMetaVideo = Boolean(
        detection.meta?.ogVideo ||
          (detection.meta?.ogType &&
            detection.meta.ogType.includes('video')) ||
          jsonLdVideos.length > 0 ||
          platformHint
      );

      if (candidates.length === 0 && !hasMetaVideo) {
        const candidateThumbnails = await this._harvestPageCandidateThumbnails(
          cdp,
          sessionId
        );
        const fallbackDomain =
          detection.domain ||
          new URL(targetUrl).hostname.replace(/^www\./i, '');
        const firstThumb =
          candidateThumbnails[0]?.dataUrl ||
          generatePlaceholderThumbnailDataUrl(fallbackDomain);

        return {
          found: false,
          status: 'skipped',
          url: targetUrl,
          finalUrl: detection.finalUrl || targetUrl,
          title: detection.pageTitle || targetUrl,
          domain: fallbackDomain,
          fallbackThumbnailDataUrl: firstThumb,
          candidateThumbnails,
          discoveredTags: Array.isArray(detection.discoveredTags)
            ? detection.discoveredTags
            : [],
          reason: 'No video found on page',
        };
      }

      const primaryJsonLd = jsonLdVideos[0] || null;
      const mainCandidate = candidates[0] || {
        id: null,
        type: platformHint ? 'platform-video' : 'meta-video',
        provider: platformHint?.provider || detection.domain || 'Web Video',
        width:
          detection.meta?.ogVideoWidth || primaryJsonLd?.width || 640,
        height:
          detection.meta?.ogVideoHeight || primaryJsonLd?.height || 360,
        posterUrl:
          platformHint?.thumbnailUrl ||
          primaryJsonLd?.thumbnailUrl ||
          detection.meta?.ogImage ||
          null,
        videoSrc:
          detection.meta?.ogVideo ||
          primaryJsonLd?.contentUrl ||
          primaryJsonLd?.embedUrl ||
          targetUrl,
        durationSeconds: null,
        isInteractive: true,
        hasPlayButton: true,
      };

      const totalVideosOnPage = Math.max(
        candidates.length,
        hasMetaVideo ? 1 : 0
      );

      const embeddedPlatformHint =
        platformHint ||
        (mainCandidate.videoSrc
          ? detectPlatformFromUrl(mainCandidate.videoSrc)
          : null);

      const candidatePosterUrls = [
        mainCandidate.posterUrl,
        embeddedPlatformHint?.thumbnailUrl,
        embeddedPlatformHint?.fallbackThumbnailUrl,
        primaryJsonLd?.thumbnailUrl,
        detection.meta?.ogImage,
      ].filter(Boolean);

      let directVideoFrameDataUrl = null;
      let elementScreenshotDataUrl = null;

      if (mainCandidate.id) {
        const prepRes = await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(async () => {
              const playerEl = document.querySelector('[data-cipherclip-candidate="${mainCandidate.id}"]');
              if (!playerEl) return null;

              let vid = document.querySelector('[data-cipherclip-video-node="${mainCandidate.id}"]');
              if (!vid) {
                if (playerEl.tagName === 'VIDEO') vid = playerEl;
                else if (playerEl.querySelector) vid = playerEl.querySelector('video');
                if (!vid && playerEl.tagName === 'IFRAME') {
                  try { vid = playerEl.contentDocument?.querySelector('video') || null; } catch {}
                }
              }

              // A. Remove page-level blur/brightness filters and scroll locks applied by modal dialogs
              const ancestorSet = new Set();
              let curr = playerEl;
              while (curr) {
                ancestorSet.add(curr);
                curr = curr.parentElement;
              }
              for (const anc of ancestorSet) {
                if (anc.style) {
                  anc.style.setProperty('filter', 'none', 'important');
                  anc.style.setProperty('-webkit-filter', 'none', 'important');
                  anc.style.setProperty('backdrop-filter', 'none', 'important');
                  if (anc === document.body || anc === document.documentElement) {
                    anc.style.setProperty('overflow', 'visible', 'important');
                  }
                }
              }

              // B. Remove all modal dialogs, popups, age-gates, AND in-player ad overlays
              const dialogAndAdSelectors = [
                'dialog',
                '[role="dialog"]',
                '[role="alertdialog"]',
                '[aria-modal="true"]',
                '[class*="modal" i]',
                '[id*="modal" i]',
                '[class*="dialog" i]',
                '[id*="dialog" i]',
                '[class*="popup" i]',
                '[id*="popup" i]',
                '[class*="overlay" i]:not([class*="player" i]):not([class*="play" i]):not([class*="poster" i]):not([class*="thumb" i])',
                '[id*="overlay" i]:not([id*="player" i])',
                '[class*="backdrop" i]',
                '[class*="age-gate" i]',
                '[id*="age-gate" i]',
                '[class*="age_verify" i]',
                '[class*="disclaimer" i]',
                '[class*="consent" i]',
                '[class*="cookie" i]',
                '[class*="interstitial" i]',
                '[class*="paywall" i]',
                '.ima-ad-container',
                '[class*="ad-container" i]',
                '[class*="ad_container" i]',
                '[class*="vast-blocker" i]',
                '[class*="preroll" i]',
                '[class*="player-ad" i]',
                '[id*="player-ad" i]'
              ];

              for (const sel of dialogAndAdSelectors) {
                try {
                  for (const node of document.querySelectorAll(sel)) {
                    if (!ancestorSet.has(node) && !node.contains(playerEl)) {
                      node.style.setProperty('display', 'none', 'important');
                      node.style.setProperty('visibility', 'hidden', 'important');
                      node.style.setProperty('opacity', '0', 'important');
                      node.style.setProperty('pointer-events', 'none', 'important');
                    }
                  }
                } catch {}
              }

              for (const node of document.querySelectorAll('body *')) {
                if (ancestorSet.has(node) || node.contains(playerEl)) continue;
                const st = window.getComputedStyle(node);
                if (st.position === 'fixed' || st.position === 'sticky' || (st.position === 'absolute' && parseInt(st.zIndex || '0', 10) >= 50 && !playerEl.contains(node))) {
                  const nr = node.getBoundingClientRect();
                  if (nr.width > 120 && nr.height > 60) {
                    node.style.setProperty('display', 'none', 'important');
                  }
                }
              }

              playerEl.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
              await new Promise(r => setTimeout(r, 150));

              // C. Hit-test peeling (document.elementsFromPoint):
              // Hide any external element sitting in front of playerEl, while keeping playerEl's own children (play button, poster, controls) intact!
              const pr = playerEl.getBoundingClientRect();
              if (pr.width >= 40 && pr.height >= 40) {
                const sampleX = [0.2, 0.5, 0.8].map(f => Math.min(window.innerWidth - 2, Math.max(2, pr.left + pr.width * f)));
                const sampleY = [0.2, 0.5, 0.8].map(f => Math.min(window.innerHeight - 2, Math.max(2, pr.top + pr.height * f)));

                for (let pass = 0; pass < 3; pass++) {
                  for (const sx of sampleX) {
                    for (const sy of sampleY) {
                      const hits = document.elementsFromPoint(sx, sy);
                      for (const hit of hits) {
                        if (hit === playerEl || playerEl.contains(hit) || ancestorSet.has(hit)) {
                          if (hit === playerEl || playerEl.contains(hit)) {
                            break;
                          }
                          continue;
                        }
                        let blocker = hit;
                        while (blocker.parentElement && blocker.parentElement !== document.body && !ancestorSet.has(blocker.parentElement) && !blocker.parentElement.contains(playerEl)) {
                          blocker = blocker.parentElement;
                        }
                        blocker.style.setProperty('display', 'none', 'important');
                      }
                    }
                  }
                }
              }

              // D. Only extract a direct <video> frame if the <video> is not an ad and we need a decoded frame
              let directVideoDataUrl = null;
              if (vid && !${Boolean(mainCandidate.posterUrl)}) {
                try {
                  vid.muted = true;
                  if (vid.readyState < 2 && vid.preload === 'none') {
                    vid.preload = 'metadata';
                    vid.load();
                  }
                  if (vid.readyState < 2) {
                    await new Promise(resolve => {
                      const done = () => resolve();
                      vid.addEventListener('loadeddata', done, { once: true });
                      setTimeout(done, 800);
                    });
                  }
                  if (vid.readyState >= 2) {
                    const targetTime = Number.isFinite(vid.duration) && vid.duration > 2
                      ? Math.min(2.5, vid.duration * 0.15)
                      : 1.0;
                    if (vid.currentTime < 0.1) {
                      vid.currentTime = targetTime;
                      await new Promise(resolve => {
                        const done = () => resolve();
                        vid.addEventListener('seeked', done, { once: true });
                        setTimeout(done, 650);
                      });
                    }
                    if (vid.videoWidth > 0 && vid.videoHeight > 0) {
                      const vc = document.createElement('canvas');
                      vc.width = ${THUMBNAIL_WIDTH};
                      vc.height = ${THUMBNAIL_HEIGHT};
                      const vctx = vc.getContext('2d');
                      vctx.drawImage(vid, 0, 0, vc.width, vc.height);
                      directVideoDataUrl = vc.toDataURL('image/jpeg', 0.9);
                    }
                  }
                } catch {}
              }

              await new Promise(r => setTimeout(r, 120));

              const r = playerEl.getBoundingClientRect();
              const x = Math.max(0, Math.round(r.left));
              const y = Math.max(0, Math.round(r.top));
              const width = Math.min(window.innerWidth - x, Math.round(r.width));
              const height = Math.min(window.innerHeight - y, Math.round(r.height));
              const clipRect = (width >= 40 && height >= 40) ? { x, y, width, height } : null;

              return { clipRect, directVideoDataUrl };
            })()`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId,
          7000
        );

        const prepVal = prepRes?.result?.value;
        if (prepVal?.directVideoDataUrl) {
          directVideoFrameDataUrl = prepVal.directVideoDataUrl;
        }

        const clipRect = prepVal?.clipRect;
        if (clipRect && clipRect.width >= 40 && clipRect.height >= 40) {
          try {
            const shot = await cdp.send(
              'Page.captureScreenshot',
              {
                format: 'jpeg',
                quality: 90,
                clip: {
                  x: clipRect.x,
                  y: clipRect.y,
                  width: clipRect.width,
                  height: clipRect.height,
                  scale: 1,
                },
              },
              sessionId,
              6000
            );
            if (shot?.data) {
              elementScreenshotDataUrl = `data:image/jpeg;base64,${shot.data}`;
            }
          } catch {
            // fallback if clip screenshot fails
          }
        }
      }

      let fetchedPosterDataUrl = null;
      for (const posterUrl of candidatePosterUrls) {
        fetchedPosterDataUrl = await fetchImageAsDataUrl(
          posterUrl,
          detection.finalUrl || targetUrl
        );
        if (fetchedPosterDataUrl) break;
      }

      // Priority order to avoid capturing pre-roll/autoplay ad streams:
      // 1. Main video player's explicit poster / preview image (posterImg)
      // 2. Isolated snapshot of the main playable video player (elemImg — shows the player + play button/poster)
      // 3. Direct decoded <video> frame buffer (directImg — fallback if player snapshot is blank/black)
      const resizeRes = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(async () => {
            const W = ${THUMBNAIL_WIDTH};
            const H = ${THUMBNAIL_HEIGHT};
            const posterSrc = ${JSON.stringify(fetchedPosterDataUrl)};
            const elemSrc = ${JSON.stringify(elementScreenshotDataUrl)};
            const directSrc = ${JSON.stringify(directVideoFrameDataUrl)};

            function loadImg(src) {
              if (!src) return Promise.resolve(null);
              return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => resolve(null);
                img.src = src;
              });
            }

            function analyzeImage(img) {
              if (!img || img.width < 16 || img.height < 16) return { valid: false, stdDev: 0, mean: 0 };
              const c = document.createElement('canvas');
              c.width = 48;
              c.height = 27;
              const ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0, 48, 27);
              const data = ctx.getImageData(0, 0, 48, 27).data;
              let sum = 0;
              let sumSq = 0;
              const n = data.length / 4;
              for (let i = 0; i < data.length; i += 4) {
                const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                sum += lum;
                sumSq += lum * lum;
              }
              const mean = sum / n;
              const variance = Math.max(0, sumSq / n - mean * mean);
              const stdDev = Math.sqrt(variance);
              const valid = stdDev > 5.5 && mean > 6 && mean < 252;
              return { valid, stdDev, mean };
            }

            const [posterImg, elemImg, directImg] = await Promise.all([
              loadImg(posterSrc),
              loadImg(elemSrc),
              loadImg(directSrc)
            ]);

            const posterStats = analyzeImage(posterImg);
            const elemStats = analyzeImage(elemImg);
            const directStats = analyzeImage(directImg);

            let chosenImg = null;
            let sourceType = 'video-player';

            if (posterImg && posterStats.valid) {
              chosenImg = posterImg;
              sourceType = 'main-player-poster';
            } else if (elemImg && elemStats.valid) {
              chosenImg = elemImg;
              sourceType = 'isolated-player-snapshot';
            } else if (directImg && directStats.valid) {
              chosenImg = directImg;
              sourceType = 'direct-video-frame';
            } else if (elemImg) {
              chosenImg = elemImg;
              sourceType = 'isolated-player-snapshot';
            } else if (posterImg) {
              chosenImg = posterImg;
              sourceType = 'main-player-poster';
            } else if (directImg) {
              chosenImg = directImg;
              sourceType = 'direct-video-frame';
            }

            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, W, H);

            if (chosenImg) {
              const iw = chosenImg.width;
              const ih = chosenImg.height;
              const targetRatio = W / H;
              const imgRatio = iw / ih;

              ctx.save();
              ctx.filter = 'blur(16px) brightness(0.45)';
              ctx.drawImage(chosenImg, -20, -20, W + 40, H + 40);
              ctx.restore();

              let dw = W;
              let dh = H;
              let dx = 0;
              let dy = 0;
              if (Math.abs(imgRatio - targetRatio) < 0.25) {
                if (imgRatio > targetRatio) {
                  dh = H;
                  dw = H * imgRatio;
                  dx = (W - dw) / 2;
                } else {
                  dw = W;
                  dh = W / imgRatio;
                  dy = (H - dh) / 2;
                }
              } else {
                if (imgRatio > targetRatio) {
                  dw = W;
                  dh = W / imgRatio;
                  dy = (H - dh) / 2;
                } else {
                  dh = H;
                  dw = H * imgRatio;
                  dx = (W - dw) / 2;
                }
              }
              ctx.drawImage(chosenImg, dx, dy, dw, dh);
            } else {
              const grad = ctx.createLinearGradient(0, 0, W, H);
              grad.addColorStop(0, '#1e1b4b');
              grad.addColorStop(1, '#0f172a');
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, W, H);
              ctx.fillStyle = 'rgba(99, 102, 241, 0.22)';
              ctx.beginPath();
              ctx.arc(W / 2, H / 2, 44, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = '#e0e7ff';
              ctx.beginPath();
              ctx.moveTo(W / 2 - 12, H / 2 - 18);
              ctx.lineTo(W / 2 - 12, H / 2 + 18);
              ctx.lineTo(W / 2 + 18, H / 2);
              ctx.closePath();
              ctx.fill();
              sourceType = 'generated-placeholder';
            }

            return {
              dataUrl: canvas.toDataURL('image/jpeg', ${THUMBNAIL_QUALITY}),
              sourceType
            };
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
        6000
      );

      const thumbResult = resizeRes?.result?.value;
      const controlsLabel = mainCandidate.hasPlayButton
        ? 'playable controls verified'
        : 'main player';
      const selectionReason =
        totalVideosOnPage > 1
          ? `Main playable video selected (1 of ${totalVideosOnPage} on page, ${mainCandidate.width}×${mainCandidate.height}, ${controlsLabel})`
          : `Main playable video (${mainCandidate.width}×${mainCandidate.height}, ${controlsLabel})`;

      const cleanTitle =
        primaryJsonLd?.name ||
        detection.pageTitle ||
        detection.domain ||
        targetUrl;

      return {
        found: true,
        status: 'added',
        url: rawUrl,
        finalUrl: detection.finalUrl || targetUrl,
        title: cleanTitle,
        domain:
          detection.domain ||
          new URL(targetUrl).hostname.replace(/^www\./i, ''),
        thumbnailDataUrl: thumbResult?.dataUrl || null,
        discoveredTags: Array.isArray(detection.discoveredTags)
          ? detection.discoveredTags
          : [],
        videoInfo: {
          type: mainCandidate.type,
          provider:
            embeddedPlatformHint?.provider ||
            mainCandidate.provider ||
            detection.domain,
          width: mainCandidate.width || 640,
          height: mainCandidate.height || 360,
          durationSeconds: mainCandidate.durationSeconds || null,
          totalVideosOnPage,
          videoSrc: mainCandidate.videoSrc || null,
          selectionReason,
          thumbnailSource: thumbResult?.sourceType || 'isolated-player-snapshot',
        },
      };
    } catch (err) {
      return {
        found: false,
        status: 'failed',
        url: targetUrl,
        reason: err.message || 'Unexpected error inspecting page',
      };
    } finally {
      if (sessionId && targetId) {
        try {
          await cdp.send('Target.closeTarget', { targetId });
        } catch {
          // ignore
        }
      }
      if (browserContextId) {
        try {
          await cdp.send('Target.disposeBrowserContext', { browserContextId });
        } catch {
          // ignore
        }
      }
      this._scheduleIdleClose();
    }
  }
}

/**
 * Manages background batch URL processing jobs with live status reporting.
 */
class BatchProcessor {
  constructor(extractor, vault) {
    this.extractor = extractor;
    this.vault = vault;
    this.jobs = new Map();
  }

  static parseUrlList(rawInput) {
    const text = String(rawInput || '').trim();
    if (!text) return [];

    const urls = [];
    const seen = new Set();

    const hrefMatches = [
      ...text.matchAll(/href=["'](https?:\/\/[^"'\s>]+)["']/gi),
    ];
    if (hrefMatches.length > 0) {
      for (const m of hrefMatches) {
        const u = m[1].trim();
        if (u && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
      return urls;
    }

    const lines = text.split(/[\r\n]+/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
      for (const token of tokens) {
        const cleaned = token.replace(/^["'<]+|["'>.;]+$/g, '');
        if (
          cleaned &&
          (/^https?:\/\//i.test(cleaned) ||
            /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(cleaned))
        ) {
          if (!seen.has(cleaned)) {
            seen.add(cleaned);
            urls.push(cleaned);
          }
        }
      }
    }
    return urls;
  }

  startBatch({ urls, folderId = null, tags = [] }) {
    const cleanUrls = Array.isArray(urls)
      ? urls.map((u) => String(u).trim()).filter(Boolean)
      : BatchProcessor.parseUrlList(urls);

    if (cleanUrls.length === 0) {
      throw new Error('No valid URLs found in the provided list.');
    }

    const jobId = `batch_${crypto.randomBytes(6).toString('hex')}`;
    const job = {
      id: jobId,
      status: 'running',
      createdAt: new Date().toISOString(),
      completedAt: null,
      folderId: folderId || null,
      tags: Array.isArray(tags) ? tags : [],
      total: cleanUrls.length,
      processed: 0,
      addedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      cancelled: false,
      items: cleanUrls.map((url, idx) => ({
        index: idx,
        url,
        status: 'queued',
        title: null,
        reason: null,
        entryId: null,
        videoSummary: null,
      })),
    };

    this.jobs.set(jobId, job);
    this._runJobLoop(job).catch(() => {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
    });

    return this.getJobSummary(jobId);
  }

  async _runJobLoop(job) {
    for (const item of job.items) {
      if (job.cancelled || !this.vault.isUnlocked()) {
        if (!this.vault.isUnlocked()) {
          item.status = 'failed';
          item.reason = 'Vault was locked during batch processing';
          job.failedCount++;
          job.processed++;
          continue;
        }
        job.status = 'cancelled';
        break;
      }

      item.status = 'processing';
      const result = await this.extractor.inspectUrl(item.url);

      if (job.cancelled) {
        item.status = 'skipped';
        item.reason = 'Batch cancelled by user';
        job.skippedCount++;
        job.processed++;
        job.status = 'cancelled';
        break;
      }

      if (result.found && this.vault.isUnlocked()) {
        try {
          const autoTags = [
            ...job.tags,
            ...(Array.isArray(result.discoveredTags)
              ? result.discoveredTags
              : []),
          ];
          if (
            result.videoInfo?.provider &&
            !['html5 video', 'embedded video', 'web video'].includes(
              result.videoInfo.provider.toLowerCase()
            )
          ) {
            autoTags.push(result.videoInfo.provider.toLowerCase());
          }
          const entry = this.vault.addEntry({
            url: item.url,
            finalUrl: result.finalUrl,
            title: result.title,
            domain: result.domain,
            thumbnailDataUrl: result.thumbnailDataUrl,
            tags: autoTags,
            folderId: job.folderId,
            videoInfo: result.videoInfo,
          });
          item.status = 'added';
          item.title = entry.title;
          item.entryId = entry.id;
          item.videoSummary =
            result.videoInfo?.selectionReason || 'Video captured';
          job.addedCount++;
        } catch (err) {
          item.status = 'failed';
          item.reason = err.message;
          job.failedCount++;
        }
      } else if (result.status === 'skipped') {
        item.status = 'skipped';
        item.title = result.title || item.url;
        item.finalUrl = result.finalUrl || item.url;
        item.domain = result.domain || null;
        item.fallbackThumbnailDataUrl = result.fallbackThumbnailDataUrl || null;
        item.discoveredTags = Array.isArray(result.discoveredTags)
          ? result.discoveredTags
          : [];
        item.reason = result.reason || 'No video found on page';
        job.skippedCount++;
      } else {
        item.status = 'failed';
        item.reason = result.reason || 'Failed to inspect URL';
        job.failedCount++;
      }

      job.processed++;
    }

    if (job.status === 'running') {
      job.status = 'completed';
    }
    job.completedAt = new Date().toISOString();
  }

  /**
   * Forces creation of catalog entries for one or more skipped/failed items in a batch job.
   */
  addSkippedOrFailedItems(jobId, itemIndices = null) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Batch job not found.');

    const indexSet = Array.isArray(itemIndices)
      ? new Set(itemIndices.map(Number))
      : null;

    let newlyAdded = 0;
    for (const item of job.items) {
      if (item.status !== 'skipped' && item.status !== 'failed') continue;
      if (indexSet && !indexSet.has(item.index)) continue;

      const prevStatus = item.status;
      let normalizedUrl = item.url;
      let domain = item.domain || '';
      try {
        normalizedUrl = normalizeInputUrl(item.url);
        if (!domain) {
          domain = new URL(normalizedUrl).hostname.replace(/^www\./i, '');
        }
      } catch {
        domain = domain || item.url;
      }

      const entry = this.vault.addEntry({
        url: item.url,
        finalUrl: item.finalUrl || normalizedUrl,
        title: item.title || normalizedUrl,
        domain,
        thumbnailDataUrl:
          item.fallbackThumbnailDataUrl ||
          generatePlaceholderThumbnailDataUrl(domain || item.url),
        tags: [
          ...job.tags,
          ...(Array.isArray(item.discoveredTags) ? item.discoveredTags : []),
        ],
        folderId: job.folderId,
        videoInfo: {
          type: 'manual-override',
          provider: domain || 'Web Video',
          width: 480,
          height: 270,
          totalVideosOnPage: 1,
          selectionReason: 'Added manually (override)',
          thumbnailSource: item.fallbackThumbnailDataUrl
            ? 'page-preview'
            : 'generated-placeholder',
        },
      });

      item.status = 'added';
      item.title = entry.title;
      item.entryId = entry.id;
      item.videoSummary = 'Added manually (override)';
      if (prevStatus === 'skipped') job.skippedCount = Math.max(0, job.skippedCount - 1);
      if (prevStatus === 'failed') job.failedCount = Math.max(0, job.failedCount - 1);
      job.addedCount++;
      newlyAdded++;
    }

    return {
      newlyAdded,
      job: this.getJobSummary(jobId),
    };
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Batch job not found.');
    job.cancelled = true;
    if (job.status === 'running') {
      job.status = 'cancelled';
    }
    return this.getJobSummary(jobId);
  }

  getJobSummary(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      total: job.total,
      processed: job.processed,
      addedCount: job.addedCount,
      skippedCount: job.skippedCount,
      failedCount: job.failedCount,
      items: job.items,
    };
  }

  getLatestJobSummary() {
    let latest = null;
    for (const job of this.jobs.values()) {
      if (!latest || job.createdAt >= latest.createdAt) {
        latest = job;
      }
    }
    return latest ? this.getJobSummary(latest.id) : null;
  }
}

module.exports = {
  VideoExtractor,
  BatchProcessor,
  findBrowserExecutable,
  normalizeInputUrl,
  detectPlatformFromUrl,
  generatePlaceholderThumbnailDataUrl,
};
