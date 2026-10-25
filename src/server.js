const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exec, spawn } = require('node:child_process');
const { CryptoVault, getDefaultVaultPath } = require('./crypto-vault');
const {
  VideoExtractor,
  BatchProcessor,
  findBrowserExecutable,
  normalizeInputUrl,
  generatePlaceholderThumbnailDataUrl,
} = require('./video-extractor');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function readJsonBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function createAppServer(options = {}) {
  const vaultPath = options.vaultPath || getDefaultVaultPath();
  const vault = new CryptoVault(vaultPath);
  const extractor = options.extractor || new VideoExtractor();
  const batchProcessor = new BatchProcessor(extractor, vault);

  let activeSessionToken = null;

  function issueSessionToken() {
    activeSessionToken = crypto.randomBytes(32).toString('hex');
    return activeSessionToken;
  }

  function verifySession(req) {
    if (!vault.isUnlocked()) {
      activeSessionToken = null;
      return false;
    }
    if (!activeSessionToken) return false;
    const headerToken = req.headers['x-vault-session'];
    return (
      typeof headerToken === 'string' &&
      headerToken.length === activeSessionToken.length &&
      crypto.timingSafeEqual(
        Buffer.from(headerToken),
        Buffer.from(activeSessionToken)
      )
    );
  }

  function requireAuth(req, res) {
    if (!vault.isUnlocked() || !verifySession(req)) {
      sendJson(res, 401, {
        error: 'Vault is locked. Please unlock with your master password.',
        code: 'VAULT_LOCKED',
        status: vault.getStatus(),
      });
      return false;
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      const method = req.method.toUpperCase();

      // ==================== VAULT AUTH ROUTES ====================
      if (pathname === '/api/vault/status' && method === 'GET') {
        const isAuth = verifySession(req);
        const status = vault.getStatus();
        if (!isAuth && status.unlocked) {
          // If client doesn't hold the active session token, report locked to client
          status.unlocked = false;
          status.entryCount = null;
          status.folderCount = null;
        }
        return sendJson(res, 200, status);
      }

      if (pathname === '/api/vault/init' && method === 'POST') {
        const body = await readJsonBody(req);
        const status = vault.initialize(body.password);
        const sessionToken = issueSessionToken();
        return sendJson(res, 200, { status, sessionToken });
      }

      if (pathname === '/api/vault/unlock' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const status = vault.unlock(body.password);
          const sessionToken = issueSessionToken();
          return sendJson(res, 200, { status, sessionToken });
        } catch (err) {
          const code = err.code === 'INVALID_PASSWORD' ? 403 : 400;
          return sendJson(res, code, {
            error: err.message,
            code: err.code || 'UNLOCK_FAILED',
          });
        }
      }

      if (pathname === '/api/vault/lock' && method === 'POST') {
        vault.lock();
        activeSessionToken = null;
        return sendJson(res, 200, { status: vault.getStatus() });
      }

      if (pathname === '/api/vault/password' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readJsonBody(req);
        try {
          vault.changePassword(body.currentPassword, body.newPassword);
          const sessionToken = issueSessionToken();
          return sendJson(res, 200, {
            message: 'Vault encryption password updated and re-encrypted.',
            sessionToken,
            status: vault.getStatus(),
          });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // ==================== OPEN URL IN PRIVATE / INCOGNITO BROWSER ====================
      if (pathname === '/api/open-private' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readJsonBody(req);
        const targetUrl = normalizeInputUrl(body.url);
        const browserExe = findBrowserExecutable();
        const isEdge = browserExe.toLowerCase().includes('msedge');
        const privateFlag = isEdge ? '--inprivate' : '--incognito';

        const child = spawn(browserExe, [privateFlag, targetUrl], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        return sendJson(res, 200, { opened: true, mode: privateFlag });
      }

      // ==================== CATALOG & ENTRIES ROUTES ====================
      if (pathname === '/api/catalog' && method === 'GET') {
        if (!requireAuth(req, res)) return;
        const search = parsedUrl.searchParams.get('search') || '';
        const folderId = parsedUrl.searchParams.get('folderId') || 'all';
        const tagsParam = parsedUrl.searchParams.get('tags') || '';
        const tagMatchMode =
          parsedUrl.searchParams.get('tagMatchMode') || 'all';
        const sortBy = parsedUrl.searchParams.get('sortBy') || 'newest';

        const entries = vault.listEntries({
          search,
          folderId,
          tags: tagsParam ? tagsParam.split(',') : [],
          tagMatchMode,
          sortBy,
        });
        const { folders, summary } = vault.listFolders();
        const tags = vault.listTags();

        return sendJson(res, 200, {
          entries,
          folders,
          summary,
          tags,
        });
      }

      // Single URL inspection + catalog creation
      if (pathname === '/api/entries/extract' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readJsonBody(req);
        if (!body.url || !String(body.url).trim()) {
          return sendJson(res, 400, { error: 'Please provide a valid URL.' });
        }

        const inspection = await extractor.inspectUrl(body.url);
        if (!inspection.found) {
          return sendJson(res, 200, {
            found: false,
            status: inspection.status,
            url: body.url,
            finalUrl: inspection.finalUrl || body.url,
            domain: inspection.domain || null,
            title: inspection.title || null,
            fallbackThumbnailDataUrl:
              inspection.fallbackThumbnailDataUrl || null,
            candidateThumbnails: inspection.candidateThumbnails || [],
            discoveredTags: inspection.discoveredTags || [],
            reason:
              inspection.reason ||
              'No video was detected on the provided webpage.',
          });
        }

        // Re-check vault is still unlocked after async extraction
        if (!vault.isUnlocked()) {
          return sendJson(res, 401, {
            error: 'Vault was locked while inspecting URL.',
            code: 'VAULT_LOCKED',
          });
        }

        const userTags = Array.isArray(body.tags)
          ? [...body.tags]
          : String(body.tags || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        // Merge auto-discovered page tags & categories
        if (Array.isArray(inspection.discoveredTags)) {
          userTags.push(...inspection.discoveredTags);
        }

        // Add provider tag automatically if meaningful
        if (
          inspection.videoInfo?.provider &&
          !['html5 video', 'embedded video', 'web video'].includes(
            inspection.videoInfo.provider.toLowerCase()
          )
        ) {
          userTags.push(inspection.videoInfo.provider.toLowerCase());
        }

        const entry = vault.addEntry({
          url: body.url,
          finalUrl: inspection.finalUrl,
          title: body.customTitle || inspection.title,
          domain: inspection.domain,
          thumbnailDataUrl: inspection.thumbnailDataUrl,
          tags: userTags,
          folderId: body.folderId || null,
          notes: body.notes || '',
          videoInfo: inspection.videoInfo,
        });

        return sendJson(res, 201, {
          found: true,
          status: 'added',
          entry,
        });
      }

      // Manual / force-add catalog entry for a skipped or failed URL
      if (pathname === '/api/entries/manual' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readJsonBody(req);
        if (!body.url || !String(body.url).trim()) {
          return sendJson(res, 400, { error: 'Please provide a valid URL.' });
        }

        let normalizedUrl = String(body.url).trim();
        let domain = body.domain || '';
        try {
          normalizedUrl = normalizeInputUrl(body.url);
          if (!domain) {
            domain = new URL(normalizedUrl).hostname.replace(/^www\./i, '');
          }
        } catch {
          domain = domain || normalizedUrl;
        }

        const userTags = Array.isArray(body.tags)
          ? body.tags
          : String(body.tags || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const entry = vault.addEntry({
          url: body.url,
          finalUrl: body.finalUrl || normalizedUrl,
          title: body.title || normalizedUrl,
          domain,
          thumbnailDataUrl:
            body.thumbnailDataUrl ||
            generatePlaceholderThumbnailDataUrl(domain || normalizedUrl),
          tags: userTags,
          folderId: body.folderId || null,
          notes: body.notes || '',
          videoInfo: {
            type: 'manual-override',
            provider: domain || 'Web Video',
            width: 480,
            height: 270,
            totalVideosOnPage: 1,
            selectionReason: 'Added manually (override)',
            thumbnailSource: body.thumbnailDataUrl
              ? 'custom-or-page-preview'
              : 'generated-placeholder',
          },
        });

        return sendJson(res, 201, {
          found: true,
          status: 'added',
          entry,
        });
      }

      // Harvest Pinterest-style candidate images from the page for an existing entry
      const harvestMatch = pathname.match(
        /^\/api\/entries\/([^/]+)\/harvest-images$/
      );
      if (harvestMatch && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const entryId = decodeURIComponent(harvestMatch[1]);
        const existing = vault.getEntry(entryId);
        if (!existing) {
          return sendJson(res, 404, { error: 'Entry not found.' });
        }
        const candidates = await extractor.harvestImagesFromUrl(existing.url);
        return sendJson(res, 200, { candidateThumbnails: candidates });
      }

      // Auto-discover tags & categories from the webpage for an existing entry
      const discoverTagsMatch = pathname.match(
        /^\/api\/entries\/([^/]+)\/discover-tags$/
      );
      if (discoverTagsMatch && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const entryId = decodeURIComponent(discoverTagsMatch[1]);
        const existing = vault.getEntry(entryId);
        if (!existing) {
          return sendJson(res, 404, { error: 'Entry not found.' });
        }
        const discoveredTags = await extractor.discoverTagsFromUrl(existing.url);
        const mergedTags = [
          ...(existing.tags || []),
          ...(discoveredTags || []),
        ];
        const updated = vault.updateEntry(entryId, { tags: mergedTags });
        return sendJson(res, 200, {
          entry: updated,
          discoveredTags,
        });
      }

      // Refresh thumbnail for an existing entry
      const refreshMatch = pathname.match(
        /^\/api\/entries\/([^/]+)\/refresh-thumbnail$/
      );
      if (refreshMatch && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const entryId = decodeURIComponent(refreshMatch[1]);
        const existing = vault.getEntry(entryId);
        if (!existing) {
          return sendJson(res, 404, { error: 'Entry not found.' });
        }

        const inspection = await extractor.inspectUrl(existing.url);
        if (!inspection.found) {
          return sendJson(res, 400, {
            error:
              inspection.reason ||
              'Could not detect a video on this page during refresh.',
          });
        }

        const mergedTags = [
          ...(existing.tags || []),
          ...(inspection.discoveredTags || []),
        ];

        const updated = vault.updateEntry(entryId, {
          thumbnailDataUrl: inspection.thumbnailDataUrl,
          videoInfo: inspection.videoInfo,
          tags: mergedTags,
        });
        return sendJson(res, 200, { entry: updated });
      }

      // Bulk operations on entries
      if (pathname === '/api/entries/bulk' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readJsonBody(req);
        const { action, entryIds = [] } = body;
        if (!Array.isArray(entryIds) || entryIds.length === 0) {
          return sendJson(res, 400, { error: 'No entries selected.' });
        }

        if (action === 'delete') {
          const result = vault.deleteEntries(entryIds);
          return sendJson(res, 200, result);
        }

        const result = vault.bulkUpdateEntries(entryIds, {
          folderId: body.folderId,
          addTags: body.addTags,
          removeTags: body.removeTags,
          favorite: body.favorite,
        });
        return sendJson(res, 200, result);
      }

      // Single entry update / delete
      const entryMatch = pathname.match(/^\/api\/entries\/([^/]+)$/);
      if (entryMatch) {
        if (!requireAuth(req, res)) return;
        const entryId = decodeURIComponent(entryMatch[1]);

        if (method === 'PATCH' || method === 'PUT') {
          const body = await readJsonBody(req);
          const entry = vault.updateEntry(entryId, body);
          return sendJson(res, 200, { entry });
        }

        if (method === 'DELETE') {
          const result = vault.deleteEntries([entryId]);
          return sendJson(res, 200, result);
        }
      }

      // ==================== FOLDERS ROUTES ====================
      if (pathname === '/api/folders' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readJsonBody(req);
        const folder = vault.createFolder(body);
        return sendJson(res, 201, { folder });
      }

      const folderMatch = pathname.match(/^\/api\/folders\/([^/]+)$/);
      if (folderMatch) {
        if (!requireAuth(req, res)) return;
        const folderId = decodeURIComponent(folderMatch[1]);

        if (method === 'PATCH' || method === 'PUT') {
          const body = await readJsonBody(req);
          const folder = vault.updateFolder(folderId, body);
          return sendJson(res, 200, { folder });
        }

        if (method === 'DELETE') {
          const result = vault.deleteFolder(folderId);
          return sendJson(res, 200, result);
        }
      }

      // ==================== BATCH PROCESSING ROUTES ====================
      if (pathname === '/api/batch' && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readJsonBody(req);
        const tags = Array.isArray(body.tags)
          ? body.tags
          : String(body.tags || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const job = batchProcessor.startBatch({
          urls: body.urls,
          folderId: body.folderId || null,
          tags,
        });
        return sendJson(res, 201, { job });
      }

      const batchAddSkippedMatch = pathname.match(
        /^\/api\/batch\/([^/]+)\/add-skipped$/
      );
      if (batchAddSkippedMatch && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const jobId = decodeURIComponent(batchAddSkippedMatch[1]);
        const body = await readJsonBody(req);
        const result = batchProcessor.addSkippedOrFailedItems(
          jobId,
          body.itemIndices || null
        );
        return sendJson(res, 200, result);
      }

      const batchCancelMatch = pathname.match(/^\/api\/batch\/([^/]+)\/cancel$/);
      if (batchCancelMatch && method === 'POST') {
        if (!requireAuth(req, res)) return;
        const jobId = decodeURIComponent(batchCancelMatch[1]);
        const job = batchProcessor.cancelJob(jobId);
        return sendJson(res, 200, { job });
      }

      if (pathname === '/api/batch/latest' && method === 'GET') {
        if (!requireAuth(req, res)) return;
        const job = batchProcessor.getLatestJobSummary();
        return sendJson(res, 200, { job });
      }

      const batchMatch = pathname.match(/^\/api\/batch\/([^/]+)$/);
      if (batchMatch && method === 'GET') {
        if (!requireAuth(req, res)) return;
        const jobId = decodeURIComponent(batchMatch[1]);
        const job = batchProcessor.getJobSummary(jobId);
        if (!job) {
          return sendJson(res, 404, { error: 'Batch job not found.' });
        }
        return sendJson(res, 200, { job });
      }

      // ==================== STATIC FRONTEND ====================
      if (method === 'GET' || method === 'HEAD') {
        let relPath = pathname === '/' ? '/index.html' : pathname;
        // Prevent path traversal
        const safePath = path
          .normalize(relPath)
          .replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(PUBLIC_DIR, safePath);

        if (
          fullPath.startsWith(PUBLIC_DIR) &&
          fs.existsSync(fullPath) &&
          fs.statSync(fullPath).isFile()
        ) {
          const ext = path.extname(fullPath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
          });
          fs.createReadStream(fullPath).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, {
        error: err.message || 'Internal server error',
      });
    }
  });

  async function shutdown() {
    vault.lock();
    await extractor.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, vault, extractor, batchProcessor, shutdown };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3847;
  const open = process.argv.includes('--open');
  const { server, vault, shutdown } = createAppServer();

  // Strictly bind to 127.0.0.1 so only this local computer can reach the server
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}`;
    console.log('==========================================================');
    console.log('  CipherClip — Private Encrypted Video Website Catalog');
    console.log('==========================================================');
    console.log(`  Local URL   : ${url}`);
    console.log(`  Vault Path  : ${vault.vaultPath}`);
    console.log(`  Encryption  : AES-256-GCM + scrypt (Single-User Vault)`);
    console.log('==========================================================');

    if (open && process.platform === 'win32') {
      exec(`start "" "${url}"`);
    }
  });

  process.on('SIGINT', async () => {
    console.log('\nLocking vault and shutting down...');
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}

module.exports = { createAppServer };
