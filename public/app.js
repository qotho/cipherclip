const {
  createApp,
  ref,
  reactive,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
} = Vue;

createApp({
  setup() {
    // ==================== SESSION & VAULT STATE ====================
    const sessionToken = ref(sessionStorage.getItem('cc_vault_session') || '');
    const vaultStatus = reactive({
      initialized: true,
      unlocked: false,
      vaultPath: '',
      userAccount: '',
      encryption: '',
    });

    const authForm = reactive({
      password: '',
      confirmPassword: '',
      loading: false,
      error: '',
    });

    // ==================== CATALOG DATA & FILTERS ====================
    const entries = ref([]);
    const folders = ref([]);
    const tags = ref([]);
    const summary = reactive({
      totalCount: 0,
      uncategorizedCount: 0,
      favoritesCount: 0,
    });

    const activeFolderId = ref('all');
    const selectedTags = ref([]);
    const tagMatchMode = ref('all'); // 'all' | 'any'
    const searchQuery = ref('');
    const sortBy = ref('newest');
    const viewMode = ref(localStorage.getItem('cc_view_mode') || 'grid');
    const paginationMode = ref(
      localStorage.getItem('cc_pagination_mode') || 'infinite'
    );
    // Privacy: blurOnStartup is the saved preference; blurThumbnails is the
    // live state. Toggling blurThumbnails is temporary (resets on reload) and
    // never touches the saved preference.
    const blurOnStartup = ref(localStorage.getItem('cc_blur_on_startup') === 'true');
    const blurThumbnails = ref(blurOnStartup.value);
    const infiniteBatchSize = 24;
    const infiniteLimit = ref(infiniteBatchSize);
    const currentPage = ref(1);
    const entriesScrollRef = ref(null);

    const selectedEntryIds = ref([]);
    const draggedEntryId = ref(null);
    const dragOverFolderId = ref(null);

    // ==================== EXTRACTION & QUICK SCAN ====================
    const quickUrl = ref('');
    const quickScanning = ref(false);
    const extractionMessage = ref('');

    // ==================== MODALS & FORMS ====================
    const modals = reactive({
      addUrl: false,
      batch: false,
      entry: false,
      folder: false,
      security: false,
    });

    const singleForm = reactive({
      url: '',
      title: '',
      folderId: '',
      tags: '',
      notes: '',
      fallbackThumbnailDataUrl: null,
      candidateThumbnails: [],
      loading: false,
      statusMessage: '',
      statusType: 'warn',
    });

    const batchForm = reactive({
      urlsText: '',
      folderId: '',
      tags: '',
      runInBackground: localStorage.getItem('cc_batch_bg') === 'true',
    });
    const batchJob = ref(null);
    const batchTab = ref('all');
    const batchBannerDismissed = ref(false);
    let batchPollTimer = null;

    const editingEntry = ref(null);
    const refreshingThumb = ref(false);
    const thumbDragOver = ref(false);
    const entryCandidateThumbnails = ref([]);
    const harvestingEntryImages = ref(false);
    const discoveringEntryTags = ref(false);

    const folderForm = reactive({
      id: null,
      name: '',
      parentId: '',
      color: '#6366f1',
    });

    const passwordForm = reactive({
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
      message: '',
      statusType: 'ok',
    });

    const toasts = ref([]);
    let toastIdSeq = 1;

    function showToast(message, type = 'success', durationMs = 4200) {
      const id = toastIdSeq++;
      toasts.value.push({ id, message, type });
      setTimeout(() => {
        toasts.value = toasts.value.filter((t) => t.id !== id);
      }, durationMs);
    }

    // ==================== API HELPER ====================
    async function apiFetch(url, options = {}) {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      };
      if (sessionToken.value) {
        headers['x-vault-session'] = sessionToken.value;
      }

      const res = await fetch(url, {
        ...options,
        headers,
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 401 && data.code === 'VAULT_LOCKED') {
        sessionToken.value = '';
        sessionStorage.removeItem('cc_vault_session');
        vaultStatus.unlocked = false;
        if (data.status) {
          Object.assign(vaultStatus, data.status);
        }
        throw new Error(data.error || 'Vault is locked.');
      }

      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      return data;
    }

    // ==================== COMPUTED PROPERTIES ====================
    const folderMap = computed(() => {
      const map = {};
      for (const f of folders.value) {
        map[f.id] = f;
      }
      return map;
    });

    const orderedFolders = computed(() => {
      const result = [];
      const visited = new Set();

      function walk(parentId = null, depth = 0) {
        const children = folders.value
          .filter((f) => (f.parentId || null) === parentId)
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          result.push({ ...child, depth });
          walk(child.id, depth + 1);
        }
      }

      walk(null, 0);
      // Include any orphaned folders safely
      for (const f of folders.value) {
        if (!visited.has(f.id)) {
          result.push({ ...f, depth: 0 });
        }
      }
      return result;
    });

    const activeUserFolder = computed(() => {
      if (
        !activeFolderId.value ||
        ['all', 'favorites', 'uncategorized'].includes(activeFolderId.value)
      ) {
        return null;
      }
      return folderMap.value[activeFolderId.value] || null;
    });

    const currentViewTitle = computed(() => {
      if (activeFolderId.value === 'all') return 'All Videos';
      if (activeFolderId.value === 'favorites') return 'Favorites';
      if (activeFolderId.value === 'uncategorized') return 'Uncategorized';
      return activeUserFolder.value ? activeUserFolder.value.name : 'Catalog';
    });

    const hasActiveFilters = computed(() => {
      return (
        activeFolderId.value !== 'all' ||
        selectedTags.value.length > 0 ||
        Boolean(searchQuery.value.trim())
      );
    });

    const pageSize = computed(() => {
      if (paginationMode.value === 'infinite') return infiniteBatchSize;
      const parsed = parseInt(paginationMode.value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
    });

    const totalPages = computed(() => {
      return Math.max(1, Math.ceil(entries.value.length / pageSize.value));
    });

    const pageStartIndex = computed(() => {
      return (currentPage.value - 1) * pageSize.value;
    });

    const pageEndIndex = computed(() => {
      return currentPage.value * pageSize.value;
    });

    const displayedEntries = computed(() => {
      if (paginationMode.value === 'infinite') {
        return entries.value.slice(0, infiniteLimit.value);
      }
      return entries.value.slice(pageStartIndex.value, pageEndIndex.value);
    });

    const batchProgressPercent = computed(() => {
      if (!batchJob.value || !batchJob.value.total) return 0;
      return Math.round(
        (batchJob.value.processed / batchJob.value.total) * 100
      );
    });

    const filteredBatchItems = computed(() => {
      if (!batchJob.value || !Array.isArray(batchJob.value.items)) return [];
      if (batchTab.value === 'all') return batchJob.value.items;
      return batchJob.value.items.filter((i) => i.status === batchTab.value);
    });

    const currentBatchProcessingUrl = computed(() => {
      if (!batchJob.value || !Array.isArray(batchJob.value.items)) return '';
      const active =
        batchJob.value.items.find((i) => i.status === 'processing') ||
        batchJob.value.items.find((i) => i.status === 'queued');
      return active ? active.url : '';
    });

    // ==================== VAULT LIFECYCLE ====================
    async function restoreActiveBatchJob() {
      const savedId = localStorage.getItem('cc_active_batch_id');
      if (!savedId) return;
      try {
        const res = await apiFetch(`/api/batch/${savedId}`);
        if (res?.job) {
          batchJob.value = res.job;
          if (res.job.status === 'running') {
            batchBannerDismissed.value = false;
            startBatchPolling(res.job.id);
          }
        }
      } catch {
        localStorage.removeItem('cc_active_batch_id');
      }
    }

    async function checkVaultStatus() {
      try {
        const status = await apiFetch('/api/vault/status');
        Object.assign(vaultStatus, status);
        if (vaultStatus.unlocked) {
          await loadCatalog();
          await restoreActiveBatchJob();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function handleInitializeVault() {
      authForm.error = '';
      if (authForm.password.length < 4) {
        authForm.error = 'Master password must be at least 4 characters.';
        return;
      }
      if (authForm.password !== authForm.confirmPassword) {
        authForm.error = 'Passwords do not match.';
        return;
      }

      authForm.loading = true;
      try {
        const res = await apiFetch('/api/vault/init', {
          method: 'POST',
          body: JSON.stringify({ password: authForm.password }),
        });
        sessionToken.value = res.sessionToken;
        sessionStorage.setItem('cc_vault_session', res.sessionToken);
        Object.assign(vaultStatus, res.status);
        authForm.password = '';
        authForm.confirmPassword = '';
        showToast('Encrypted vault created and unlocked.');
        await loadCatalog();
      } catch (err) {
        authForm.error = err.message;
      } finally {
        authForm.loading = false;
      }
    }

    async function handleUnlockVault() {
      authForm.error = '';
      authForm.loading = true;
      try {
        const res = await apiFetch('/api/vault/unlock', {
          method: 'POST',
          body: JSON.stringify({ password: authForm.password }),
        });
        sessionToken.value = res.sessionToken;
        sessionStorage.setItem('cc_vault_session', res.sessionToken);
        Object.assign(vaultStatus, res.status);
        authForm.password = '';
        await loadCatalog();
        await restoreActiveBatchJob();
      } catch (err) {
        authForm.error = err.message;
      } finally {
        authForm.loading = false;
      }
    }

    async function lockVault() {
      try {
        const res = await apiFetch('/api/vault/lock', { method: 'POST' });
        sessionToken.value = '';
        sessionStorage.removeItem('cc_vault_session');
        entries.value = [];
        folders.value = [];
        tags.value = [];
        Object.assign(vaultStatus, res.status);
        showToast('Vault locked and decrypted data cleared from memory.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function handleChangePassword() {
      passwordForm.message = '';
      if (passwordForm.newPassword !== passwordForm.confirmPassword) {
        passwordForm.statusType = 'error';
        passwordForm.message = 'New passwords do not match.';
        return;
      }
      try {
        const res = await apiFetch('/api/vault/password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: passwordForm.currentPassword,
            newPassword: passwordForm.newPassword,
          }),
        });
        sessionToken.value = res.sessionToken;
        sessionStorage.setItem('cc_vault_session', res.sessionToken);
        passwordForm.currentPassword = '';
        passwordForm.newPassword = '';
        passwordForm.confirmPassword = '';
        passwordForm.statusType = 'ok';
        passwordForm.message = res.message;
        showToast('Master password updated and vault re-encrypted.');
      } catch (err) {
        passwordForm.statusType = 'error';
        passwordForm.message = err.message;
      }
    }

    // ==================== CATALOG LOADING & FILTERING ====================
    async function loadCatalog() {
      if (!vaultStatus.unlocked) return;
      try {
        const params = new URLSearchParams({
          search: searchQuery.value,
          folderId: activeFolderId.value,
          tags: selectedTags.value.join(','),
          tagMatchMode: tagMatchMode.value,
          sortBy: sortBy.value,
        });
        const data = await apiFetch(`/api/catalog?${params.toString()}`);
        entries.value = data.entries || [];
        folders.value = data.folders || [];
        tags.value = data.tags || [];
        if (data.summary) {
          Object.assign(summary, data.summary);
        }
        // Keep selection valid
        const validIds = new Set(entries.value.map((e) => e.id));
        selectedEntryIds.value = selectedEntryIds.value.filter((id) =>
          validIds.has(id)
        );
      } catch (err) {
        if (vaultStatus.unlocked) {
          showToast(err.message, 'error');
        }
      }
    }

    let searchDebounceTimer = null;
    watch(searchQuery, () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        currentPage.value = 1;
        infiniteLimit.value = infiniteBatchSize;
        loadCatalog();
      }, 180);
    });

    watch([activeFolderId, sortBy, tagMatchMode], () => {
      currentPage.value = 1;
      infiniteLimit.value = infiniteBatchSize;
      if (entriesScrollRef.value) {
        entriesScrollRef.value.scrollTop = 0;
      }
      loadCatalog();
    });

    watch(viewMode, (val) => {
      localStorage.setItem('cc_view_mode', val);
    });

    watch(blurOnStartup, (val) => {
      localStorage.setItem('cc_blur_on_startup', val ? 'true' : 'false');
    });

    // Applied on <body> so it covers the grid and the modals (entry preview,
    // image pickers). Runs immediately so thumbnails are blurred from the
    // very first render when the startup preference is on.
    watch(
      blurThumbnails,
      (val) => {
        document.body.classList.toggle('blur-thumbnails', val);
      },
      { immediate: true }
    );

    watch(
      () => batchForm.runInBackground,
      (val) => {
        localStorage.setItem('cc_batch_bg', val ? 'true' : 'false');
      }
    );

    watch(paginationMode, (val) => {
      localStorage.setItem('cc_pagination_mode', val);
      currentPage.value = 1;
      infiniteLimit.value = infiniteBatchSize;
      if (entriesScrollRef.value) {
        entriesScrollRef.value.scrollTop = 0;
      }
    });

    watch(
      () => entries.value.length,
      () => {
        if (currentPage.value > totalPages.value) {
          currentPage.value = totalPages.value;
        }
      }
    );

    function handleCatalogScroll(event) {
      if (paginationMode.value !== 'infinite') return;
      if (displayedEntries.value.length >= entries.value.length) return;
      const el = event?.target || entriesScrollRef.value;
      if (!el) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 320) {
        infiniteLimit.value = Math.min(
          entries.value.length,
          infiniteLimit.value + infiniteBatchSize
        );
      }
    }

    function loadMoreInfinite() {
      infiniteLimit.value = Math.min(
        entries.value.length,
        infiniteLimit.value + infiniteBatchSize
      );
    }

    function goToPage(page) {
      const clamped = Math.min(totalPages.value, Math.max(1, page));
      currentPage.value = clamped;
      if (entriesScrollRef.value) {
        entriesScrollRef.value.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }

    function selectFolder(folderId) {
      activeFolderId.value = folderId;
    }

    function toggleTagFilter(tagName) {
      const idx = selectedTags.value.indexOf(tagName);
      if (idx === -1) {
        selectedTags.value.push(tagName);
      } else {
        selectedTags.value.splice(idx, 1);
      }
      currentPage.value = 1;
      infiniteLimit.value = infiniteBatchSize;
      loadCatalog();
    }

    function toggleTagMatchMode() {
      tagMatchMode.value = tagMatchMode.value === 'all' ? 'any' : 'all';
    }

    function clearAllFilters() {
      selectedTags.value = [];
      searchQuery.value = '';
      currentPage.value = 1;
      infiniteLimit.value = infiniteBatchSize;
      loadCatalog();
    }

    // ==================== SINGLE URL EXTRACTION ====================
    async function handleQuickScanUrl() {
      const url = quickUrl.value.trim();
      if (!url || quickScanning.value) return;

      quickScanning.value = true;
      extractionMessage.value = `Inspecting ${url} with headless browser & capturing largest video...`;

      const targetFolder =
        activeUserFolder.value ? activeUserFolder.value.id : null;

      try {
        const res = await apiFetch('/api/entries/extract', {
          method: 'POST',
          body: JSON.stringify({
            url,
            folderId: targetFolder,
            tags: [...selectedTags.value],
          }),
        });

        if (!res.found) {
          const cands = Array.isArray(res.candidateThumbnails)
            ? res.candidateThumbnails
            : [];
          const autoTags = Array.from(
            new Set([
              ...selectedTags.value,
              ...(Array.isArray(res.discoveredTags) ? res.discoveredTags : []),
            ])
          );
          singleForm.url = url;
          singleForm.title = res.title || '';
          singleForm.folderId = targetFolder || '';
          singleForm.tags = autoTags.join(', ');
          singleForm.notes = '';
          singleForm.candidateThumbnails = cands;
          singleForm.fallbackThumbnailDataUrl =
            cands[0]?.dataUrl || res.fallbackThumbnailDataUrl || null;
          singleForm.statusType = 'warn';
          singleForm.statusMessage =
            cands.length > 0
              ? `Could not auto-detect a video player (${res.reason || 'No video tag found'}) — select one of the ${cands.length} images captured from the site below and click "Add with Selected Thumbnail":`
              : `Skipped (${res.reason || 'No video auto-detected'}) — Click "Add Entry Anyway" below to catalog this URL anyway.`;
          modals.addUrl = true;
        } else {
          quickUrl.value = '';
          showToast(
            `Cataloged "${res.entry.title}" (${res.entry.videoInfo?.selectionReason || 'Video captured'})`,
            'success'
          );
          await loadCatalog();
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        quickScanning.value = false;
        extractionMessage.value = '';
      }
    }

    function openAddUrlModal() {
      singleForm.url = quickUrl.value.trim() || '';
      singleForm.title = '';
      singleForm.folderId = activeUserFolder.value
        ? activeUserFolder.value.id
        : '';
      singleForm.tags = selectedTags.value.join(', ');
      singleForm.notes = '';
      singleForm.fallbackThumbnailDataUrl = null;
      singleForm.candidateThumbnails = [];
      singleForm.statusMessage = '';
      modals.addUrl = true;
    }

    async function submitSingleUrl() {
      if (!singleForm.url.trim() || singleForm.loading) return;
      singleForm.loading = true;
      singleForm.candidateThumbnails = [];
      singleForm.statusMessage =
        'Launching headless browser, inspecting DOM for videos, and capturing medium thumbnail...';
      singleForm.statusType = 'ok';

      try {
        const res = await apiFetch('/api/entries/extract', {
          method: 'POST',
          body: JSON.stringify({
            url: singleForm.url.trim(),
            customTitle: singleForm.title.trim() || undefined,
            folderId: singleForm.folderId || null,
            tags: singleForm.tags,
            notes: singleForm.notes,
          }),
        });

        if (!res.found) {
          const cands = Array.isArray(res.candidateThumbnails)
            ? res.candidateThumbnails
            : [];
          if (!singleForm.title && res.title) {
            singleForm.title = res.title;
          }
          if (Array.isArray(res.discoveredTags) && res.discoveredTags.length > 0) {
            const existing = singleForm.tags
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean);
            const merged = Array.from(new Set([...existing, ...res.discoveredTags]));
            singleForm.tags = merged.join(', ');
          }
          singleForm.candidateThumbnails = cands;
          singleForm.fallbackThumbnailDataUrl =
            cands[0]?.dataUrl || res.fallbackThumbnailDataUrl || null;
          singleForm.statusType = 'warn';
          singleForm.statusMessage =
            cands.length > 0
              ? `Could not auto-detect a video player (${res.reason || 'No video tag found'}) — select one of the ${cands.length} images captured from the site below and click "Add with Selected Thumbnail":`
              : `Skipped — ${res.reason || 'No video was auto-detected.'} Click "Add Entry Anyway" below to catalog it anyway.`;
          return;
        }

        modals.addUrl = false;
        quickUrl.value = '';
        showToast(`Cataloged "${res.entry.title}"`);
        await loadCatalog();
      } catch (err) {
        singleForm.statusType = 'error';
        singleForm.statusMessage = `${err.message} — You can still click "Add Entry Anyway" below.`;
      } finally {
        singleForm.loading = false;
      }
    }

    async function forceAddSingleUrl() {
      if (!singleForm.url.trim() || singleForm.loading) return;
      singleForm.loading = true;
      try {
        const res = await apiFetch('/api/entries/manual', {
          method: 'POST',
          body: JSON.stringify({
            url: singleForm.url.trim(),
            title: singleForm.title.trim() || undefined,
            folderId: singleForm.folderId || null,
            tags: singleForm.tags,
            notes: singleForm.notes,
            thumbnailDataUrl: singleForm.fallbackThumbnailDataUrl || null,
          }),
        });
        modals.addUrl = false;
        quickUrl.value = '';
        showToast(
          `Added "${res.entry.title}" manually. You can open it anytime to paste a custom thumbnail (Ctrl+V).`
        );
        await loadCatalog();
      } catch (err) {
        singleForm.statusType = 'error';
        singleForm.statusMessage = err.message;
      } finally {
        singleForm.loading = false;
      }
    }

    // ==================== BATCH URL PROCESSOR ====================
    function openBatchModal() {
      if (!batchJob.value || batchJob.value.status !== 'running') {
        batchForm.folderId = activeUserFolder.value
          ? activeUserFolder.value.id
          : '';
        batchForm.tags = selectedTags.value.join(', ');
      }
      modals.batch = true;
    }

    function handleBatchFileUpload(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || '');
        batchForm.urlsText = batchForm.urlsText
          ? `${batchForm.urlsText}\n${content}`
          : content;
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    async function startBatchJob(runInBackground = batchForm.runInBackground) {
      if (!batchForm.urlsText.trim()) return;
      try {
        const res = await apiFetch('/api/batch', {
          method: 'POST',
          body: JSON.stringify({
            urls: batchForm.urlsText,
            folderId: batchForm.folderId || null,
            tags: batchForm.tags,
          }),
        });
        batchJob.value = res.job;
        batchTab.value = 'all';
        batchBannerDismissed.value = false;
        localStorage.setItem('cc_active_batch_id', res.job.id);
        startBatchPolling(res.job.id);
        if (runInBackground === true) {
          modals.batch = false;
          showToast(
            `Batch started in background (${res.job.total} URLs). Track live progress in the top bar.`
          );
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function minimizeBatchToBackground() {
      batchBannerDismissed.value = false;
      modals.batch = false;
      showToast('Batch processing minimized to the background.');
    }

    function dismissBackgroundBatchBanner() {
      batchBannerDismissed.value = true;
      if (batchJob.value && batchJob.value.status !== 'running') {
        localStorage.removeItem('cc_active_batch_id');
      }
    }

    function startBatchPolling(jobId) {
      stopBatchPolling();
      batchPollTimer = setInterval(async () => {
        try {
          const res = await apiFetch(`/api/batch/${jobId}`);
          const prevAdded = batchJob.value ? batchJob.value.addedCount : 0;
          batchJob.value = res.job;
          if (res.job.addedCount !== prevAdded) {
            await loadCatalog();
          }
          if (res.job.status !== 'running') {
            stopBatchPolling();
            await loadCatalog();
            showToast(
              `Batch finished: ${res.job.addedCount} added, ${res.job.skippedCount} skipped (no video), ${res.job.failedCount} failed.`
            );
          }
        } catch {
          stopBatchPolling();
        }
      }, 1000);
    }

    function stopBatchPolling() {
      if (batchPollTimer) {
        clearInterval(batchPollTimer);
        batchPollTimer = null;
      }
    }

    async function cancelBatchJob() {
      if (!batchJob.value) return;
      try {
        const res = await apiFetch(`/api/batch/${batchJob.value.id}/cancel`, {
          method: 'POST',
        });
        batchJob.value = res.job;
        stopBatchPolling();
        showToast('Batch processing stopped.', 'warn');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function resetBatchModal() {
      stopBatchPolling();
      batchJob.value = null;
      batchBannerDismissed.value = false;
      localStorage.removeItem('cc_active_batch_id');
      batchForm.urlsText = '';
    }

    async function copySkippedBatchUrls() {
      if (!batchJob.value) return;
      const list = batchJob.value.items
        .filter((i) => i.status === 'skipped' || i.status === 'failed')
        .map((i) => `${i.url} # ${i.reason || i.status}`)
        .join('\n');
      try {
        await navigator.clipboard.writeText(list);
        showToast('Skipped & failed URLs copied to clipboard.');
      } catch {
        showToast('Could not copy to clipboard.', 'warn');
      }
    }

    async function addSkippedBatchItem(item) {
      if (!batchJob.value || !item) return;
      try {
        const res = await apiFetch(
          `/api/batch/${batchJob.value.id}/add-skipped`,
          {
            method: 'POST',
            body: JSON.stringify({ itemIndices: [item.index] }),
          }
        );
        batchJob.value = res.job;
        showToast(`Added "${item.title || item.url}" to catalog.`);
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function addAllSkippedBatchItems() {
      if (!batchJob.value) return;
      try {
        const res = await apiFetch(
          `/api/batch/${batchJob.value.id}/add-skipped`,
          {
            method: 'POST',
            body: JSON.stringify({ itemIndices: null }),
          }
        );
        batchJob.value = res.job;
        showToast(
          `Added ${res.newlyAdded} skipped/failed URL(s) to your catalog.`
        );
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function formatBatchItemStatus(status) {
      if (status === 'queued') return 'Queued';
      if (status === 'processing') return 'Inspecting...';
      if (status === 'added') return 'Cataloged';
      if (status === 'skipped') return 'Skipped (No Video)';
      if (status === 'failed') return 'Failed';
      return status;
    }

    // ==================== ENTRY DETAIL & EDIT ====================
    function openEntryDetail(entry) {
      entryCandidateThumbnails.value = [];
      editingEntry.value = {
        ...entry,
        folderId: entry.folderId || '',
        tagsInput: (entry.tags || []).join(', '),
      };
      modals.entry = true;
    }

    async function handleHarvestEntryImages() {
      if (!editingEntry.value || harvestingEntryImages.value) return;
      harvestingEntryImages.value = true;
      try {
        const res = await apiFetch(
          `/api/entries/${editingEntry.value.id}/harvest-images`,
          { method: 'POST' }
        );
        entryCandidateThumbnails.value = res.candidateThumbnails || [];
        if (entryCandidateThumbnails.value.length === 0) {
          showToast('No additional images were found on that page.', 'warn');
        } else {
          showToast(
            `Captured ${entryCandidateThumbnails.value.length} images from the site — click one to apply.`
          );
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        harvestingEntryImages.value = false;
      }
    }

    async function selectEntryCandidateThumbnail(cand) {
      if (!editingEntry.value || !cand?.dataUrl) return;
      try {
        editingEntry.value.thumbnailDataUrl = cand.dataUrl;
        const updatedVideoInfo = {
          ...(editingEntry.value.videoInfo || {}),
          width: cand.width || editingEntry.value.videoInfo?.width || 480,
          height: cand.height || editingEntry.value.videoInfo?.height || 270,
          thumbnailSource: 'picked-page-image',
        };
        editingEntry.value.videoInfo = updatedVideoInfo;
        await apiFetch(`/api/entries/${editingEntry.value.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            thumbnailDataUrl: cand.dataUrl,
            videoInfo: updatedVideoInfo,
          }),
        });
        showToast('Selected site image saved as thumbnail.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function appendTagToEditingEntry(tagName) {
      if (!editingEntry.value) return;
      const current = editingEntry.value.tagsInput
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!current.includes(tagName)) {
        current.push(tagName);
        editingEntry.value.tagsInput = current.join(', ');
      }
    }

    async function handleDiscoverEntryTags() {
      if (!editingEntry.value || discoveringEntryTags.value) return;
      discoveringEntryTags.value = true;
      try {
        const res = await apiFetch(
          `/api/entries/${editingEntry.value.id}/discover-tags`,
          { method: 'POST' }
        );
        const found = Array.isArray(res.discoveredTags)
          ? res.discoveredTags
          : [];
        if (found.length === 0) {
          showToast('No tag or category links were found on that page.', 'warn');
        } else {
          const current = editingEntry.value.tagsInput
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          const merged = Array.from(new Set([...current, ...found]));
          editingEntry.value.tagsInput = merged.join(', ');
          editingEntry.value.tags = res.entry?.tags || merged;
          showToast(
            `Auto-discovered ${found.length} tag(s)/categor(ies) from page.`
          );
          await loadCatalog();
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        discoveringEntryTags.value = false;
      }
    }

    async function saveEntryEdits() {
      if (!editingEntry.value) return;
      try {
        await apiFetch(`/api/entries/${editingEntry.value.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: editingEntry.value.title,
            folderId: editingEntry.value.folderId || null,
            tags: editingEntry.value.tagsInput,
            notes: editingEntry.value.notes,
            favorite: editingEntry.value.favorite,
          }),
        });
        modals.entry = false;
        showToast('Catalog entry updated.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // Converts any pasted/dropped image Blob into a 480x270 medium JPEG Data URL in memory
    function convertBlobToMediumThumbnail(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read pasted image.'));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error('Invalid image format.'));
          img.onload = () => {
            const W = 480;
            const H = 270;
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, W, H);

            const iw = img.width;
            const ih = img.height;
            const targetRatio = W / H;
            const imgRatio = iw / ih;

            ctx.save();
            ctx.filter = 'blur(16px) brightness(0.45)';
            ctx.drawImage(img, -20, -20, W + 40, H + 40);
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
            ctx.drawImage(img, dx, dy, dw, dh);
            resolve({
              dataUrl: canvas.toDataURL('image/jpeg', 0.86),
              width: iw,
              height: ih,
            });
          };
          img.src = String(reader.result);
        };
        reader.readAsDataURL(blob);
      });
    }

    async function applyCustomThumbnailBlob(blob) {
      if (!editingEntry.value || !blob) return;
      try {
        const { dataUrl, width, height } =
          await convertBlobToMediumThumbnail(blob);
        editingEntry.value.thumbnailDataUrl = dataUrl;
        const updatedVideoInfo = {
          ...(editingEntry.value.videoInfo || {}),
          width: editingEntry.value.videoInfo?.width || width,
          height: editingEntry.value.videoInfo?.height || height,
          thumbnailSource: 'custom-pasted',
          selectionReason: 'Custom pasted thumbnail',
        };
        editingEntry.value.videoInfo = updatedVideoInfo;

        // Immediately save into the encrypted vault
        await apiFetch(`/api/entries/${editingEntry.value.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            thumbnailDataUrl: dataUrl,
            videoInfo: updatedVideoInfo,
          }),
        });
        showToast('Custom thumbnail pasted & saved to encrypted vault.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message || 'Failed to paste thumbnail.', 'error');
      }
    }

    async function handleClipboardButtonPaste() {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        showToast('Press Ctrl+V while this dialog is open to paste an image.', 'warn');
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith('image/'));
          if (imgType) {
            const blob = await item.getType(imgType);
            await applyCustomThumbnailBlob(blob);
            return;
          }
        }
        showToast('No image found on clipboard. Copy an image or take a screenshot (Win+Shift+S) first.', 'warn');
      } catch {
        showToast('Press Ctrl+V directly in this window to paste your clipboard image.', 'warn');
      }
    }

    async function handleThumbnailDrop(event) {
      thumbDragOver.value = false;
      const file = event.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        await applyCustomThumbnailBlob(file);
      } else {
        showToast('Please drop an image file (PNG, JPG, WebP).', 'warn');
      }
    }

    async function handleThumbnailFileSelect(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file && file.type.startsWith('image/')) {
        await applyCustomThumbnailBlob(file);
      }
    }

    function handleWindowPaste(event) {
      if (!modals.entry || !editingEntry.value) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          event.preventDefault();
          const blob = item.getAsFile();
          if (blob) {
            applyCustomThumbnailBlob(blob);
          }
          return;
        }
      }
    }

    async function handleRefreshThumbnail() {
      if (!editingEntry.value || refreshingThumb.value) return;
      refreshingThumb.value = true;
      try {
        const res = await apiFetch(
          `/api/entries/${editingEntry.value.id}/refresh-thumbnail`,
          { method: 'POST' }
        );
        editingEntry.value.thumbnailDataUrl = res.entry.thumbnailDataUrl;
        editingEntry.value.videoInfo = res.entry.videoInfo;
        showToast('Video thumbnail refreshed.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        refreshingThumb.value = false;
      }
    }

    async function handleDeleteSingleEntry() {
      if (!editingEntry.value) return;
      if (!confirm(`Delete "${editingEntry.value.title}" from your catalog?`)) {
        return;
      }
      try {
        await apiFetch(`/api/entries/${editingEntry.value.id}`, {
          method: 'DELETE',
        });
        modals.entry = false;
        showToast('Catalog entry deleted.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function toggleFavorite(entry) {
      try {
        await apiFetch(`/api/entries/${entry.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ favorite: !entry.favorite }),
        });
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // ==================== DRAG & DROP + BULK ACTIONS ====================
    function handleCardDragStart(entry) {
      draggedEntryId.value = entry.id;
    }

    async function handleDropOnFolder(targetFolderId) {
      dragOverFolderId.value = null;
      const entryId = draggedEntryId.value;
      draggedEntryId.value = null;
      if (!entryId) return;

      try {
        await apiFetch(`/api/entries/${entryId}`, {
          method: 'PATCH',
          body: JSON.stringify({ folderId: targetFolderId || null }),
        });
        showToast('Moved entry to folder.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function toggleSelectEntry(entryId) {
      const idx = selectedEntryIds.value.indexOf(entryId);
      if (idx === -1) {
        selectedEntryIds.value.push(entryId);
      } else {
        selectedEntryIds.value.splice(idx, 1);
      }
    }

    function toggleSelectAll(event) {
      if (event.target.checked) {
        selectedEntryIds.value = entries.value.map((e) => e.id);
      } else {
        selectedEntryIds.value = [];
      }
    }

    async function handleBulkMove(event) {
      const val = event.target.value;
      event.target.value = '';
      if (!val || selectedEntryIds.value.length === 0) return;

      const folderId = val === '__none__' ? null : val;
      try {
        await apiFetch('/api/entries/bulk', {
          method: 'POST',
          body: JSON.stringify({
            action: 'move',
            entryIds: selectedEntryIds.value,
            folderId,
          }),
        });
        selectedEntryIds.value = [];
        showToast('Selected entries moved.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function handleBulkAddTag() {
      const rawTag = prompt('Enter tag(s) to add to selected entries (comma-separated):');
      if (!rawTag || !rawTag.trim()) return;
      try {
        await apiFetch('/api/entries/bulk', {
          method: 'POST',
          body: JSON.stringify({
            action: 'tag',
            entryIds: selectedEntryIds.value,
            addTags: rawTag,
          }),
        });
        selectedEntryIds.value = [];
        showToast('Tags added to selected entries.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function handleBulkDelete() {
      if (
        !confirm(
          `Delete ${selectedEntryIds.value.length} selected entries permanently?`
        )
      ) {
        return;
      }
      try {
        await apiFetch('/api/entries/bulk', {
          method: 'POST',
          body: JSON.stringify({
            action: 'delete',
            entryIds: selectedEntryIds.value,
          }),
        });
        selectedEntryIds.value = [];
        showToast('Selected entries deleted.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // ==================== FOLDERS MANAGEMENT ====================
    function openNewFolderModal() {
      folderForm.id = null;
      folderForm.name = '';
      folderForm.parentId = activeUserFolder.value
        ? activeUserFolder.value.id
        : '';
      folderForm.color = '#6366f1';
      modals.folder = true;
    }

    function openEditFolderModal(folder) {
      folderForm.id = folder.id;
      folderForm.name = folder.name;
      folderForm.parentId = folder.parentId || '';
      folderForm.color = folder.color || '#6366f1';
      modals.folder = true;
    }

    async function saveFolder() {
      if (!folderForm.name.trim()) return;
      try {
        if (folderForm.id) {
          await apiFetch(`/api/folders/${folderForm.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name: folderForm.name,
              parentId: folderForm.parentId || null,
              color: folderForm.color,
            }),
          });
          showToast('Folder updated.');
        } else {
          const res = await apiFetch('/api/folders', {
            method: 'POST',
            body: JSON.stringify({
              name: folderForm.name,
              parentId: folderForm.parentId || null,
              color: folderForm.color,
            }),
          });
          activeFolderId.value = res.folder.id;
          showToast('Folder created.');
        }
        modals.folder = false;
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function handleDeleteFolder(folder) {
      if (
        !confirm(
          `Delete folder "${folder.name}"? Entries inside will be kept under Uncategorized.`
        )
      ) {
        return;
      }
      try {
        await apiFetch(`/api/folders/${folder.id}`, { method: 'DELETE' });
        activeFolderId.value = 'all';
        showToast('Folder deleted.');
        await loadCatalog();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function copyEntryUrl(url) {
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        showToast('URL copied to clipboard.');
      } catch {
        showToast('Could not copy URL to clipboard.', 'warn');
      }
    }

    async function openInPrivateWindow(url) {
      if (!url) return;
      try {
        await apiFetch('/api/open-private', {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
        showToast('Opened site in an Incognito/InPrivate browser window.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function formatDate(iso) {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleString();
      } catch {
        return iso;
      }
    }

    // Keyboard shortcut: Ctrl+L locks the vault immediately
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        if (vaultStatus.unlocked) {
          e.preventDefault();
          lockVault();
        }
      }
    }

    onMounted(() => {
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('paste', handleWindowPaste);
      checkVaultStatus();
    });

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handleWindowPaste);
      stopBatchPolling();
    });

    return {
      vaultStatus,
      authForm,
      entries,
      folders,
      orderedFolders,
      folderMap,
      tags,
      summary,
      activeFolderId,
      activeUserFolder,
      currentViewTitle,
      hasActiveFilters,
      selectedTags,
      tagMatchMode,
      searchQuery,
      sortBy,
      viewMode,
      blurThumbnails,
      blurOnStartup,
      paginationMode,
      currentPage,
      totalPages,
      pageStartIndex,
      pageEndIndex,
      displayedEntries,
      entriesScrollRef,
      selectedEntryIds,
      dragOverFolderId,
      quickUrl,
      quickScanning,
      extractionMessage,
      modals,
      singleForm,
      batchForm,
      batchJob,
      batchTab,
      batchBannerDismissed,
      batchProgressPercent,
      filteredBatchItems,
      currentBatchProcessingUrl,
      editingEntry,
      refreshingThumb,
      thumbDragOver,
      entryCandidateThumbnails,
      harvestingEntryImages,
      discoveringEntryTags,
      folderForm,
      passwordForm,
      toasts,
      handleInitializeVault,
      handleUnlockVault,
      lockVault,
      handleChangePassword,
      selectFolder,
      toggleTagFilter,
      toggleTagMatchMode,
      clearAllFilters,
      handleCatalogScroll,
      loadMoreInfinite,
      goToPage,
      handleQuickScanUrl,
      openAddUrlModal,
      submitSingleUrl,
      forceAddSingleUrl,
      openBatchModal,
      handleBatchFileUpload,
      startBatchJob,
      minimizeBatchToBackground,
      dismissBackgroundBatchBanner,
      cancelBatchJob,
      resetBatchModal,
      copySkippedBatchUrls,
      addSkippedBatchItem,
      addAllSkippedBatchItems,
      formatBatchItemStatus,
      openEntryDetail,
      handleHarvestEntryImages,
      selectEntryCandidateThumbnail,
      appendTagToEditingEntry,
      handleDiscoverEntryTags,
      saveEntryEdits,
      handleRefreshThumbnail,
      handleClipboardButtonPaste,
      handleThumbnailDrop,
      handleThumbnailFileSelect,
      handleDeleteSingleEntry,
      toggleFavorite,
      handleCardDragStart,
      handleDropOnFolder,
      toggleSelectEntry,
      toggleSelectAll,
      handleBulkMove,
      handleBulkAddTag,
      handleBulkDelete,
      openNewFolderModal,
      openEditFolderModal,
      saveFolder,
      handleDeleteFolder,
      copyEntryUrl,
      openInPrivateWindow,
      formatDate,
    };
  },
}).mount('#app');
