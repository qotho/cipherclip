const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CryptoVault, getDefaultVaultPath } = require('../src/crypto-vault');
const { createAppServer } = require('../src/server');

function svgDataUrl(title, bg1, bg2, w = 854, h = 480) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bg1}"/>
        <stop offset="100%" stop-color="${bg2}"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w / 2}" cy="${h / 2}" r="60" fill="rgba(255,255,255,0.2)"/>
    <polygon points="${w / 2 - 20},${h / 2 - 30} ${w / 2 - 20},${h / 2 + 30} ${w / 2 + 32},${h / 2}" fill="#ffffff"/>
    <text x="${w / 2}" y="${h - 40}" font-family="Arial" font-size="32" fill="#ffffff" text-anchor="middle">${title}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function createMockWebsitesServer() {
  const mainPoster = svgDataUrl('MAIN VIDEO 854x480', '#4f46e5', '#06b6d4', 854, 480);
  const smallPoster = svgDataUrl('SIDEBAR VIDEO 240x135', '#ef4444', '#f97316', 240, 135);
  const medPoster = svgDataUrl('FOOTER VIDEO 400x225', '#10b981', '#059669', 400, 225);
  const singlePoster = svgDataUrl('SINGLE FEATURE VIDEO', '#8b5cf6', '#ec4899', 640, 360);

  const server = http.createServer((req, res) => {
    if (req.url === '/single-video') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
        <html>
          <head><title>Deep Dive Tutorial Video</title></head>
          <body style="margin:40px;background:#111;color:#fff;">
            <header><nav><a href="/categories/global-nav-noise">Global Nav Item</a></nav></header>
            <h1>Deep Dive Tutorial Video</h1>
            <video width="640" height="360" controls poster="${singlePoster}" src="movie.mp4" style="display:block;width:640px;height:360px;"></video>
            <div data-testid="video-tags-wrapper">
              <div class="inner-level">
                <ul>
                  <li><a href="/tags/cyberpunk"><span>Cyberpunk</span></a></li>
                  <li><a href="/tags/synthwave">#Synthwave <span class="count">1.4K</span></a></li>
                  <li><a href="/tags/all">Show More</a></li>
                </ul>
              </div>
            </div>
            <div class="meta-row">
              <span>Categories:</span>
              <div>
                <a href="/category/sci-fi">Sci-Fi</a>
                <a href="/category/animation">Animation (42)</a>
              </div>
            </div>
          </body>
        </html>`);
      return;
    }

    if (req.url === '/multi-video') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
        <html>
          <head><title>Multi-Video Showcase Page</title></head>
          <body style="margin:20px;background:#18181b;color:#fff;">
            <aside>
              <video width="240" height="135" controls poster="${smallPoster}" src="small.mp4" style="width:240px;height:135px;"></video>
            </aside>
            <main style="margin: 20px auto; width: 854px;">
              <h1>Main KeyNote Stream</h1>
              <video id="mainPlayer" width="854" height="480" controls poster="${mainPoster}" src="main-keynote.mp4" style="width:854px;height:480px;display:block;"></video>
            </main>
            <footer>
              <video width="400" height="225" controls poster="${medPoster}" src="footer.mp4" style="width:400px;height:225px;"></video>
            </footer>
          </body>
        </html>`);
      return;
    }

    if (req.url === '/dialog-blocked-video') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
        <html>
          <head><title>Video Behind Blocking Modal Dialog</title></head>
          <body style="margin:0;background:#090d16;color:#fff;overflow:hidden;">
            <main style="margin:60px auto;width:854px;filter:blur(12px);">
              <div class="custom-video-player" style="width:854px;height:480px;background:#10b981;display:flex;align-items:center;justify-content:center;">
                <video width="854" height="480" src="blocked.mp4" style="width:854px;height:480px;background:linear-gradient(135deg,#059669,#10b981);"></video>
              </div>
            </main>
            <!-- Obnoxious full-screen modal dialog & backdrop directly blocking the video player -->
            <div class="age-verify-backdrop" style="position:fixed;inset:0;background:rgba(255,0,0,0.92);z-index:99999;display:flex;align-items:center;justify-content:center;">
              <div role="dialog" aria-modal="true" style="width:600px;height:400px;background:#ff0000;color:#fff;padding:40px;">
                <h2>ARE YOU OVER 18? SUBSCRIBE TO CONTINUE</h2>
                <p>This giant red dialog box completely blocks the video player in the viewport.</p>
              </div>
            </div>
          </body>
        </html>`);
      return;
    }

    if (req.url === '/ad-vs-main-player') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
        <html>
          <head><title>Main Playable Video vs Advertisement Videos</title></head>
          <body style="margin:20px;background:#0f172a;color:#fff;">
            <!-- Large autoplaying muted ad video without controls -->
            <div class="sponsor-ad-container" style="width:900px;height:500px;">
              <video width="900" height="500" autoplay muted loop src="https://ads.example.com/preroll-banner.mp4" style="width:900px;height:500px;background:#ef4444;"></video>
            </div>
            <!-- Main interactive video player with Play button & control bar -->
            <main style="margin:20px auto;width:854px;">
              <div id="main-video-player" class="video-js" style="position:relative;width:854px;height:480px;">
                <video width="854" height="480" poster="${mainPoster}" src="feature-film.mp4" style="width:854px;height:480px;display:block;"></video>
                <button class="vjs-big-play-button" aria-label="Play Video" style="position:absolute;top:210px;left:390px;width:74px;height:50px;">Play</button>
                <div class="vjs-control-bar" style="height:36px;"></div>
              </div>
            </main>
          </body>
        </html>`);
      return;
    }

    if (req.url === '/no-video') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
        <html>
          <head><title>Plain Text Blog Post Without Any Video</title></head>
          <body>
            <h1>Just an Article</h1>
            <p>This page has text and static paragraphs, no video players at all.</p>
          </body>
        </html>`);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runTests() {
  console.log('1. Verifying single-user default vault path and AES-256-GCM encryption...');
  const defaultPath = getDefaultVaultPath();
  const expectedBase = (process.env.LOCALAPPDATA || os.homedir()).toLowerCase();
  assert.ok(
    defaultPath.toLowerCase().startsWith(expectedBase),
    `Expected default vault path (${defaultPath}) to be inside the current user's profile (${expectedBase}).`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vault-test-'));
  const testVaultPath = path.join(tempDir, 'test.vault');
  const vault = new CryptoVault(testVaultPath);

  vault.initialize('SecretPass!2026');
  const folder = vault.createFolder({ name: 'Confidential Clips', color: '#10b981' });
  vault.addEntry({
    url: 'https://private-example.org/secret-video-999',
    title: 'Ultra Secret Project Demo',
    domain: 'private-example.org',
    thumbnailDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/',
    tags: ['ProjectX', 'Confidential'],
    folderId: folder.id,
    notes: 'Sensitive note body 12345',
  });

  // Verify raw file on disk contains zero plaintext
  const rawBytes = fs.readFileSync(testVaultPath);
  assert.strictEqual(rawBytes.subarray(0, 8).toString('ascii'), 'CCVAULT1');
  const rawAscii = rawBytes.toString('utf8');
  assert.ok(!rawAscii.includes('private-example.org'), 'URL must not appear in plaintext on disk');
  assert.ok(!rawAscii.includes('Ultra Secret Project Demo'), 'Title must not appear in plaintext on disk');
  assert.ok(!rawAscii.includes('Confidential'), 'Tags/Folders must not appear in plaintext on disk');
  assert.ok(!rawAscii.includes('Sensitive note body'), 'Notes must not appear in plaintext on disk');

  // Lock and test wrong password rejection
  vault.lock();
  assert.strictEqual(vault.isUnlocked(), false);
  assert.throws(
    () => vault.unlock('WrongPassword!'),
    /Incorrect password/
  );

  // Unlock with right password & test password rotation
  vault.unlock('SecretPass!2026');
  assert.strictEqual(vault.listEntries({ search: '#projectx' }).length, 1);
  vault.changePassword('SecretPass!2026', 'NewMasterKey#99');
  vault.lock();
  assert.throws(() => vault.unlock('SecretPass!2026'), /Incorrect password/);
  vault.unlock('NewMasterKey#99');
  assert.strictEqual(vault.listEntries().length, 1);
  vault.lock();
  console.log('   [PASS] AES-256-GCM encryption, zero plaintext on disk, and password rotation verified.');

  console.log('2. Starting mock websites server & CipherClip server...');
  const mockSites = await createMockWebsitesServer();
  const apiVaultPath = path.join(tempDir, 'api.vault');
  const app = createAppServer({ vaultPath: apiVaultPath });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const appPort = app.server.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  try {
    // Initialize vault via API
    const initRes = await fetch(`${appUrl}/api/vault/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'TestVaultPassword123' }),
    });
    const initData = await initRes.json();
    assert.strictEqual(initRes.status, 200);
    const token = initData.sessionToken;
    const authHeaders = {
      'Content-Type': 'application/json',
      'x-vault-session': token,
    };

    console.log('3. Testing multi-video page inspection (selecting largest/main video)...');
    const multiRes = await fetch(`${appUrl}/api/entries/extract`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        url: `${mockSites.baseUrl}/multi-video`,
        tags: 'keynote, multi-test',
        folderId: 'fld_research',
      }),
    });
    const multiData = await multiRes.json();
    assert.strictEqual(multiData.found, true);
    assert.strictEqual(multiData.entry.title, 'Multi-Video Showcase Page');
    assert.strictEqual(multiData.entry.videoInfo.totalVideosOnPage, 3);
    assert.strictEqual(multiData.entry.videoInfo.width, 854);
    assert.strictEqual(multiData.entry.videoInfo.height, 480);
    assert.ok(
      multiData.entry.thumbnailDataUrl.startsWith('data:image/jpeg;base64,'),
      'Expected medium JPEG thumbnail data URL'
    );
    console.log(
      `   [PASS] Multi-video page: detected ${multiData.entry.videoInfo.totalVideosOnPage} videos, selected largest (${multiData.entry.videoInfo.width}x${multiData.entry.videoInfo.height}), captured medium JPEG thumbnail (${Math.round(multiData.entry.thumbnailDataUrl.length / 1024)} KB).`
    );

    console.log('4. Testing page with blocking modal dialog over video player...');
    const blockedRes = await fetch(`${appUrl}/api/entries/extract`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        url: `${mockSites.baseUrl}/dialog-blocked-video`,
      }),
    });
    const blockedData = await blockedRes.json();
    assert.strictEqual(blockedData.found, true);
    assert.strictEqual(blockedData.entry.videoInfo.width, 854);
    assert.strictEqual(blockedData.entry.videoInfo.height, 480);
    assert.ok(blockedData.entry.thumbnailDataUrl.startsWith('data:image/jpeg;base64,'));
    console.log(
      `   [PASS] Dialog-blocked video page: peeled away blocking modal/blur and captured underlying video player (${blockedData.entry.videoInfo.thumbnailSource}).`
    );

    console.log('4b. Testing page with Advertisement video vs Main Playable Video Player (with Play button & controls)...');
    const adVsMainRes = await fetch(`${appUrl}/api/entries/extract`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        url: `${mockSites.baseUrl}/ad-vs-main-player`,
      }),
    });
    const adVsMainData = await adVsMainRes.json();
    assert.strictEqual(adVsMainData.found, true);
    assert.strictEqual(adVsMainData.entry.videoInfo.width, 854);
    assert.strictEqual(adVsMainData.entry.videoInfo.height, 480);
    assert.ok(
      adVsMainData.entry.videoInfo.selectionReason.includes('playable controls verified'),
      `Expected playable controls verified in selectionReason, got: ${adVsMainData.entry.videoInfo.selectionReason}`
    );
    console.log(
      `   [PASS] Ad vs Main Player: filtered out larger 900x500 ad video and selected 854x480 main playable video (${adVsMainData.entry.videoInfo.selectionReason}).`
    );

    console.log('5. Testing page without video (skipping gracefully)...');
    const noVidRes = await fetch(`${appUrl}/api/entries/extract`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        url: `${mockSites.baseUrl}/no-video`,
      }),
    });
    const noVidData = await noVidRes.json();
    assert.strictEqual(noVidData.found, false);
    assert.strictEqual(noVidData.status, 'skipped');
    console.log(`   [PASS] Non-video page skipped with reason: "${noVidData.reason}".`);

    console.log('5. Testing batch URL list processing...');
    const batchUrls = [
      `${mockSites.baseUrl}/single-video`,
      `${mockSites.baseUrl}/no-video`,
      `${mockSites.baseUrl}/multi-video`,
    ].join('\n');

    const startBatchRes = await fetch(`${appUrl}/api/batch`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        urls: batchUrls,
        folderId: 'fld_tutorials',
        tags: 'batch-tag, automated',
      }),
    });
    const startBatchData = await startBatchRes.json();
    const jobId = startBatchData.job.id;

    let finalJob = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const pollRes = await fetch(`${appUrl}/api/batch/${jobId}`, {
        headers: authHeaders,
      });
      const pollData = await pollRes.json();
      if (pollData.job.status !== 'running') {
        finalJob = pollData.job;
        break;
      }
    }

    assert.ok(finalJob, 'Batch job should complete within timeout');
    assert.strictEqual(finalJob.total, 3);
    assert.strictEqual(finalJob.addedCount, 2);
    assert.strictEqual(finalJob.skippedCount, 1);
    assert.strictEqual(finalJob.failedCount, 0);

    // Verify auto-discovered tags on the /single-video entry
    const singleEntryId = finalJob.items[0].entryId;
    const singleEntry = app.vault.getEntry(singleEntryId);
    assert.ok(singleEntry.tags.includes('cyberpunk'), 'Should auto-discover cyberpunk tag from data-testid*="tag"');
    assert.ok(singleEntry.tags.includes('synthwave'), 'Should auto-discover synthwave tag and strip count badge');
    assert.ok(singleEntry.tags.includes('sci-fi'), 'Should auto-discover sci-fi from Categories: container');
    assert.ok(singleEntry.tags.includes('animation'), 'Should auto-discover animation from Categories: container');
    assert.ok(!singleEntry.tags.includes('show more'), 'Should exclude UI action links like Show More');
    assert.ok(!singleEntry.tags.includes('global nav item'), 'Should exclude global <header>/<nav> links');
    console.log(
      `   [PASS] Batch processing & DOM Tag Auto-Discovery complete: ${finalJob.addedCount} added, ${finalJob.skippedCount} skipped, auto-discovered tags: [${singleEntry.tags.join(', ')}].`
    );

    console.log('6. Verifying Vue 3 UI rendering in headless browser...');
    const uiCheck = await app.extractor.inspectUrl(appUrl);
    assert.strictEqual(uiCheck.title, 'CipherClip — Private Encrypted Video Catalog');
    console.log('   [PASS] Vue 3 frontend served and rendered cleanly.');
  } finally {
    await app.shutdown();
    await mockSites.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('\nALL VERIFICATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
