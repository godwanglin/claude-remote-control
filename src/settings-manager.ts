import fs from 'fs';
import path from 'path';
import { ClaudePermissionMode, ClaudeEffortLevel } from './claude-headless.js';
import { getRuntimePaths, ensureRuntimeDirs, projectRoot } from './runtime-paths.js';

export type FollowupMode = 'default' | 'queue' | 'steer';

export interface SessionScopedSettings {
  model?: string;
  permissionMode?: ClaudePermissionMode;
  effort?: ClaudeEffortLevel;
  timeoutMs?: number;
}

export interface ResolvedSessionConfig {
  sessionId?: string;
  model: string;
  isModelOverridden: boolean;
  permissionMode: ClaudePermissionMode;
  isPermissionOverridden: boolean;
  effort: ClaudeEffortLevel;
  isEffortOverridden: boolean;
  timeoutMs: number;
  isTimeoutOverridden: boolean;
  verbosity: 'detail' | 'compact';
  followupMode: FollowupMode;
  notify: 'silent' | 'mention';
}

export interface ModelOption {
  id: string;
  name: string;
  desc?: string;
}

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', desc: 'Paling mumpuni untuk pekerjaan ambisius.' },
  { id: 'claude-opus-4-6', name: 'Opus 4.6', desc: 'Model Claude Opus 4.6 standar.' }
];

export interface StoredSettings {
  verbosity: 'detail' | 'compact';
  effort: ClaudeEffortLevel;
  timeoutMs: number;
  notify: 'silent' | 'mention';
  permissionMode: ClaudePermissionMode;
  defaultModel: string;
  models?: ModelOption[];
  sessionModels: Record<string, string>;
  sessionSettings: Record<string, SessionScopedSettings>;
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
  models: DEFAULT_MODELS,
  sessionModels: {},
  sessionSettings: {},
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
          },
          sessionSettings: {
            ...DEFAULT_SETTINGS.sessionSettings,
            ...(parsed.sessionSettings || {})
          }
        };

        // Migrasi backwards-compatibility dari sessionModels ke sessionSettings
        for (const [sId, mId] of Object.entries(this._settings.sessionModels)) {
          if (!this._settings.sessionSettings[sId]) {
            this._settings.sessionSettings[sId] = {};
          }
          if (!this._settings.sessionSettings[sId].model) {
            this._settings.sessionSettings[sId].model = mId;
          }
        }

        const timeoutDesc = this._settings.timeoutMs === 0 ? 'Infinity' : `${this._settings.timeoutMs / 60000}m`;
        if (process.env.CRC_VERBOSE === '1' || process.argv.includes('--verbose')) {
          console.log(`\x1b[32m[Settings]\x1b[0m Memuat pengaturan dari settings.json: Tampilan=${this._settings.verbosity}, Effort=${this._settings.effort}, Timeout=${timeoutDesc}, Izin=${this._settings.permissionMode}`);
        }
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
        },
        sessionSettings: {
          ...this._settings.sessionSettings,
          ...(partial.sessionSettings || {})
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

  /**
   * Mengambil konfigurasi sesi lengkap (Cascading: Global di-override oleh Session Settings)
   */
  public getSessionConfig(sessionId?: string): ResolvedSessionConfig {
    const sOverride = sessionId ? this._settings.sessionSettings?.[sessionId] : undefined;
    const legacyModel = sessionId ? this._settings.sessionModels?.[sessionId] : undefined;

    const model = sOverride?.model || legacyModel || this._settings.defaultModel || this.getModels()[0]?.id || 'claude-opus-5-5';
    const isModelOverridden = !!(sOverride?.model || legacyModel);

    const permissionMode = sOverride?.permissionMode || this._settings.permissionMode || 'bypassPermissions';
    const isPermissionOverridden = !!sOverride?.permissionMode;

    const effort = sOverride?.effort || this._settings.effort || 'xhigh';
    const isEffortOverridden = !!sOverride?.effort;

    const timeoutMs = sOverride?.timeoutMs !== undefined ? sOverride.timeoutMs : this._settings.timeoutMs;
    const isTimeoutOverridden = sOverride?.timeoutMs !== undefined;

    return {
      sessionId,
      model,
      isModelOverridden,
      permissionMode,
      isPermissionOverridden,
      effort,
      isEffortOverridden,
      timeoutMs,
      isTimeoutOverridden,
      verbosity: this._settings.verbosity,
      followupMode: this._settings.followupMode,
      notify: this._settings.notify
    };
  }

  /**
   * Mengatur nilai setelan khusus untuk satu sesi tertentu
   */
  public setSessionSetting<K extends keyof SessionScopedSettings>(sessionId: string, key: K, value: SessionScopedSettings[K]): void {
    if (!this._settings.sessionSettings) {
      this._settings.sessionSettings = {};
    }
    if (!this._settings.sessionSettings[sessionId]) {
      this._settings.sessionSettings[sessionId] = {};
    }
    this._settings.sessionSettings[sessionId][key] = value;
    if (key === 'model' && typeof value === 'string') {
      this._settings.sessionModels[sessionId] = value;
    }
    this.save();
  }

  /**
   * Menghapus seluruh setelan khusus sesi agar 100% kembali mengikuti Global Settings
   */
  public clearSessionSettings(sessionId: string): void {
    if (this._settings.sessionSettings && this._settings.sessionSettings[sessionId]) {
      delete this._settings.sessionSettings[sessionId];
    }
    if (this._settings.sessionModels && this._settings.sessionModels[sessionId]) {
      delete this._settings.sessionModels[sessionId];
    }
    this.save();
  }

  public setSessionModel(sessionId: string, modelId: string): void {
    this.setSessionSetting(sessionId, 'model', modelId);
  }

  public getSessionModel(sessionId?: string): string {
    return this.getSessionConfig(sessionId).model;
  }

  public getSessionPermission(sessionId?: string): ClaudePermissionMode {
    return this.getSessionConfig(sessionId).permissionMode;
  }

  /**
   * Mengambil daftar model AI Claude yang terdaftar
   */
  public getModels(): ModelOption[] {
    if (this._settings.models && Array.isArray(this._settings.models) && this._settings.models.length > 0) {
      return this._settings.models;
    }
    return [...DEFAULT_MODELS];
  }

  /**
   * Menambah model baru atau memperbarui nama/deskripsi bila ID sudah ada
   */
  public addModel(model: ModelOption): { success: boolean; model: ModelOption; message: string } {
    if (!model.id || !model.id.trim()) {
      return { success: false, model, message: 'Model ID tidak boleh kosong.' };
    }
    const cleanId = model.id.trim();
    const cleanName = (model.name || cleanId).trim();
    const cleanDesc = (model.desc || `Model ${cleanName}`).trim();

    if (!this._settings.models || !Array.isArray(this._settings.models)) {
      this._settings.models = [...this.getModels()];
    }

    const existingIndex = this._settings.models.findIndex(m => m.id.toLowerCase() === cleanId.toLowerCase());
    const modelObj: ModelOption = { id: cleanId, name: cleanName, desc: cleanDesc };

    if (existingIndex >= 0) {
      this._settings.models[existingIndex] = modelObj;
    } else {
      this._settings.models.push(modelObj);
    }

    this.save();
    return { 
      success: true, 
      model: modelObj, 
      message: existingIndex >= 0 ? `Model "${cleanName}" (${cleanId}) berhasil diperbarui.` : `Model "${cleanName}" (${cleanId}) berhasil ditambahkan.` 
    };
  }

  /**
   * Menghapus model berdasarkan ID atau nomor urut
   */
  public removeModel(idOrIndex: string): { success: boolean; removed?: ModelOption; message: string } {
    if (!this._settings.models || !Array.isArray(this._settings.models)) {
      this._settings.models = [...this.getModels()];
    }

    if (this._settings.models.length <= 1) {
      return { success: false, message: 'Tidak dapat menghapus model terakhir. Minimal harus ada 1 model terdaftar.' };
    }

    const query = idOrIndex.trim().toLowerCase();
    let index = -1;

    // Cek apakah query adalah nomor urut (1-based index)
    const num = parseInt(query, 10);
    if (!isNaN(num) && num >= 1 && num <= this._settings.models.length) {
      index = num - 1;
    } else {
      index = this._settings.models.findIndex(m => m.id.toLowerCase() === query || m.name.toLowerCase() === query);
    }

    if (index < 0) {
      return { success: false, message: `Model "${idOrIndex}" tidak ditemukan dalam daftar.` };
    }

    const [removed] = this._settings.models.splice(index, 1);

    // Jika model yang dihapus adalah defaultModel, ganti default ke model pertama yang tersisa
    if (this._settings.defaultModel.toLowerCase() === removed.id.toLowerCase()) {
      this._settings.defaultModel = this._settings.models[0].id;
    }

    this.save();
    return { success: true, removed, message: `Model "${removed.name}" (${removed.id}) berhasil dihapus.` };
  }

  /**
   * Mengatur model default global
   */
  public setDefaultModel(idOrIndex: string): { success: boolean; model?: ModelOption; message: string } {
    const models = this.getModels();
    const query = idOrIndex.trim().toLowerCase();
    let target = models.find(m => m.id.toLowerCase() === query || m.name.toLowerCase() === query);

    if (!target) {
      const num = parseInt(query, 10);
      if (!isNaN(num) && num >= 1 && num <= models.length) {
        target = models[num - 1];
      }
    }

    if (!target) {
      return { success: false, message: `Model "${idOrIndex}" tidak valid atau belum terdaftar.` };
    }

    this._settings.defaultModel = target.id;
    this.save();
    return { success: true, model: target, message: `Model default diubah menjadi: ${target.name} (${target.id})` };
  }
}

export const settingsManager = new SettingsManager();
