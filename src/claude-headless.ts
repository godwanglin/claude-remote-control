import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export type ClaudePermissionMode = 
  | 'bypassPermissions' 
  | 'bypass' 
  | 'auto' 
  | 'acceptEdits' 
  | 'manual' 
  | 'dontAsk' 
  | 'plan';

export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeAttachment {
  url?: string;
  path?: string;
  name?: string;
  contentType?: string;
  buffer?: Buffer;
}

export type AttachmentInput = string | ClaudeAttachment;

export interface ClaudeHeadlessOptions {
  session?: string;
  cwd?: string;
  model?: string;
  permission?: ClaudePermissionMode;
  effort?: ClaudeEffortLevel;
  message?: string;
  attachments?: AttachmentInput[];
  timeout?: number;
  binary?: string;
  env?: Record<string, string>;
}

export interface ToolUseEvent {
  id: string;
  name: string;
  input: any;
}

export interface ToolResultEvent {
  toolUseId?: string;
  output: string;
  isError?: boolean;
}

export interface TurnSummary {
  text: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  costUSD?: number;
}

export function getHostCredentials(): Record<string, string> {
  const localAppData = process.env.LOCALAPPDATA || 'C:/Users/aiden/AppData/Local';
  const claude3pDir = path.join(localAppData, 'Claude-3p');
  const cacheFile = path.join(os.homedir(), '.claude', 'gateway-creds-cache.json');

  if (fs.existsSync(claude3pDir)) {
    const credFiles = fs.readdirSync(claude3pDir).filter(f => f.startsWith('host-creds-') && f.endsWith('.json'));
    if (credFiles.length > 0) {
      credFiles.sort((a, b) => {
        const statA = fs.statSync(path.join(claude3pDir, a));
        const statB = fs.statSync(path.join(claude3pDir, b));
        return statB.mtimeMs - statA.mtimeMs;
      });
      try {
        const data = JSON.parse(fs.readFileSync(path.join(claude3pDir, credFiles[0]), 'utf8'));
        if (data.env) {
          try {
            fs.writeFileSync(cacheFile, JSON.stringify(data.env, null, 2), 'utf8');
          } catch (_) {}
          return data.env;
        }
      } catch (_) {}
    }
  }

  // Fallback ke cache kredensial jika Claude Desktop sedang ditutup
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && typeof cached === 'object') return cached;
    } catch (_) {}
  }

  return {};
}

export function getClaudeBinary(): string {
  const localAppData = process.env.LOCALAPPDATA || 'C:/Users/aiden/AppData/Local';
  const localAppDir = path.join(localAppData, 'Claude-3p', 'claude-code');
  if (fs.existsSync(localAppDir)) {
    const versions = fs.readdirSync(localAppDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const vDir = path.join(localAppDir, v);
      if (fs.statSync(vDir).isDirectory()) {
        const hashes = fs.readdirSync(vDir);
        for (const h of hashes) {
          const candidate = path.join(vDir, h, 'claude.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return 'claude';
}

export class ClaudeHeadless extends EventEmitter {
  private _sessionId: string = '';
  private _cwd: string = process.cwd();
  private _model: string = 'claude-opus-5-5';
  private _permission: string = 'bypassPermissions';
  private _effort: ClaudeEffortLevel = 'xhigh';
  private _prompt: string = '';
  private _attachments: AttachmentInput[] = [];
  private _timeoutMs: number = 300_000; // 5 menit default
  private _customBinary?: string;
  private _extraEnv: Record<string, string> = {};
  private _childProcess: ChildProcess | null = null;
  private _killed: boolean = false;

  constructor(options?: ClaudeHeadlessOptions) {
    super();
    if (options) {
      this.spawn(options);
    }
  }

  /**
   * Menginisialisasi konfigurasi runner (bisa dipanggil kosong atau dengan opsi)
   */
  spawn(options?: ClaudeHeadlessOptions): this {
    if (options) {
      if (options.session) this._sessionId = options.session;
      if (options.cwd) this._cwd = options.cwd;
      if (options.model) this._model = options.model;
      if (options.permission) this.permission(options.permission);
      if (options.effort) this._effort = options.effort;
      if (options.message) this._prompt = options.message;
      if (options.attachments) this.attachments(options.attachments);
      if (options.timeout) this._timeoutMs = options.timeout;
      if (options.binary) this._customBinary = options.binary;
      if (options.env) this._extraEnv = options.env;
    }
    return this;
  }

  session(id: string): this {
    this._sessionId = id;
    return this;
  }

  cwd(dirPath: string): this {
    this._cwd = dirPath;
    return this;
  }

  model(modelId: string): this {
    this._model = modelId;
    return this;
  }

  permission(mode: ClaudePermissionMode): this {
    if (mode === 'bypass' || mode === 'bypassPermissions') {
      this._permission = 'bypassPermissions';
    } else {
      this._permission = mode;
    }
    return this;
  }

  effort(level: ClaudeEffortLevel): this {
    this._effort = level;
    return this;
  }

  message(prompt: string): this {
    this._prompt = prompt;
    return this;
  }

  attachments(items: AttachmentInput | AttachmentInput[]): this {
    if (Array.isArray(items)) {
      this._attachments.push(...items);
    } else if (items) {
      this._attachments.push(items);
    }
    return this;
  }

  attachment(item: AttachmentInput): this {
    return this.attachments(item);
  }

  timeout(ms: number): this {
    this._timeoutMs = ms;
    return this;
  }

  /**
   * Menghentikan paksa proses eksekusi
   */
  abort(): void {
    if (this._childProcess && !this._killed) {
      this._killed = true;
      try {
        this._childProcess.kill();
      } catch (_) {}
      this.emit('aborted');
    }
  }

  /**
   * Shortcut untuk melakukan pembersihan / perampingan riwayat sesi (compact)
   */
  async compact(instruction: string = ''): Promise<TurnSummary> {
    this._prompt = `/compact ${instruction}`.trim();
    return this.send();
  }

  /**
   * Download dan siapkan semua lampiran ke cache lintas platform (~/.claude/cache/attachments)
   */
  private async _resolveAttachments(): Promise<string[]> {
    if (this._attachments.length === 0) return [];

    const cacheDir = path.join(os.homedir(), '.claude', 'cache', 'attachments');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const resolved: string[] = [];

    for (const item of this._attachments) {
      if (typeof item === 'string') {
        if (item.startsWith('http://') || item.startsWith('https://')) {
          const urlObj = new URL(item);
          const rawName = path.basename(urlObj.pathname) || 'attachment';
          const safeName = `${Date.now()}_${rawName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const destPath = path.join(cacheDir, safeName);
          try {
            const res = await fetch(item);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();
            fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
            resolved.push(destPath);
          } catch (err: any) {
            console.error(`[ClaudeHeadless] Gagal mendownload attachment: ${item}`, err.message);
          }
        } else {
          resolved.push(path.resolve(item));
        }
      } else if (item && typeof item === 'object') {
        if (item.path) {
          resolved.push(path.resolve(item.path));
        } else if (item.url) {
          const rawName = item.name || path.basename(new URL(item.url).pathname) || 'attachment';
          const safeName = `${Date.now()}_${rawName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const destPath = path.join(cacheDir, safeName);
          try {
            const res = await fetch(item.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();
            fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
            resolved.push(destPath);
          } catch (err: any) {
            console.error(`[ClaudeHeadless] Gagal mendownload attachment: ${item.url}`, err.message);
          }
        } else if (item.buffer) {
          const rawName = item.name || 'attachment.dat';
          const safeName = `${Date.now()}_${rawName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const destPath = path.join(cacheDir, safeName);
          fs.writeFileSync(destPath, item.buffer);
          resolved.push(destPath);
        }
      }
    }

    return resolved;
  }

  /**
   * Menjalankan Claude Code secara headless dan streaming
   */
  async send(): Promise<TurnSummary> {
    this._killed = false;
    const credsEnv = getHostCredentials();
    const binPath = this._customBinary || getClaudeBinary();

    if (!this._sessionId) {
      throw new Error('ClaudeHeadless: Session ID belum ditentukan.');
    }

    const resolvedAttachmentPaths = await this._resolveAttachments();
    const cleanPrompt = this._prompt ? this._prompt.trim() : '';

    let promptToSend = '';
    if (resolvedAttachmentPaths.length > 0) {
      const attachHeader = resolvedAttachmentPaths.map(p => `[Lampiran: ${p} - Harap periksa dan baca file ini secara cermat]`).join('\n');
      promptToSend = cleanPrompt ? `${attachHeader}\n\n${cleanPrompt}` : attachHeader;
    } else {
      promptToSend = cleanPrompt;
    }

    if (!promptToSend) {
      throw new Error('ClaudeHeadless: Prompt/Pesan atau Lampiran kosong.');
    }

    const args = [
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
      '-p', promptToSend,
      '-r', this._sessionId,
      `--model=${this._model}`,
      `--permission-mode=${this._permission}`,
      `--effort=${this._effort}`
    ];

    if (this._permission === 'bypassPermissions') {
      args.push('--allow-dangerously-skip-permissions');
    }

    const mergedEnv = {
      ...process.env,
      ...credsEnv,
      ...this._extraEnv
    };

    return new Promise((resolve, reject) => {
      let finalText = '';
      let turnSummary: TurnSummary = { text: '' };
      let lineBuffer = '';

      let timer: NodeJS.Timeout | null = null;
      if (this._timeoutMs > 0) {
        timer = setTimeout(() => {
          this.abort();
          reject(new Error(`ClaudeHeadless: Eksekusi melebihi batas waktu (${this._timeoutMs / 1000}s)`));
        }, this._timeoutMs);
      }

      try {
        const child = spawn(binPath, args, {
          cwd: this._cwd,
          env: mergedEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        this._childProcess = child;

        // Tutup stdin langsung agar tidak menunggu timeout 3 detik
        child.stdin?.end();

        child.stdout?.on('data', (chunk: Buffer) => {
          lineBuffer += chunk.toString('utf8');
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            try {
              const event = JSON.parse(line);
              this._handleEvent(event, (delta) => {
                finalText += delta;
              }, (summary) => {
                turnSummary = summary;
              });
            } catch (_) {
              // Jika bukan JSON (misal log biasa)
              this.emit('raw_log', line);
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const errStr = chunk.toString('utf8');
          this.emit('stderr', errStr);
        });

        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          this.emit('error', err);
          reject(err);
        });

        child.on('close', (code) => {
          if (timer) clearTimeout(timer);

          // Flush sisa buffer bila ada
          if (lineBuffer.trim()) {
            try {
              const event = JSON.parse(lineBuffer.trim());
              this._handleEvent(event, (delta) => {
                finalText += delta;
              }, (summary) => {
                turnSummary = summary;
              });
            } catch (_) {}
          }

          turnSummary.text = finalText.trim() || turnSummary.text;

          if (this._killed) {
            this.emit('aborted');
            resolve({ text: '(Dibatalkan oleh pengguna)' });
            return;
          }

          if (code === 0) {
            this.emit('done', turnSummary);
            resolve(turnSummary);
          } else {
            const err = new Error(`Claude process exited with code ${code}`);
            this.emit('error', err);
            reject(err);
          }
        });
      } catch (err) {
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  private _handleEvent(
    event: any, 
    onDelta: (text: string) => void,
    onSummary: (summary: TurnSummary) => void
  ) {
    // 1. Status berpikir
    if (event.type === 'system' && event.status === 'requesting') {
      this.emit('status', 'thinking');
    }

    // 1b. API Retry / Kendala Gateway (misal 502 Bad Gateway / Cloudflare timeout)
    if (event.type === 'system' && event.subtype === 'api_error') {
      const attempt = event.retryAttempt || 1;
      const max = event.maxRetries || 10;
      const status = event.error?.status || event.error?.formatted || '502 Bad Gateway';
      const waitMs = event.retryInMs || 0;
      this.emit('api_retry', { attempt, max, status, waitMs });
    }

    // 2. Stream teks parsial (realtime delta)
    if (event.type === 'stream_event') {
      const se = event.event;
      if (se?.type === 'content_block_delta' && se?.delta?.type === 'text_delta') {
        const text = se.delta.text || '';
        onDelta(text);
        this.emit('text_delta', text);
      }
    }

    // 3. Tool Use
    if (event.type === 'assistant') {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            this.emit('tool_use', {
              id: block.id,
              name: block.name,
              input: block.input
            } as ToolUseEvent);
          }
        }
      }
    }

    // 4. Tool Result
    if (event.type === 'user') {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const outText = typeof block.content === 'string' 
              ? block.content 
              : JSON.stringify(block.content);
            this.emit('tool_result', {
              toolUseId: block.tool_use_id,
              output: outText,
              isError: block.is_error
            } as ToolResultEvent);
          }
        }
      }
    }

    // 5. Post Turn Summary & Selesai
    if (event.type === 'post_turn_summary' || event.type === 'turn_end' || event.subtype === 'completed') {
      const summary: TurnSummary = {
        text: '',
        usage: event.usage || event.message?.usage,
        costUSD: event.totalCostUSD || event.cost_usd
      };
      onSummary(summary);
      this.emit('turn_end', summary);
    }
  }
}
