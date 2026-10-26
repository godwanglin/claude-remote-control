import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec, ChildProcess } from 'child_process';
import SysTray from 'systray2';
import { BOT_ICO_BASE64 } from './tray-icon.js';
import {
  ensureDaemonDir,
  saveDaemonState,
  clearDaemonState,
  LOG_FILE,
  STATE_FILE,
  killProcessTree
} from './daemon.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

let botProcess: ChildProcess | null = null;
let isIntentionalStop = false;
let systrayInstance: any = null;

// Pastikan direktori log tersedia
ensureDaemonDir();

function appendLog(msg: string) {
  const line = `[${new Date().toLocaleTimeString('id-ID')}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

/**
 * Jalankan proses bot Discord
 */
function spawnBotProcess() {
  isIntentionalStop = false;
  const botScript = path.join(projectRoot, 'dist', 'bot.js');

  appendLog(`[Tray] Memulai proses bot Discord (node ${botScript})...`);

  botProcess = spawn(process.execPath, [botScript], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, CRC_RUNNING_IN_TRAY: '1', CRC_VERBOSE: '1' }
  });

  botProcess.stdout?.on('data', (chunk) => {
    try {
      fs.appendFileSync(LOG_FILE, chunk);
    } catch (_) {}
  });

  botProcess.stderr?.on('data', (chunk) => {
    try {
      fs.appendFileSync(LOG_FILE, chunk);
    } catch (_) {}
  });

  const botPid = botProcess.pid;
  appendLog(`[Tray] Bot Discord berjalan dengan PID: ${botPid}`);

  // Update daemon state
  saveDaemonState({
    pid: process.pid,
    trayPid: process.pid,
    botPid: botPid || undefined,
    mode: 'tray',
    startedAt: new Date().toISOString(),
    logFile: LOG_FILE
  });

  botProcess.on('exit', (code, signal) => {
    appendLog(`[Tray] Proses bot keluar (code: ${code}, signal: ${signal})`);
    botProcess = null;

    if (!isIntentionalStop && systrayInstance) {
      appendLog(`[Tray] Peringatan: Bot berhenti secara tidak terduga.`);
    }
  });

  botProcess.on('error', (err) => {
    appendLog(`[Tray Error] Bot gagal dijalankan: ${err.message}`);
    botProcess = null;
  });

  return botPid;
}

/**
 * Hentikan proses bot
 */
function stopBotProcess() {
  isIntentionalStop = true;
  if (botProcess && botProcess.pid) {
    appendLog(`[Tray] Menghentikan bot Discord (PID: ${botProcess.pid})...`);
    killProcessTree(botProcess.pid);
    botProcess = null;
  }
}

async function main() {
  appendLog(`[Tray] Inisialisasi System Tray (PID: ${process.pid})...`);

  // 1. Jalankan bot Discord terlebih dahulu
  const botPid = spawnBotProcess();

  // 2. Siapkan icon (32x32 ICO hasil konversi logo)
  let iconData = BOT_ICO_BASE64;
  const logoIcoPath = path.join(projectRoot, 'assets', 'logo.ico');
  const botIcoPath = path.join(projectRoot, 'assets', 'bot.ico');

  if (fs.existsSync(logoIcoPath)) {
    try {
      iconData = fs.readFileSync(logoIcoPath).toString('base64');
    } catch (_) {}
  } else if (fs.existsSync(botIcoPath)) {
    try {
      iconData = fs.readFileSync(botIcoPath).toString('base64');
    } catch (_) {}
  }

  // 3. Konfigurasi menu System Tray
  const itemStatus = {
    title: `🟢 Claude Remote (Bot Aktif)`,
    tooltip: `Bot terhubung ke Discord`,
    enabled: false
  };

  const itemPid = {
    title: `🆔 PID: ${process.pid} (Bot: ${botPid || '-'})`,
    tooltip: `Process ID Windows`,
    enabled: false
  };

  const itemOpenLogs = {
    title: `📋 Buka Log (Notepad)`,
    tooltip: `Buka file crc.log di Notepad`,
    enabled: true
  };

  const itemRestart = {
    title: `🔄 Restart Bot`,
    tooltip: `Muat ulang proses Discord bot`,
    enabled: true
  };

  const itemExit = {
    title: `❌ Keluar (Exit Tray & Bot)`,
    tooltip: `Hentikan bot dan tutup system tray`,
    enabled: true
  };

  const separator = (SysTray as any).separator || (SysTray as any).default?.separator || {
    title: '<SEPARATOR>',
    tooltip: '',
    enabled: true
  };

  const menu = {
    icon: iconData,
    title: 'Claude Remote',
    tooltip: 'Claude Remote Control (Bot Aktif)',
    items: [
      itemStatus,
      itemPid,
      separator,
      itemOpenLogs,
      itemRestart,
      separator,
      itemExit
    ]
  };

  systrayInstance = new (SysTray as any).default({
    menu,
    debug: false
  });

  systrayInstance.onClick((action: any) => {
    const item = action.item;
    if (!item) return;

    // Klik: Buka Log
    if (item.title === itemOpenLogs.title) {
      appendLog(`[Tray Action] Membuka log di Notepad.`);
      exec(`start notepad.exe "${LOG_FILE}"`);
      return;
    }

    // Klik: Restart Bot
    if (item.title === itemRestart.title) {
      appendLog(`[Tray Action] Me-restart bot Discord...`);
      stopBotProcess();
      setTimeout(() => {
        const newPid = spawnBotProcess();
        itemPid.title = `🆔 PID: ${process.pid} (Bot: ${newPid || '-'})`;
        itemStatus.title = `🟢 Claude Remote (Bot Aktif)`;
        appendLog(`[Tray Action] Bot berhasil di-restart.`);
      }, 800);
      return;
    }

    // Klik: Keluar Tray
    if (item.title === itemExit.title) {
      appendLog(`[Tray Action] Menutup tray dan mematikan bot.`);
      shutdownCleanly();
    }
  });

  await systrayInstance.ready();
  appendLog(`[Tray] System Tray siap dan berjalan di taskbar.`);
}

function shutdownCleanly() {
  appendLog(`[Tray] Proses shutdown diinisiasi...`);
  stopBotProcess();
  clearDaemonState();

  if (systrayInstance) {
    try {
      systrayInstance.kill();
    } catch (_) {}
  }

  process.exit(0);
}

process.on('SIGINT', shutdownCleanly);
process.on('SIGTERM', shutdownCleanly);

main().catch((err) => {
  appendLog(`[Tray Fatal Error] ${err.stack || err.message}`);
  shutdownCleanly();
});
