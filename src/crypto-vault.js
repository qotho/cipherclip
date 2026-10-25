const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const MAGIC_HEADER = Buffer.from('CCVAULT1', 'ascii'); // 8 bytes
const FORMAT_VERSION = 1;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Default scrypt parameters (strong interactive security)
const SCRYPT_PARAMS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

/**
 * Resolves the single-user local application data directory for the current Windows user.
 * Ensures the catalog is stored strictly inside the current user's profile and not shared across accounts.
 */
function getDefaultVaultDir() {
  if (process.env.CIPHERCLIP_VAULT_DIR) {
    return path.resolve(process.env.CIPHERCLIP_VAULT_DIR);
  }
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'CipherClip');
}

function getDefaultVaultPath() {
  return path.join(getDefaultVaultDir(), 'catalog.vault');
}

function deriveKey(password, salt, params = SCRYPT_PARAMS) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A non-empty password is required.');
  }
  return crypto.scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem || 64 * 1024 * 1024,
  });
}

/**
 * Encrypts a JavaScript object into a binary envelope using AES-256-GCM + Gzip.
 * Envelope layout:
 *   [0..7]   Magic "CCVAULT1" (8B)
 *   [8]      Version (1B)
 *   [9..12]  scrypt N (uint32BE, 4B)
 *   [13]     scrypt r (uint8, 1B)
 *   [14]     scrypt p (uint8, 1B)
 *   [15..46] Salt (32B)
 *   [47..58] IV (12B)
 *   [59..74] AuthTag (16B)
 *   [75..]   Ciphertext
 */
function encryptPayload(dataObj, key, salt, params = SCRYPT_PARAMS) {
  const jsonBytes = Buffer.from(JSON.stringify(dataObj), 'utf8');
  const compressed = zlib.gzipSync(jsonBytes, { level: 6 });

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const header = Buffer.alloc(8 + 1 + 4 + 1 + 1);
  MAGIC_HEADER.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 8);
  header.writeUInt32BE(params.N, 9);
  header.writeUInt8(params.r, 13);
  header.writeUInt8(params.p, 14);

  return Buffer.concat([header, salt, iv, authTag, encrypted]);
}

/**
 * Parses and decrypts a binary vault envelope with the user's password (or pre-derived key).
 */
function decryptEnvelope(buffer, passwordOrKey) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 75) {
    throw new Error('Invalid or corrupted vault file (too small).');
  }

  const magic = buffer.subarray(0, 8);
  if (!magic.equals(MAGIC_HEADER)) {
    throw new Error('Invalid vault file header.');
  }

  const version = buffer.readUInt8(8);
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported vault format version: ${version}`);
  }

  const N = buffer.readUInt32BE(9);
  const r = buffer.readUInt8(13);
  const p = buffer.readUInt8(14);
  const salt = Buffer.from(buffer.subarray(15, 47));
  const iv = buffer.subarray(47, 59);
  const authTag = buffer.subarray(59, 75);
  const ciphertext = buffer.subarray(75);

  const params = { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) };
  const key = Buffer.isBuffer(passwordOrKey)
    ? passwordOrKey
    : deriveKey(passwordOrKey, salt, params);

  let compressed;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    if (!Buffer.isBuffer(passwordOrKey)) {
      key.fill(0);
    }
    const err = new Error('Incorrect password or tampered vault file.');
    err.code = 'INVALID_PASSWORD';
    throw err;
  }

  const jsonBytes = zlib.gunzipSync(compressed);
  const data = JSON.parse(jsonBytes.toString('utf8'));
  return { data, key, salt, params };
}

function normalizeTag(tag) {
  return String(tag || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeTagList(tags) {
  if (!tags) return [];
  const rawList = Array.isArray(tags)
    ? tags
    : String(tags)
        .split(',')
        .map((s) => s.trim());
  const seen = new Set();
  const result = [];
  for (const item of rawList) {
    const cleaned = normalizeTag(item);
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

class CryptoVault {
  constructor(vaultPath = getDefaultVaultPath()) {
    this.vaultPath = vaultPath;
    this.vaultDir = path.dirname(vaultPath);
    this._key = null;
    this._salt = null;
    this._params = { ...SCRYPT_PARAMS };
    this._data = null;
    this._lastActivity = 0;
    this.autoLockMs = 30 * 60 * 1000; // 30 minutes default inactivity auto-lock
  }

  exists() {
    return fs.existsSync(this.vaultPath);
  }

  isUnlocked() {
    if (!this._key || !this._data) return false;
    if (
      this.autoLockMs > 0 &&
      this._lastActivity > 0 &&
      Date.now() - this._lastActivity > this.autoLockMs
    ) {
      this.lock();
      return false;
    }
    return true;
  }

  touch() {
    this._lastActivity = Date.now();
  }

  getStatus() {
    let vaultSizeBytes = 0;
    let lastModified = null;
    if (this.exists()) {
      try {
        const stat = fs.statSync(this.vaultPath);
        vaultSizeBytes = stat.size;
        lastModified = stat.mtime.toISOString();
      } catch {
        // ignore stat error
      }
    }
    const unlocked = this.isUnlocked();
    const userAccount =
      process.env.USERNAME ||
      path.basename(os.homedir()) ||
      os.userInfo().username;
    return {
      initialized: this.exists(),
      unlocked,
      vaultPath: this.vaultPath,
      userAccount,
      encryption: 'AES-256-GCM + scrypt (N=32768, r=8, p=1)',
      vaultSizeBytes,
      lastModified,
      entryCount: unlocked ? this._data.entries.length : null,
      folderCount: unlocked ? this._data.folders.length : null,
      autoLockMinutes: Math.round(this.autoLockMs / 60000),
    };
  }

  _ensureDirectory() {
    if (!fs.existsSync(this.vaultDir)) {
      fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    }
  }

  _createEmptyCatalog() {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      folders: [
        {
          id: 'fld_tutorials',
          name: 'Tutorials & Guides',
          color: '#6366f1',
          parentId: null,
          createdAt: now,
        },
        {
          id: 'fld_research',
          name: 'Research & Clips',
          color: '#10b981',
          parentId: null,
          createdAt: now,
        },
        {
          id: 'fld_watch_later',
          name: 'Watch Later',
          color: '#f59e0b',
          parentId: null,
          createdAt: now,
        },
      ],
      entries: [],
    };
  }

  /**
   * Initializes a brand new encrypted vault with the given master password.
   */
  initialize(password) {
    if (this.exists()) {
      throw new Error('Vault already exists at this location.');
    }
    if (typeof password !== 'string' || password.length < 4) {
      throw new Error('Password must be at least 4 characters long.');
    }
    this._ensureDirectory();
    this._salt = crypto.randomBytes(SALT_LENGTH);
    this._params = { ...SCRYPT_PARAMS };
    this._key = deriveKey(password, this._salt, this._params);
    this._data = this._createEmptyCatalog();
    this._saveToDisk();
    this.touch();
    return this.getStatus();
  }

  /**
   * Unlocks an existing vault using the user's password.
   */
  unlock(password) {
    if (!this.exists()) {
      throw new Error('Vault has not been initialized yet.');
    }
    const raw = fs.readFileSync(this.vaultPath);
    const { data, key, salt, params } = decryptEnvelope(raw, password);

    if (this._key) {
      this._key.fill(0);
    }
    this._key = key;
    this._salt = salt;
    this._params = params;
    this._data = {
      schemaVersion: data.schemaVersion || 1,
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: data.updatedAt || new Date().toISOString(),
      folders: Array.isArray(data.folders) ? data.folders : [],
      entries: Array.isArray(data.entries) ? data.entries : [],
    };
    this.touch();
    return this.getStatus();
  }

  /**
   * Wipes the key and decrypted data from memory.
   */
  lock() {
    if (this._key) {
      this._key.fill(0);
      this._key = null;
    }
    this._salt = null;
    this._data = null;
    this._lastActivity = 0;
  }

  /**
   * Changes the vault encryption password, generating a fresh salt and re-encrypting.
   */
  changePassword(currentPassword, newPassword) {
    this._requireUnlocked();
    if (typeof newPassword !== 'string' || newPassword.length < 4) {
      throw new Error('New password must be at least 4 characters long.');
    }
    // Verify current password against on-disk vault
    const raw = fs.readFileSync(this.vaultPath);
    const verify = decryptEnvelope(raw, currentPassword);
    verify.key.fill(0);

    const newSalt = crypto.randomBytes(SALT_LENGTH);
    const newKey = deriveKey(newPassword, newSalt, SCRYPT_PARAMS);

    if (this._key) {
      this._key.fill(0);
    }
    this._salt = newSalt;
    this._key = newKey;
    this._params = { ...SCRYPT_PARAMS };
    this._saveToDisk();
    this.touch();
  }

  _requireUnlocked() {
    if (!this.isUnlocked()) {
      const err = new Error('Vault is locked. Please unlock with your password.');
      err.code = 'VAULT_LOCKED';
      throw err;
    }
    this.touch();
  }

  _saveToDisk() {
    if (!this._key || !this._salt || !this._data) {
      throw new Error('Cannot save locked vault.');
    }
    this._ensureDirectory();
    this._data.updatedAt = new Date().toISOString();
    const encryptedBuffer = encryptPayload(
      this._data,
      this._key,
      this._salt,
      this._params
    );
    const tmpPath = `${this.vaultPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, encryptedBuffer, { mode: 0o600 });
    fs.renameSync(tmpPath, this.vaultPath);
  }

  // ==================== FOLDERS ====================

  listFolders() {
    this._requireUnlocked();
    const counts = new Map();
    let uncategorizedCount = 0;
    let favoritesCount = 0;

    for (const entry of this._data.entries) {
      if (entry.favorite) favoritesCount++;
      if (entry.folderId) {
        counts.set(entry.folderId, (counts.get(entry.folderId) || 0) + 1);
      } else {
        uncategorizedCount++;
      }
    }

    const folders = this._data.folders.map((f) => ({
      ...f,
      entryCount: counts.get(f.id) || 0,
    }));

    return {
      folders,
      summary: {
        totalCount: this._data.entries.length,
        uncategorizedCount,
        favoritesCount,
      },
    };
  }

  createFolder({ name, color = '#6366f1', parentId = null }) {
    this._requireUnlocked();
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      throw new Error('Folder name is required.');
    }
    if (parentId && !this._data.folders.some((f) => f.id === parentId)) {
      parentId = null;
    }
    const existing = this._data.folders.find(
      (f) =>
        f.name.toLowerCase() === trimmed.toLowerCase() &&
        (f.parentId || null) === (parentId || null)
    );
    if (existing) {
      throw new Error(`A folder named "${trimmed}" already exists.`);
    }

    const folder = {
      id: `fld_${crypto.randomBytes(6).toString('hex')}`,
      name: trimmed,
      color: color || '#6366f1',
      parentId: parentId || null,
      createdAt: new Date().toISOString(),
    };
    this._data.folders.push(folder);
    this._saveToDisk();
    return folder;
  }

  updateFolder(folderId, { name, color, parentId }) {
    this._requireUnlocked();
    const folder = this._data.folders.find((f) => f.id === folderId);
    if (!folder) {
      throw new Error('Folder not found.');
    }
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) throw new Error('Folder name cannot be empty.');
      folder.name = trimmed;
    }
    if (color !== undefined) {
      folder.color = color;
    }
    if (parentId !== undefined && parentId !== folder.id) {
      folder.parentId = parentId || null;
    }
    this._saveToDisk();
    return folder;
  }

  deleteFolder(folderId) {
    this._requireUnlocked();
    const idx = this._data.folders.findIndex((f) => f.id === folderId);
    if (idx === -1) {
      throw new Error('Folder not found.');
    }
    const removed = this._data.folders[idx];
    this._data.folders.splice(idx, 1);

    // Re-parent any child folders and unassign entries in this folder
    for (const f of this._data.folders) {
      if (f.parentId === folderId) {
        f.parentId = removed.parentId || null;
      }
    }
    for (const entry of this._data.entries) {
      if (entry.folderId === folderId) {
        entry.folderId = null;
      }
    }
    this._saveToDisk();
    return { deletedId: folderId };
  }

  // ==================== TAGS ====================

  listTags() {
    this._requireUnlocked();
    const tagCounts = new Map();
    for (const entry of this._data.entries) {
      if (Array.isArray(entry.tags)) {
        for (const tag of entry.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
    }
    return Array.from(tagCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // ==================== ENTRIES ====================

  listEntries(filters = {}) {
    this._requireUnlocked();
    const {
      search = '',
      folderId = null, // 'all', 'uncategorized', 'favorites', or specific folder ID
      tags = [],
      tagMatchMode = 'all', // 'all' (AND) or 'any' (OR)
      sortBy = 'newest',
    } = filters;

    const normalizedFilterTags = normalizeTagList(tags);
    const query = String(search || '')
      .trim()
      .toLowerCase();
    const queryTerms = query ? query.split(/\s+/) : [];

    let results = this._data.entries.filter((entry) => {
      // Folder filter
      if (folderId === 'uncategorized') {
        if (entry.folderId) return false;
      } else if (folderId === 'favorites') {
        if (!entry.favorite) return false;
      } else if (folderId && folderId !== 'all') {
        // Match folderId or any child folder of folderId
        const matchingFolderIds = this._getDescendantFolderIds(folderId);
        if (!matchingFolderIds.has(entry.folderId)) return false;
      }

      // Explicit tag filter pills
      if (normalizedFilterTags.length > 0) {
        const entryTagSet = new Set(entry.tags || []);
        if (tagMatchMode === 'any') {
          if (!normalizedFilterTags.some((t) => entryTagSet.has(t))) {
            return false;
          }
        } else {
          if (!normalizedFilterTags.every((t) => entryTagSet.has(t))) {
            return false;
          }
        }
      }

      // Search query across tags, title, URL, domain, notes
      if (queryTerms.length > 0) {
        const searchableText = [
          ...(entry.tags || []).map((t) => `#${t} ${t}`),
          entry.title || '',
          entry.url || '',
          entry.domain || '',
          entry.notes || '',
          entry.videoInfo?.provider || '',
        ]
          .join(' ')
          .toLowerCase();

        for (const term of queryTerms) {
          const cleanTerm = term.startsWith('#') ? term.slice(1) : term;
          if (term.startsWith('#')) {
            // Strict tag prefix/substring match when searching with #tag
            if (!(entry.tags || []).some((t) => t.includes(cleanTerm))) {
              return false;
            }
          } else if (!searchableText.includes(cleanTerm)) {
            return false;
          }
        }
      }

      return true;
    });

    // Sort results
    results.sort((a, b) => {
      if (sortBy === 'oldest') {
        return new Date(a.createdAt) - new Date(b.createdAt);
      }
      if (sortBy === 'title') {
        return (a.title || '').localeCompare(b.title || '');
      }
      if (sortBy === 'domain') {
        return (a.domain || '').localeCompare(b.domain || '');
      }
      if (sortBy === 'resolution') {
        const areaA = (a.videoInfo?.width || 0) * (a.videoInfo?.height || 0);
        const areaB = (b.videoInfo?.width || 0) * (b.videoInfo?.height || 0);
        return areaB - areaA;
      }
      // Default: newest
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return results;
  }

  _getDescendantFolderIds(rootFolderId) {
    const ids = new Set([rootFolderId]);
    let added = true;
    while (added) {
      added = false;
      for (const f of this._data.folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          added = true;
        }
      }
    }
    return ids;
  }

  getEntry(entryId) {
    this._requireUnlocked();
    return this._data.entries.find((e) => e.id === entryId) || null;
  }

  addEntry({
    url,
    finalUrl,
    title,
    domain,
    thumbnailDataUrl,
    tags = [],
    folderId = null,
    notes = '',
    favorite = false,
    videoInfo = {},
  }) {
    this._requireUnlocked();
    const now = new Date().toISOString();

    if (folderId && !this._data.folders.some((f) => f.id === folderId)) {
      folderId = null;
    }

    const entry = {
      id: `vid_${crypto.randomBytes(8).toString('hex')}`,
      url: String(url || '').trim(),
      finalUrl: String(finalUrl || url || '').trim(),
      title: String(title || url || 'Untitled Video').trim(),
      domain: String(domain || '').trim(),
      thumbnailDataUrl: thumbnailDataUrl || null,
      tags: normalizeTagList(tags),
      folderId: folderId || null,
      notes: String(notes || '').trim(),
      favorite: Boolean(favorite),
      videoInfo: {
        type: videoInfo.type || 'video',
        provider: videoInfo.provider || domain || 'Web',
        width: Number(videoInfo.width) || 0,
        height: Number(videoInfo.height) || 0,
        durationSeconds: Number(videoInfo.durationSeconds) || null,
        totalVideosOnPage: Number(videoInfo.totalVideosOnPage) || 1,
        videoSrc: videoInfo.videoSrc || null,
        selectionReason: videoInfo.selectionReason || 'Main video on page',
        thumbnailSource: videoInfo.thumbnailSource || 'element-capture',
      },
      createdAt: now,
      updatedAt: now,
    };

    this._data.entries.unshift(entry);
    this._saveToDisk();
    return entry;
  }

  updateEntry(entryId, updates = {}) {
    this._requireUnlocked();
    const entry = this._data.entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new Error('Catalog entry not found.');
    }

    if (updates.title !== undefined) {
      entry.title = String(updates.title).trim() || entry.url;
    }
    if (updates.tags !== undefined) {
      entry.tags = normalizeTagList(updates.tags);
    }
    if (updates.folderId !== undefined) {
      const validFolder =
        updates.folderId &&
        this._data.folders.some((f) => f.id === updates.folderId)
          ? updates.folderId
          : null;
      entry.folderId = validFolder;
    }
    if (updates.notes !== undefined) {
      entry.notes = String(updates.notes).trim();
    }
    if (updates.favorite !== undefined) {
      entry.favorite = Boolean(updates.favorite);
    }
    if (updates.thumbnailDataUrl !== undefined) {
      entry.thumbnailDataUrl = updates.thumbnailDataUrl;
    }
    if (updates.videoInfo !== undefined) {
      entry.videoInfo = { ...entry.videoInfo, ...updates.videoInfo };
    }

    entry.updatedAt = new Date().toISOString();
    this._saveToDisk();
    return entry;
  }

  bulkUpdateEntries(entryIds, { folderId, addTags, removeTags, favorite }) {
    this._requireUnlocked();
    const idSet = new Set(Array.isArray(entryIds) ? entryIds : []);
    const tagsToAdd = normalizeTagList(addTags);
    const tagsToRemove = new Set(normalizeTagList(removeTags));
    let updatedCount = 0;
    const now = new Date().toISOString();

    for (const entry of this._data.entries) {
      if (!idSet.has(entry.id)) continue;
      if (folderId !== undefined) {
        entry.folderId =
          folderId && this._data.folders.some((f) => f.id === folderId)
            ? folderId
            : null;
      }
      if (tagsToAdd.length > 0 || tagsToRemove.size > 0) {
        const merged = normalizeTagList([...(entry.tags || []), ...tagsToAdd]);
        entry.tags = merged.filter((t) => !tagsToRemove.has(t));
      }
      if (favorite !== undefined) {
        entry.favorite = Boolean(favorite);
      }
      entry.updatedAt = now;
      updatedCount++;
    }

    if (updatedCount > 0) {
      this._saveToDisk();
    }
    return { updatedCount };
  }

  deleteEntries(entryIds) {
    this._requireUnlocked();
    const idSet = new Set(
      Array.isArray(entryIds) ? entryIds : [entryIds]
    );
    const before = this._data.entries.length;
    this._data.entries = this._data.entries.filter((e) => !idSet.has(e.id));
    const deletedCount = before - this._data.entries.length;
    if (deletedCount > 0) {
      this._saveToDisk();
    }
    return { deletedCount };
  }
}

module.exports = {
  CryptoVault,
  getDefaultVaultDir,
  getDefaultVaultPath,
  encryptPayload,
  decryptEnvelope,
  normalizeTagList,
};
