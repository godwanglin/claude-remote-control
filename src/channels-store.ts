import fs from 'fs';
import path from 'path';
import { getRuntimePaths, ensureRuntimeDirs } from './runtime-paths.js';

export interface CategoryEntry {
  categoryId: string;
  categoryName: string;
  guildId: string;
  projectFolder: string;
  updatedAt: number;
}

export interface ChannelEntry {
  channelId: string;
  sessionId: string;
  sessionTitle: string;
  projectFolder: string;
  channelName: string;
  categoryId: string;
  guildId: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface ChannelsStoreData {
  version: number;
  updatedAt: number;
  categories: Record<string, CategoryEntry>; // key: projectFolder (case-insensitive normalized)
  channels: Record<string, ChannelEntry>;     // key: channelId
}

const DEFAULT_STORE: ChannelsStoreData = {
  version: 1,
  updatedAt: Date.now(),
  categories: {},
  channels: {}
};

function normalizeKey(folder: string): string {
  return path.normalize(folder).toLowerCase();
}

/**
 * Membaca data store channels.json dari disk
 */
export function loadChannelsStore(): ChannelsStoreData {
  const paths = ensureRuntimeDirs();
  if (!fs.existsSync(paths.channelsFile)) {
    return { ...DEFAULT_STORE, categories: {}, channels: {} };
  }

  try {
    const raw = fs.readFileSync(paths.channelsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        version: parsed.version || 1,
        updatedAt: parsed.updatedAt || Date.now(),
        categories: parsed.categories || {},
        channels: parsed.channels || {}
      };
    }
  } catch (err: any) {
    console.warn(`[ChannelsStore Warn] Gagal membaca channels.json:`, err.message);
  }

  return { ...DEFAULT_STORE, categories: {}, channels: {} };
}

/**
 * Menyimpan data store channels.json ke disk secara aman
 */
export function saveChannelsStore(data: ChannelsStoreData): void {
  const paths = ensureRuntimeDirs();
  data.updatedAt = Date.now();
  const content = JSON.stringify(data, null, 2);

  // Penulisan atomik via temp file
  const tmpFile = `${paths.channelsFile}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    fs.renameSync(tmpFile, paths.channelsFile);
  } catch (err: any) {
    try {
      fs.writeFileSync(paths.channelsFile, content, 'utf8');
    } catch (_) {}
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
}

/**
 * Ambil entry channel berdasarkan Discord Channel ID ($O(1)$)
 */
export function getChannelByChannelId(channelId: string): ChannelEntry | undefined {
  const store = loadChannelsStore();
  return store.channels[channelId];
}

/**
 * Ambil entry channel berdasarkan Claude Session ID
 */
export function getChannelBySessionId(sessionId: string): ChannelEntry | undefined {
  const store = loadChannelsStore();
  for (const [, ch] of Object.entries(store.channels)) {
    if (ch.sessionId === sessionId) {
      return ch;
    }
  }
  return undefined;
}

/**
 * Ambil kategori yang cocok untuk path proyek tertentu
 */
export function getCategoryByProjectFolder(projectFolder: string): CategoryEntry | undefined {
  const store = loadChannelsStore();
  const key = normalizeKey(projectFolder);
  for (const [folderKey, cat] of Object.entries(store.categories)) {
    if (normalizeKey(folderKey) === key) {
      return cat;
    }
  }
  return undefined;
}

/**
 * Tambah atau update kategori proyek
 */
export function setCategoryEntry(entry: Omit<CategoryEntry, 'updatedAt'>): void {
  const store = loadChannelsStore();
  const key = entry.projectFolder;
  store.categories[key] = {
    ...entry,
    updatedAt: Date.now()
  };
  saveChannelsStore(store);
}

/**
 * Tambah atau update channel sesi
 */
export function setChannelEntry(entry: Omit<ChannelEntry, 'lastActiveAt'> & { lastActiveAt?: number }): void {
  const store = loadChannelsStore();
  store.channels[entry.channelId] = {
    ...entry,
    lastActiveAt: entry.lastActiveAt || Date.now()
  };
  saveChannelsStore(store);
}

/**
 * Hapus channel dari store
 */
export function removeChannelEntry(channelId: string): void {
  const store = loadChannelsStore();
  if (store.channels[channelId]) {
    delete store.channels[channelId];
    saveChannelsStore(store);
  }
}

/**
 * Hapus kategori dari store
 */
export function removeCategoryEntry(projectFolder: string): void {
  const store = loadChannelsStore();
  const key = normalizeKey(projectFolder);
  for (const [folderKey] of Object.entries(store.categories)) {
    if (normalizeKey(folderKey) === key) {
      delete store.categories[folderKey];
      saveChannelsStore(store);
      break;
    }
  }
}

/**
 * Update timestamp aktivitas terakhir pada channel
 */
export function touchChannelActivity(channelId: string): void {
  const store = loadChannelsStore();
  if (store.channels[channelId]) {
    store.channels[channelId].lastActiveAt = Date.now();
    saveChannelsStore(store);
  }
}
