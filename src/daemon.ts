import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync, exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

import { getRuntimePaths, ensureRuntimeDirs } from './runtime-paths.js';

const rPaths = ensureRuntimeDirs();
export const DAEMON_DIR = rPaths.dataDir;
export const STATE_FILE = rPaths.daemonFile;
export const LOG_FILE = rPaths.logFile;

export interface DaemonState {
  pid: number;
  trayPid?: number;
  botPid?: number;
  mode: 'headless' | 'tray';
  startedAt: string;
  logFile: string;
}

/**
 * Pastikan direktori daemon dan log tersedia
 */
export function ensureDaemonDir(): void {
  ensureRuntimeDirs();
}

/**
 * Cek apakah process ID masih aktif di Windows
 */
export function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM'; // Ada tapi beda privilege -> tetap hidup
  }
}

/**
 * Hentikan process tree secara paksa di Windows
 */
export function killProcessTree(pid?: number): void {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
  } catch (_) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (__) {}
  }
}

/**
 * Baca state daemon saat ini
 */
export function getDaemonState(): DaemonState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const state: DaemonState = JSON.parse(raw);
    if (!isProcessAlive(state.pid)) {
      return null;
    }
    return state;
  } catch (_) {
    return null;
  }
}

/**
 * Simpan state daemon
 */
export function saveDaemonState(state: DaemonState): void {
  ensureDaemonDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Hapus state file daemon
 */
export function clearDaemonState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch (_) {}
}

/**
 * Pastikan TypeScript ter-compile ke dist
 */
export function ensureDistCompiled(): void {
  const distBot = path.join(projectRoot, 'dist', 'bot.js');
  const distTray = path.join(projectRoot, 'dist', 'tray-service.js');
  if (!fs.existsSync(distBot) || !fs.existsSync(distTray)) {
    console.log('\x1b[33m[CRC]\x1b[0m Mengompilasi TypeScript ke folder dist...');
    execSync('npx tsc', { cwd: projectRoot, stdio: 'inherit' });
  }
}

/**
 * Jalankan daemon di background (tray atau headless)
 */
export async function startDaemon(mode: 'headless' | 'tray' = 'tray'): Promise<void> {
  ensureDistCompiled();
  ensureDaemonDir();

  const currentState = getDaemonState();
  if (currentState) {
    console.log(`\n\x1b[33m[CRC]\x1b[0m Daemon sudah berjalan!`);
    console.log(`  PID      : \x1b[1;32m${currentState.pid}\x1b[0m`);
    console.log(`  Mode     : \x1b[1;36m${currentState.mode.toUpperCase()}\x1b[0m`);
    console.log(`  Log File : ${currentState.logFile}\n`);
    console.log(`Ketik \x1b[1;32mcrc logs -f\x1b[0m untuk memantau log.`);
    return;
  }

  const scriptName = mode === 'tray' ? 'tray-service.js' : 'bot.js';
  const scriptPath = path.join(projectRoot, 'dist', scriptName);

  if (!fs.existsSync(scriptPath)) {
    console.error(`\x1b[31m[CRC Error]\x1b[0m File target tidak ditemukan: ${scriptPath}`);
    return;
  }

  const logFd = fs.openSync(LOG_FILE, 'a');

  // Catat header log baru
  const header = `\n============================================================\n` +
                 `[CRC DAEMON START] Mode: ${mode.toUpperCase()} | Waktu: ${new Date().toLocaleString('id-ID')}\n` +
                 `============================================================\n`;
  fs.writeSync(logFd, header);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CRC_DAEMON_MODE: mode, CRC_VERBOSE: '1' }
  });

  const pid = child.pid;
  if (!pid) {
    console.error(`\x1b[31m[CRC Error]\x1b[0m Gagal memulai background process.`);
    return;
  }

  child.unref();

  const state: DaemonState = {
    pid,
    mode,
    startedAt: new Date().toISOString(),
    logFile: LOG_FILE
  };

  saveDaemonState(state);

  // Tunggu sejenak untuk memverifikasi process tetap hidup
  await new Promise(r => setTimeout(r, 600));

  if (!isProcessAlive(pid)) {
    console.error(`\x1b[31m[CRC Error]\x1b[0m Process langsung mati setelah dijalankan.`);
    console.error(`Periksa file log: \x1b[1;33m${LOG_FILE}\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[1;32m============================================================\x1b[0m`);
  console.log(`  \x1b[1;36mCLAUDE REMOTE CONTROL (CRC) - BACKGROUND DAEMON\x1b[0m`);
  console.log(`\x1b[1;32m============================================================\x1b[0m`);
  console.log(`  Status   : \x1b[1;32m🟢 BERJALAN DI BACKGROUND\x1b[0m`);
  console.log(`  Mode     : \x1b[1;33m${mode === 'tray' ? 'System Tray (Taskbar Windows)' : 'Headless Daemon'}\x1b[0m`);
  console.log(`  PID      : \x1b[1;37m${pid}\x1b[0m`);
  console.log(`  Log File : \x1b[1;34m${LOG_FILE}\x1b[0m`);
  if (mode === 'tray') {
    console.log(`  Tray     : Icon Claude telah muncul di system tray taskbar kanan.`);
  }
  console.log(`------------------------------------------------------------`);
  console.log(`  Perintah Cepat:`);
  console.log(`    \x1b[1;32mcrc logs\x1b[0m        -> Lihat log terbaru`);
  console.log(`    \x1b[1;32mcrc logs -f\x1b[0m     -> Pantau log secara realtime (follow)`);
  console.log(`    \x1b[1;32mcrc logs --open\x1b[0m -> Buka file log langsung di Notepad`);
  console.log(`    \x1b[1;32mcrc status\x1b[0m      -> Cek status bot & sesi aktif`);
  console.log(`    \x1b[1;32mcrc stop\x1b[0m        -> Matikan daemon & bot`);
  console.log(`============================================================\n`);
}

/**
 * Matikan daemon dan semua child process-nya
 */
export async function stopDaemon(): Promise<void> {
  const state = getDaemonState();
  if (!state) {
    console.log(`\n\x1b[33m[CRC]\x1b[0m Tidak ada daemon atau system tray yang sedang berjalan.\n`);
    clearDaemonState();
    return;
  }

  console.log(`\n\x1b[33m[CRC]\x1b[0m Menghentikan daemon (PID: ${state.pid})...`);
  
  // Hentikan PID utama
  killProcessTree(state.pid);
  if (state.botPid && state.botPid !== state.pid) {
    killProcessTree(state.botPid);
  }
  if (state.trayPid && state.trayPid !== state.pid) {
    killProcessTree(state.trayPid);
  }

  clearDaemonState();

  console.log(`\x1b[1;32m✔ [CRC]\x1b[0m Bot dan System Tray berhasil dihentikan.\n`);
}

/**
 * Restart daemon
 */
export async function restartDaemon(mode?: 'headless' | 'tray'): Promise<void> {
  const state = getDaemonState();
  const targetMode = mode || state?.mode || 'tray';

  if (state) {
    await stopDaemon();
    await new Promise(r => setTimeout(r, 1000));
  }

  await startDaemon(targetMode);
}

/**
 * Cetak kartu status daemon ke terminal
 */
export function printDaemonStatus(activeSessionName?: string): void {
  const state = getDaemonState();

  console.log(`\n\x1b[1;36m============================================================\x1b[0m`);
  console.log(`  \x1b[1;32mCLAUDE REMOTE CONTROL (CRC) - DAEMON STATUS\x1b[0m`);
  console.log(`\x1b[1;36m============================================================\x1b[0m`);

  if (!state) {
    console.log(`  Status    : \x1b[1;31m⚪ TIDAK AKTIF (Stopped)\x1b[0m`);
    console.log(`  Petunjuk  : Jalankan perintah berikut untuk mengaktifkan:`);
    console.log(`              \x1b[1;32mcrc tray\x1b[0m   (Jalankan di System Tray)`);
    console.log(`              \x1b[1;32mcrc start\x1b[0m  (Jalankan background headless)`);
  } else {
    let logSize = '0 KB';
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      logSize = `${(stats.size / 1024).toFixed(1)} KB`;
    }

    console.log(`  Status    : \x1b[1;32m🟢 AKTIF (Running in Background)\x1b[0m`);
    console.log(`  Mode      : \x1b[1;33m${state.mode.toUpperCase()} ${state.mode === 'tray' ? '(System Tray)' : '(Headless)'}\x1b[0m`);
    console.log(`  PID       : \x1b[1;37m${state.pid}\x1b[0m`);
    if (state.botPid && state.botPid !== state.pid) {
      console.log(`  Bot PID   : \x1b[1;37m${state.botPid}\x1b[0m`);
    }
    console.log(`  Started   : \x1b[1;35m${new Date(state.startedAt).toLocaleString('id-ID')}\x1b[0m`);
    console.log(`  Log File  : \x1b[1;34m${LOG_FILE}\x1b[0m (${logSize})`);
    if (activeSessionName) {
      console.log(`  Sesi Aktif: \x1b[1;36m${activeSessionName}\x1b[0m`);
    }
  }

  console.log(`============================================================\n`);
}

export interface StreamLogOptions {
  follow?: boolean;
  lines?: number;
  open?: boolean;
  clear?: boolean;
  verbose?: boolean;
}

/**
 * Tangani perintah logs (view, follow, open notepad, clear, verbose)
 */
export function streamLogs(options: StreamLogOptions): void {
  if (options.clear) {
    if (fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, '');
      console.log(`\x1b[1;32m✔ [CRC]\x1b[0m File log berhasil dibersihkan.`);
    } else {
      console.log(`\x1b[33m[CRC]\x1b[0m File log belum dibuat.`);
    }
    return;
  }

  if (options.open) {
    if (!fs.existsSync(LOG_FILE)) {
      ensureDaemonDir();
      fs.writeFileSync(LOG_FILE, `[Log Baru Dibuat: ${new Date().toLocaleString('id-ID')}]\n`);
    }
    console.log(`\x1b[32m[CRC]\x1b[0m Membuka file log di Notepad: ${LOG_FILE}`);
    exec(`start notepad.exe "${LOG_FILE}"`);
    return;
  }

  if (!fs.existsSync(LOG_FILE)) {
    console.log(`\x1b[33m[CRC]\x1b[0m Belum ada log tercatat. Jalankan \x1b[1;32mcrc tray\x1b[0m atau \x1b[1;32mcrc start\x1b[0m terlebih dahulu.`);
    return;
  }

  const defaultLines = options.verbose ? (options.follow ? 60 : 80) : (options.follow ? 25 : 40);
  const lineCount = options.lines || defaultLines;
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const allLines = content.split(/\r?\n/);
  const recentLines = allLines.slice(-lineCount);

  const verboseTag = options.verbose ? ' [VERBOSE DETAIL]' : '';
  const streamTag = options.follow ? ' [REALTIME STREAM]' : '';

  console.log(`\x1b[1;36m============================================================\x1b[0m`);
  console.log(`  \x1b[1;32mCRC LOGS${verboseTag}${streamTag}\x1b[0m (Terakhir ${recentLines.length} baris)`);
  console.log(`  File: \x1b[1;34m${LOG_FILE}\x1b[0m`);
  if (options.follow) {
    console.log(`  \x1b[33m(Mode realtime${options.verbose ? ' + detail' : ''} aktif. Tekan Ctrl+C untuk keluar)\x1b[0m`);
  }
  console.log(`\x1b[1;36m============================================================\x1b[0m\n`);

  console.log(recentLines.join('\n'));

  if (!options.follow) return;

  // Realtime tailing
  let currentSize = fs.statSync(LOG_FILE).size;
  const interval = setInterval(() => {
    try {
      if (!fs.existsSync(LOG_FILE)) return;
      const newStats = fs.statSync(LOG_FILE);
      if (newStats.size > currentSize) {
        const stream = fs.createReadStream(LOG_FILE, {
          start: currentSize,
          end: newStats.size
        });
        stream.on('data', chunk => process.stdout.write(chunk));
        currentSize = newStats.size;
      } else if (newStats.size < currentSize) {
        // Log truncated
        currentSize = newStats.size;
      }
    } catch (_) {}
  }, 250);

  const cleanup = () => {
    clearInterval(interval);
    console.log(`\n\x1b[33m[CRC]\x1b[0m Pemantauan log dihentikan.\n`);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
