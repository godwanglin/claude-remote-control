import fs from 'fs';
import path from 'path';
import { ClaudePermissionMode, ClaudeEffortLevel } from './claude-headless.js';
import { getRuntimePaths, ensureRuntimeDirs, projectRoot } from './runtime-paths.js';

export type FollowupMode = 'default' | 'queue' | 'steer';

export interface StoredSettings {
  verbosity: 'detail' | 'compact';
  effort: ClaudeEffortLevel;
  timeoutMs: number;
  notify: 'silent' | 'mention';
  permissionMode: ClaudePermissionMode;
  defaultModel: string;
  sessionModels: Record<string, string>;
  isManualSessionLocked: boolean;
  manualSessionId?: string;
  followupMode: FollowupMode;
}

const DEFAULT_SETTINGS: StoredSettings = {
  verbosity: 'detail',
  effort: 'xhigh',
  timeoutMs: 300_000,
  notify: 'silent',
  permissionMode: 'bypassPermissions',
  defaultModel: 'claude-opus-5-5',
  sessionModels: {},
  isManualSessionLocked: false,
  manualSessionId: undefined,
  followupMode: 'default'
};

class SettingsManager {
  private _settings: StoredSettings = { ...DEFAULT_SETTINGS };

  constructor() {
    this.load();
  }

  public get settings(): StoredSettings {
    return this._settings;
  }

  private _resolveFilePath(): string {
    const paths = ensureRuntimeDirs();
    // Migrasi: jika file settings.json di config/ belum ada tapi di projectRoot ada, salin
    const legacyFile = path.resolve(projectRoot, 'settings.json');
    if (!fs.existsSync(paths.settingsFile) && fs.existsSync(legacyFile)) {
      try {
        fs.copyFileSync(legacyFile, paths.settingsFile);
      } catch (_) {}
    }
    return paths.settingsFile;
  }

  /**
   * Membaca pengaturan dari file settings.json di config runtime
   */
  public load(): StoredSettings {
    const targetFile = this._resolveFilePath();
    try {
      if (fs.existsSync(targetFile)) {
        const raw = fs.readFileSync(targetFile, 'utf8');
        const parsed = JSON.parse(raw);
        this._settings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          sessionModels: {
            ...DEFAULT_SETTINGS.sessionModels,
            ...(parsed.sessionModels || {})
          }
        };
        const timeoutDesc = this._settings.timeoutMs === 0 ? 'Infinity' : `${this._settings.timeoutMs / 60000}m`;
        console.log(`\x1b[32m[Settings]\x1b[0m Memuat pengaturan dari settings.json: Tampilan=${this._settings.verbosity}, Effort=${this._settings.effort}, Timeout=${timeoutDesc}, Izin=${this._settings.permissionMode}`);
      } else {
        this.save(); // Inisialisasi default settings.json
      }
    } catch (err: any) {
      console.warn(`[Settings Warning] Gagal membaca settings.json:`, err.message);
    }
    return this._settings;
  }

  /**
   * Menyimpan perubahan pengaturan ke settings.json
   */
  public save(partial?: Partial<StoredSettings>): void {
    const targetFile = this._resolveFilePath();
    if (partial) {
      this._settings = {
        ...this._settings,
        ...partial,
        sessionModels: {
          ...this._settings.sessionModels,
          ...(partial.sessionModels || {})
        }
      };
    }

    try {
      fs.writeFileSync(targetFile, JSON.stringify(this._settings, null, 2), 'utf8');
      
      // Jika mode dev, sinkronkan juga ke projectRoot/settings.json agar transparan
      const legacyFile = path.resolve(projectRoot, 'settings.json');
      if (fs.existsSync(legacyFile)) {
        try {
          fs.writeFileSync(legacyFile, JSON.stringify(this._settings, null, 2), 'utf8');
        } catch (_) {}
      }
    } catch (err: any) {
      console.warn(`[Settings Warning] Gagal menyimpan settings.json:`, err.message);
    }
  }

  public update<K extends keyof StoredSettings>(key: K, value: StoredSettings[K]): void {
    this._settings[key] = value;
    this.save();
  }

  public setSessionModel(sessionId: string, modelId: string): void {
    this._settings.sessionModels[sessionId] = modelId;
    this.save();
  }

  public getSessionModel(sessionId?: string): string {
    if (sessionId && this._settings.sessionModels[sessionId]) {
      return this._settings.sessionModels[sessionId];
    }
    return this._settings.defaultModel || 'claude-opus-5-5';
  }
}

export const settingsManager = new SettingsManager();
