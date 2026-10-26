#!/usr/bin/env node

/**
 * CRC (Claude Remote Control) - Standalone CLI & HTTP API Bridge
 * Menggunakan ClaudeHeadless Native Runner (100% Headless, Anti-Timeout, Sync ke Claude Desktop).
 *
 * Contoh Penggunaan CLI:
 *   crc tray                         -> Jalankan di System Tray taskbar Windows
 *   crc start                        -> Jalankan bot di background headless daemon
 *   crc stop                         -> Matikan background daemon bot & tray
 *   crc status                       -> Cek status daemon bot & sesi Claude aktif
 *   crc logs [-f] [--open]           -> Pantau log bot (-f: realtime, --open: buka di Notepad)
 *   crc /sessions                    -> Tampilkan daftar tab & sesi proyek (sidebar Claude Desktop)
 *   crc /status                      -> Tampilkan kartu status sesi aktif & context window
 *   crc /model [id]                  -> Tampilkan atau ubah model AI
 *   crc /teleport <no|id|auto>       -> Pindah kontrol sesi aktif
 *   crc /compact [catatan]           -> Ringkas konteks sesi aktif
 *   crc /clear                       -> Reset memori/konteks sesi aktif
 *   crc /permission [mode]           -> Ubah izin (bypass | auto | plan | acceptEdits | manual)
 *   crc chat "<prompt>"              -> Kirim prompt dan stream jawaban Claude di terminal
 *   crc api [port]                   -> Jalankan server REST API lokal
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distPath = path.join(projectRoot, 'dist');

// Pastikan dist sudah ter-compile
if (!fs.existsSync(path.join(distPath, 'commands-handler.js'))) {
  console.log('\x1b[33m[CRC]\x1b[0m Mengompilasi TypeScript ke dist...');
  const { execSync } = await import('child_process');
  execSync('npx tsc', { cwd: projectRoot, stdio: 'inherit' });
}

const distFile = (file) => pathToFileURL(path.join(distPath, file)).href;

// Injeksi kredensial Gateway Claude Desktop
const { getHostCredentials, ClaudeHeadless } = await import(distFile('claude-headless.js'));
const hostCreds = getHostCredentials();
for (const [k, v] of Object.entries(hostCreds)) {
  if (!process.env[k]) {
    process.env[k] = v;
  }
}

// Import modul inti
const {
  startDaemon,
  stopDaemon,
  restartDaemon,
  printDaemonStatus,
  streamLogs,
  getDaemonState
} = await import(distFile('daemon.js'));

const {
  handleStatus,
  handleSessions,
  handleModel,
  handleClear,
  handleTeleport,
  handlePermission,
  handleCompact,
  currentPermissionMode,
  getSessionModel,
  AVAILABLE_MODELS
} = await import(distFile('commands-handler.js'));

const {
  getActiveSessions,
  getPreferredSession,
  getActiveDesktopSessionInfo
} = await import(distFile('ipc.js'));

const { getSidebarProjectGroups, getCachedSessionsList } = await import(distFile('session-browser.js'));
const { getSessionStatus } = await import(distFile('session-status.js'));
const { detectTurnMediaFiles } = await import(distFile('media-detector.js'));

const {
  config,
  saveCredentials,
  saveOwnerId,
  verifyDiscordToken,
  verifyDiscordOwner,
  getBotInviteUrl
} = await import(distFile('config.js'));

const {
  runSetupWizard,
  runInteractiveDashboard,
  printTokenMissingCard
} = await import(distFile('tui-wizard.js'));

const { settingsManager } = await import(distFile('settings-manager.js'));

/**
 * Format string box dari commands-handler untuk terminal
 */
function formatForTerminal(text, raw = false) {
  if (raw) return text;
  return text
    .replace(/^```ansi\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
}

/**
 * Ambil sesi target saat ini:
 * 1. Tab aktif Claude Desktop
 * 2. Atau sesi terakhir dari projects
 */
function resolveCurrentSession() {
  const desktop = getActiveDesktopSessionInfo();
  if (desktop) {
    return {
      pid: process.pid,
      sessionId: desktop.sessionId,
      name: desktop.name,
      cwd: desktop.cwd,
      status: 'idle',
      messagingSocketPath: ''
    };
  }

  const { flatList } = getSidebarProjectGroups();
  if (flatList.length > 0) {
    const primary = flatList[0];
    return {
      pid: process.pid,
      sessionId: primary.sessionId,
      name: primary.title,
      cwd: primary.folder,
      status: 'idle',
      messagingSocketPath: ''
    };
  }

  return null;
}

/**
 * Streaming interaktif CLI menggunakan ClaudeHeadless
 */
async function executeChatStream(prompt, session = null, isVerbose = false) {
  const activeSession = session || resolveCurrentSession();
  if (!activeSession) {
    console.error('\x1b[31m[Error]\x1b[0m Tidak ada sesi Claude yang ditemukan di PC.');
    process.exit(1);
  }

  const modelId = getSessionModel(activeSession.sessionId);

  console.log(`\x1b[1;36m============================================================\x1b[0m`);
  console.log(`  \x1b[1;32mCLAUDE REMOTE HEADLESS STREAM${isVerbose ? ' [VERBOSE DETAIL]' : ''}\x1b[0m`);
  console.log(`\x1b[1;36m============================================================\x1b[0m`);
  console.log(`  Sesi   : \x1b[1;37m${activeSession.name}\x1b[0m (${activeSession.sessionId})`);
  console.log(`  Folder : \x1b[1;33m${activeSession.cwd}\x1b[0m`);
  console.log(`  Model  : \x1b[1;35m${modelId}\x1b[0m | Izin: \x1b[1;36m${currentPermissionMode}\x1b[0m`);
  console.log(`  Prompt : "${prompt}"`);
  console.log(`------------------------------------------------------------\n`);

  const turnSources = [prompt];
  const runner = new ClaudeHeadless({
    session: activeSession.sessionId,
    cwd: activeSession.cwd,
    model: modelId,
    permission: currentPermissionMode,
    message: prompt,
    timeout: 600000
  });

  runner.on('status', () => {
    if (isVerbose) {
      console.log(`\x1b[33m⏳ [Status] Claude sedang berpikir / menganalisis...\x1b[0m`);
    } else {
      console.log(`\x1b[33m⏳ [Claude Berpikir...]\x1b[0m`);
    }
  });

  runner.on('api_retry', (data) => {
    const waitSec = data.waitMs ? ` (tunggu ${(data.waitMs / 1000).toFixed(0)}s)` : '';
    console.log(`\n\x1b[1;33m⚠️  [API Retry] Gateway ${data.status} - Mencoba ulang (${data.attempt}/${data.max})${waitSec}...\x1b[0m`);
  });

  runner.on('tool_use', (tool) => {
    let detail = tool.name;
    if (tool.input?.command) detail = tool.input.command;
    else if (tool.input?.path || tool.input?.file_path) detail = tool.input.path || tool.input.file_path;
    else if (tool.input?.pattern) detail = `grep: ${tool.input.pattern}`;

    if (tool.input?.command) turnSources.push(tool.input.command);
    if (tool.input?.path || tool.input?.file_path) turnSources.push(tool.input.path || tool.input.file_path);
    if (tool.input?.output || tool.input?.out) turnSources.push(tool.input.output || tool.input.out);

    if (isVerbose) {
      const cleanCmd = detail.replace(/\r?\n+/g, ' ').trim();
      console.log(`\n\x1b[1;36m⚙️  [Tool Use: ${tool.name}]\x1b[0m ➜ ${cleanCmd}`);
    } else {
      console.log(`\n\x1b[1;34m⚡ [TOOL USE: ${tool.name}]\x1b[0m: ${detail}`);
    }
  });

  runner.on('tool_result', (res) => {
    if (res.output) turnSources.push(res.output);

    if (isVerbose) {
      const status = res.isError ? '\x1b[31m[ERROR]\x1b[0m' : '\x1b[32m[OK]\x1b[0m';
      const preview = (res.output || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      console.log(`\x1b[32m📋 [Tool Result ${status}]:\x1b[0m ${preview}${preview.length >= 160 ? '...' : ''}\n`);
    } else {
      const preview = res.output ? res.output.trim().slice(0, 120) : '(selesai)';
      console.log(`\x1b[32m📋 [HASIL TOOL]:\x1b[0m ${preview}\n`);
    }
  });

  runner.on('turn_end', (summary) => {
    if (isVerbose && summary.usage) {
      const inTok = summary.usage.input_tokens ?? 0;
      const outTok = summary.usage.output_tokens ?? 0;
      const cost = summary.costUSD ? `$${summary.costUSD.toFixed(4)}` : '-';
      console.log(`\n\x1b[34m📊 [Stats] Tokens [in=${inTok}, out=${outTok}] | Biaya: ${cost}\x1b[0m`);
    }
  });

  runner.on('text_delta', (chunk) => {
    process.stdout.write(chunk);
    turnSources.push(chunk);
  });

  runner.on('stderr', (data) => {
    if (isVerbose) {
      process.stderr.write(`\x1b[31m[Stderr]\x1b[0m ${data}`);
    }
  });

  runner.on('error', (err) => {
    // Ditangani di blok try/catch saat runner.send()
  });

  try {
    const summary = await runner.send();
    if (summary.text) turnSources.push(summary.text);

    console.log(`\n\n\x1b[1;32m✔ [TURN SELESAI]\x1b[0m`);
    if (summary.usage) {
      console.log(`  Token: in=${summary.usage.input_tokens || 0}, out=${summary.usage.output_tokens || 0}`);
    }

    // Deteksi file media (gambar & audio) yang dihasilkan di disk
    const mediaFiles = detectTurnMediaFiles({ turnSources, cwd: activeSession.cwd });
    if (mediaFiles.length > 0) {
      console.log(`\n\x1b[1;32m📎 [MEDIA TERDETEKSI]\x1b[0m Ditemukan ${mediaFiles.length} file di disk:`);
      for (const f of mediaFiles) {
        console.log(`  - \x1b[1;37m${f.name}\x1b[0m (${(f.size / 1024).toFixed(1)} KB) ➜ ${f.path}`);
      }
    }
    console.log(`------------------------------------------------------------\n`);
  } catch (err) {
    console.error(`\n\x1b[31m[Error Eksekusi]\x1b[0m ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
\x1b[1;36mCRC (Claude Remote Control) - Standalone CLI, Background Daemon & System Tray\x1b[0m
Bridge remote control untuk Anthropic Claude Desktop di Windows

\x1b[1;33mPENGGUNAAN:\x1b[0m
  crc <grup-perintah> [subperintah...] [opsi...]

\x1b[1;33mDASHBOARD & WIZARD:\x1b[0m
  \x1b[1;32mcrc\x1b[0m                         Buka Dashboard TUI Interaktif (Menu kontrol mewah)
  \x1b[1;32mcrc setup\x1b[0m                   Jalankan Setup Wizard konfigurasi awal bot

\x1b[1;33mPERINTAH TERPUSAT (HUB COMMANDS):\x1b[0m
  \x1b[1;32mcrc discord <cmd>\x1b[0m           Pusat Discord: channel sync, clear, token, owner, invite, status (-h)
  \x1b[1;32mcrc service <cmd>\x1b[0m           Pusat Layanan: tray, start, daemon, stop, restart, status, logs (-h)
  \x1b[1;32mcrc session <cmd>\x1b[0m           Pusat Sesi: list, status, switch, model, compact, clear, permission (-h)
  \x1b[1;32mcrc settings <cmd>\x1b[0m          Pusat Setelan: show, set (model, effort, timeout, permission) (-h)

\x1b[1;33mEKSEKUSI CHAT & API:\x1b[0m
  \x1b[1;32mcrc chat "<prompt>" [-v]\x1b[0m    Kirim prompt dan stream respon Claude real-time di terminal
  \x1b[1;32mcrc api [port]\x1b[0m              Jalankan server REST API bridge lokal (default: 3300)

\x1b[1;33mALIAS CEPAT (SHORTHANDS):\x1b[0m
  crc start [-v]       ➜  crc service start [-v]
  crc tray             ➜  crc service tray
  crc stop             ➜  crc service stop
  crc restart          ➜  crc service restart
  crc logs [-f] [-v]   ➜  crc service logs [-f] [-v]
  crc channel sync     ➜  crc discord channel sync
  crc channel clear    ➜  crc discord channel clear
  /sessions            ➜  crc session list
  /status              ➜  crc session status
  /model [id]          ➜  crc session model [id]
  /teleport <id|auto>  ➜  crc session switch <id|auto>
  /compact [catatan]   ➜  crc session compact [catatan]
  /clear               ➜  crc session clear
  /permission [mode]   ➜  crc session permission [mode]

Jalankan \x1b[1;33mcrc <grup> -h\x1b[0m (misal: \x1b[1;32mcrc discord -h\x1b[0m) untuk bantuan spesifik setiap grup perintah.
`);
}

/**
 * Bantuan lengkap perintah crc discord
 */
function printDiscordHelp() {
  console.log(`
\x1b[1;36mPANDUAN LENGKAP: crc discord <perintah> [opsi...]\x1b[0m
Pusat kendali integrasi, bot, kredensial, dan channel Discord secara terpusat.

\x1b[1;33mMANAJEMEN KATEGORI & CHANNEL:\x1b[0m
  \x1b[1;32mcrc discord channel sync\x1b[0m         Sinkronkan seluruh tab sesi proyek Claude ke kategori Discord (3 ch/dtk)
  \x1b[1;32mcrc discord channel clear\x1b[0m        Hapus semua text channel & kategori proyek yang dikelola CRC
  \x1b[1;32mcrc discord sync\x1b[0m                 Alias cepat untuk 'crc discord channel sync'
  \x1b[1;32mcrc discord clear\x1b[0m                Alias cepat untuk 'crc discord channel clear'

\x1b[1;33mKREDENSIAL & AKUN BOT:\x1b[0m
  \x1b[1;32mcrc discord status\x1b[0m               Periksa status koneksi, nama bot, dan User ID owner
  \x1b[1;32mcrc discord invite\x1b[0m               Dapatkan link invite bot OAuth2 dengan izin Administrator
  \x1b[1;32mcrc discord token <BOT_TOKEN>\x1b[0m    Simpan & validasi Discord Bot Token ke runtime config
  \x1b[1;32mcrc discord owner <USER_ID>\x1b[0m      Simpan & verifikasi User ID Owner
  \x1b[1;32mcrc discord setup\x1b[0m                Buka wizard interaktif langkah-demi-langkah

\x1b[1;33mOPSI:\x1b[0m
  -h, --help                          Tampilkan panduan bantuan perintah Discord ini

\x1b[1;33mCONTOH PENGGUNAAN:\x1b[0m
  crc discord -h                      # Tampilkan panduan ini
  crc discord channel sync            # Sinkronkan sesi lokal ke kategori Discord
  crc discord channel clear           # Bersihkan channel & kategori CRC
  crc discord status                  # Cek kesehatan koneksi bot & owner
  crc discord invite                  # Tampilkan tautan invite server
  crc discord token MTU0NTQ5...       # Setel bot token baru
`);
}

/**
 * Subcommand handler untuk 'crc discord <subcommand>'
 */
async function handleDiscordCommand(subArgs) {
  if (subArgs.length === 0 || subArgs.includes('-h') || subArgs.includes('--help') || subArgs[0].toLowerCase() === 'help') {
    printDiscordHelp();
    return;
  }

  const subCmd = subArgs[0].toLowerCase();
  const restArgs = subArgs.slice(1);
  const param = restArgs.join(' ').trim();

  // channel / channels subcommands
  if (subCmd === 'channel' || subCmd === 'channels') {
    const action = restArgs[0] ? restArgs[0].toLowerCase() : '';
    if (action === 'sync') {
      await runChannelCliCommand('sync');
      return;
    }
    if (action === 'clear' || action === 'clean' || action === 'delete' || action === 'reset') {
      const deleteCat = !restArgs.includes('--keep-category');
      await runChannelCliCommand('clear', { category: deleteCat });
      return;
    }
    if (action === '-h' || action === '--help' || action === 'help' || !action) {
      console.log(`
\x1b[1;36mPANDUAN PERINTAH: crc discord channel <aksi>\x1b[0m
  \x1b[1;32mcrc discord channel sync\x1b[0m   Sinkronkan tab sesi Claude ke kategori proyek Discord
  \x1b[1;32mcrc discord channel clear\x1b[0m  Hapus seluruh text channel & kategori proyek yang dikelola CRC
`);
      return;
    }
    console.log(`\x1b[31m[Error]\x1b[0m Aksi channel "${action}" tidak dikenal. Jalankan \x1b[1;33mcrc discord channel -h\x1b[0m`);
    return;
  }

  // alias cepat: crc discord sync & crc discord clear
  if (subCmd === 'sync') {
    await runChannelCliCommand('sync');
    return;
  }
  if (subCmd === 'clear' || subCmd === 'clean') {
    const deleteCat = !restArgs.includes('--keep-category');
    await runChannelCliCommand('clear', { category: deleteCat });
    return;
  }

  if (subCmd === 'setup' || subCmd === 'wizard') {
    await runSetupWizard();
    return;
  }

  if (subCmd === 'token') {
    if (!param) {
      console.log('\x1b[31m[Error]\x1b[0m Harap masukkan token bot. Contoh: crc discord token <BOT_TOKEN>');
      return;
    }
    console.log('\x1b[36m[CRC]\x1b[0m Memvalidasi token ke Discord API...');
    const check = await verifyDiscordToken(param);
    if (!check.valid || !check.botUser) {
      console.error(`\x1b[31m❌ Token tidak valid:\x1b[0m ${check.error || 'Autentikasi gagal'}`);
      return;
    }
    saveCredentials(param);
    console.log(`\x1b[32m✔ Token berhasil disimpan!\x1b[0m Terhubung ke bot: \x1b[1;32m${check.botUser.username}#${check.botUser.discriminator || '0000'}\x1b[0m (ID: ${check.botUser.id})`);
    return;
  }

  if (subCmd === 'owner') {
    if (!param) {
      console.log('\x1b[31m[Error]\x1b[0m Harap masukkan User ID Discord Owner. Contoh: crc discord owner 1036530575948927018');
      return;
    }
    const token = config.discordToken || process.env.DISCORD_TOKEN;
    if (token) {
      console.log('\x1b[36m[CRC]\x1b[0m Memverifikasi Owner ID ke Discord API...');
      const check = await verifyDiscordOwner(token, param);
      if (check.valid && check.user) {
        console.log(`\x1b[32m✔ Owner ditemukan:\x1b[0m \x1b[1;32m@${check.user.username}\x1b[0m (${check.user.id})`);
      } else {
        console.log(`\x1b[33m⚠️ Peringatan:\x1b[0m Tidak dapat memverifikasi owner (${check.error || 'Akan dicoba nanti'}).`);
      }
    }
    saveOwnerId(param);
    console.log(`\x1b[32m✔ Owner ID berhasil disimpan!\x1b[0m`);
    return;
  }

  if (subCmd === 'invite') {
    const token = config.discordToken || process.env.DISCORD_TOKEN;
    if (!token) {
      printTokenMissingCard();
      return;
    }
    const check = await verifyDiscordToken(token);
    if (!check.valid || !check.botUser) {
      console.error(`\x1b[31m❌ Gagal mengambil info bot:\x1b[0m ${check.error || 'Token tidak valid'}`);
      return;
    }
    const inviteUrl = getBotInviteUrl(check.botUser.id);
    console.log(`\n\x1b[1;36m🔗 LINK INVITE DISCORD BOT:\x1b[0m`);
    console.log(`\x1b[4;32m${inviteUrl}\x1b[0m\n`);
    return;
  }

  if (subCmd === 'status') {
    const token = config.discordToken || process.env.DISCORD_TOKEN;
    console.log(`\n\x1b[1;36m=== STATUS KONEKSI DISCORD CRC ===\x1b[0m`);
    if (!token) {
      console.log(`Token Bot : \x1b[31mBelum disetel\x1b[0m (Jalankan 'crc setup' atau 'crc discord token <token>')`);
    } else {
      console.log(`Token Bot : \x1b[32m${token.substring(0, 10)}...${token.slice(-5)}\x1b[0m`);
      const check = await verifyDiscordToken(token);
      if (check.valid && check.botUser) {
        console.log(`Bot User  : \x1b[1;32m${check.botUser.username}#${check.botUser.discriminator || '0000'}\x1b[0m (ID: ${check.botUser.id})`);
        console.log(`Invite URL: \x1b[36m${getBotInviteUrl(check.botUser.id)}\x1b[0m`);
      } else {
        console.log(`Bot User  : \x1b[31mTidak valid / Gagal terhubung (${check.error})\x1b[0m`);
      }
    }
    const owner = config.ownerId;
    console.log(`Owner ID  : ${owner ? `\x1b[32m${owner}\x1b[0m` : '\x1b[33mBelum disetel (Auto-claim pada pesan pertama)\x1b[0m'}\n`);
    return;
  }

  console.log(`\x1b[31m[Error]\x1b[0m Subperintah "crc discord ${subCmd}" tidak dikenal.`);
  printDiscordHelp();
}

/**
 * Bantuan lengkap perintah crc service
 */
function printServiceHelp() {
  console.log(`
\x1b[1;36mPANDUAN LENGKAP: crc service <perintah> [opsi...]\x1b[0m
Pusat kontrol proses background bot, System Tray taskbar Windows, dan logging.

\x1b[1;33mPERINTAH LAYANAN:\x1b[0m
  \x1b[1;32mcrc service tray\x1b[0m                 Jalankan bot di System Tray taskbar Windows (Background)
  \x1b[1;32mcrc service start [-v]\x1b[0m           Jalankan bot di terminal langsung (Foreground)
  \x1b[1;32mcrc service daemon\x1b[0m               Jalankan bot di background tanpa icon taskbar (Headless)
  \x1b[1;32mcrc service stop\x1b[0m                 Hentikan bot background / system tray yang sedang berjalan
  \x1b[1;32mcrc service restart\x1b[0m              Muat ulang proses background bot
  \x1b[1;32mcrc service status\x1b[0m               Cek status hidup bot (PID, uptime, mode eksekusi)
  \x1b[1;32mcrc service logs [-f] [-v] [-c]\x1b[0m Pantau log bot realtime (-f: streaming, -v: detail, -c: bersihkan)

\x1b[1;33mOPSI:\x1b[0m
  -h, --help                          Tampilkan panduan bantuan layanan ini

\x1b[1;33mCONTOH PENGGUNAAN:\x1b[0m
  crc service -h                      # Tampilkan panduan ini
  crc service tray                    # Jalankan di taskbar
  crc service status                  # Cek apakah bot sedang aktif
  crc service logs -f -v              # Live detail log di terminal
  crc service stop                    # Matikan bot background
`);
}

/**
 * Subcommand handler untuk 'crc service <subcommand>'
 */
async function handleServiceCommand(subArgs, fullArgs = []) {
  if (subArgs.length === 0 || subArgs.includes('-h') || subArgs.includes('--help') || subArgs[0].toLowerCase() === 'help') {
    printServiceHelp();
    return;
  }

  const subCmd = subArgs[0].toLowerCase();
  const token = config.discordToken || process.env.DISCORD_TOKEN;

  if (subCmd === 'tray') {
    if (!token) { printTokenMissingCard(); return; }
    await startDaemon('tray');
    return;
  }
  if (subCmd === 'daemon' || subCmd === 'headless') {
    if (!token) { printTokenMissingCard(); return; }
    await startDaemon('headless');
    return;
  }
  if (subCmd === 'start' || subCmd === 'run') {
    if (!token) { printTokenMissingCard(); return; }
    const isVerbose = fullArgs.includes('-v') || fullArgs.includes('--verbose') || fullArgs.includes('--detail') || fullArgs.includes('-d');
    await runBotForeground({ verbose: isVerbose });
    return;
  }
  if (subCmd === 'stop' || subCmd === 'kill') {
    await stopDaemon();
    return;
  }
  if (subCmd === 'restart') {
    await restartDaemon();
    return;
  }
  if (subCmd === 'status') {
    const activeSession = resolveCurrentSession();
    printDaemonStatus(activeSession?.name);
    return;
  }
  if (subCmd === 'logs' || subCmd === 'log') {
    const follow = fullArgs.includes('-f') || fullArgs.includes('--follow') || fullArgs.includes('--tail') || fullArgs.some(a => a === '-vf' || a === '-fv');
    const verbose = fullArgs.includes('-v') || fullArgs.includes('--verbose') || fullArgs.includes('--detail') || fullArgs.includes('-d') || fullArgs.some(a => a === '-vf' || a === '-fv');
    const open = fullArgs.includes('--open') || fullArgs.includes('-o');
    const clear = fullArgs.includes('--clear') || fullArgs.includes('-c');
    streamLogs({ follow, open, clear, verbose });
    return;
  }

  console.log(`\x1b[31m[Error]\x1b[0m Subperintah "crc service ${subCmd}" tidak dikenal.`);
  printServiceHelp();
}

/**
 * Bantuan lengkap perintah crc session
 */
function printSessionHelp() {
  console.log(`
\x1b[1;36mPANDUAN LENGKAP: crc session <perintah> [opsi...]\x1b[0m
Pusat kendali sesi Claude Desktop, context window, model AI, dan perizinan.

\x1b[1;33mPERINTAH SESI:\x1b[0m
  \x1b[1;32mcrc session list\x1b[0m                 Tampilkan seluruh tab & sesi proyek aktif di Claude Desktop
  \x1b[1;32mcrc session status\x1b[0m               Lihat kartu status sesi aktif & pemakaian token konteks
  \x1b[1;32mcrc session switch <no|id|auto>\x1b[0m   Pindah kendali sesi (nomor sesi, UUID, atau 'auto')
  \x1b[1;32mcrc session model [1|2|id]\x1b[0m       Lihat atau ubah model AI untuk sesi aktif
  \x1b[1;32mcrc session compact [catatan]\x1b[0m    Ringkas riwayat obrolan sesi aktif untuk menghemat token
  \x1b[1;32mcrc session clear\x1b[0m                Reset memori percakapan sesi aktif
  \x1b[1;32mcrc session permission [mode]\x1b[0m    Lihat atau ubah izin eksekusi tool (bypass, plan, dll)

\x1b[1;33mOPSI:\x1b[0m
  -h, --help                          Tampilkan panduan bantuan sesi ini

\x1b[1;33mCONTOH PENGGUNAAN:\x1b[0m
  crc session -h                      # Tampilkan panduan ini
  crc session list                    # Daftar semua sesi
  crc session status                  # Status sesi aktif
  crc session switch auto             # Ikuti tab desktop aktif
  crc session model 1                 # Ganti ke Opus 5.5
  crc session compact                 # Ringkas konteks
`);
}

/**
 * Subcommand handler untuk 'crc session <subcommand>'
 */
async function handleSessionCommand(subArgs, isMarkdown = false, isJson = false) {
  if (subArgs.length === 0 || subArgs.includes('-h') || subArgs.includes('--help') || subArgs[0].toLowerCase() === 'help') {
    printSessionHelp();
    return;
  }

  const subCmd = subArgs[0].toLowerCase();
  const param = subArgs.slice(1).join(' ').trim();
  const activeSession = resolveCurrentSession();

  if (subCmd === 'list' || subCmd === 'sessions' || subCmd === 'all') {
    if (isJson) {
      const { flatList } = getSidebarProjectGroups();
      console.log(JSON.stringify(flatList, null, 2));
    } else {
      console.log(formatForTerminal(handleSessions(activeSession), isMarkdown));
    }
    return;
  }

  if (subCmd === 'status') {
    if (isJson) {
      const st = activeSession ? getSessionStatus(activeSession) : null;
      console.log(JSON.stringify({ session: activeSession, status: st }, null, 2));
    } else {
      if (activeSession) {
        console.log(formatForTerminal(handleStatus(activeSession), isMarkdown));
      } else {
        console.log('\x1b[31m[Error]\x1b[0m Tidak ada sesi Claude aktif.');
      }
    }
    return;
  }

  if (subCmd === 'switch' || subCmd === 'teleport' || subCmd === 'select') {
    if (!param) {
      console.log('Harap masukkan nomor sesi, ID, atau "auto". Contoh: crc session switch 1');
      return;
    }
    const res = await handleTeleport(param);
    console.log(formatForTerminal(res.message, isMarkdown));
    return;
  }

  if (subCmd === 'model') {
    const card = await handleModel(activeSession, param || null);
    console.log(formatForTerminal(card, isMarkdown));
    return;
  }

  if (subCmd === 'compact') {
    console.log('\x1b[33m⏳ Meringkas konteks sesi di background...\x1b[0m');
    const res = await handleCompact(activeSession, param);
    console.log(formatForTerminal(res.message, isMarkdown));
    return;
  }

  if (subCmd === 'clear' || subCmd === 'reset') {
    const card = await handleClear(activeSession);
    console.log(formatForTerminal(card, isMarkdown));
    return;
  }

  if (subCmd === 'permission') {
    const card = handlePermission(param || null);
    console.log(formatForTerminal(card, isMarkdown));
    return;
  }

  console.log(`\x1b[31m[Error]\x1b[0m Subperintah "crc session ${subCmd}" tidak dikenal.`);
  printSessionHelp();
}

/**
 * Bantuan lengkap perintah crc settings
 */
function printSettingsHelp() {
  console.log(`
\x1b[1;36mPANDUAN LENGKAP: crc settings <perintah> [opsi...]\x1b[0m
Pemeriksaan dan konfigurasi setelan sistem AI & runtime CRC secara terpusat.

\x1b[1;33mPERINTAH SETELAN:\x1b[0m
  \x1b[1;32mcrc settings show\x1b[0m                Tampilkan ringkasan seluruh setelan AI saat ini
  \x1b[1;32mcrc settings set <kunci> <nilai>\x1b[0m Ubah nilai setelan (model, effort, timeout, permission, verbosity)

\x1b[1;33mKUNCI & NILAI YANG TERSEDIA:\x1b[0m
  model       : claude-opus-5-5 | claude-opus-4-6 | claude-sonnet-4-6
  effort      : low | medium | high | xhigh
  timeout     : 0 (Infinity) | 300000 (5m) | 600000 (10m) | 1800000 (30m)
  permission  : bypassPermissions | autoConfirm | plan | acceptEdits | manual
  verbosity   : detail | compact
  followup    : steer | default | queue

\x1b[1;33mOPSI:\x1b[0m
  -h, --help                          Tampilkan panduan bantuan setelan ini

\x1b[1;33mCONTOH PENGGUNAAN:\x1b[0m
  crc settings -h                     # Tampilkan panduan ini
  crc settings show                   # Tampilkan setelan saat ini
  crc settings set model claude-opus-5-5
  crc settings set effort high
  crc settings set timeout 0
`);
}

/**
 * Subcommand handler untuk 'crc settings <subcommand>'
 */
async function handleSettingsCommand(subArgs) {
  if (subArgs.includes('-h') || subArgs.includes('--help') || (subArgs[0] && subArgs[0].toLowerCase() === 'help')) {
    printSettingsHelp();
    return;
  }

  const subCmd = subArgs[0] ? subArgs[0].toLowerCase() : 'show';

  if (subCmd === 'show' || subCmd === 'list' || subArgs.length === 0) {
    const cur = settingsManager.settings;
    const timeoutDesc = cur.timeoutMs === 0 ? 'Infinity' : `${cur.timeoutMs / 60000}m`;
    console.log(`
\x1b[1;36m=== SETELAN SISTEM AI CRC ===\x1b[0m
  Model Default : \x1b[1;33m${cur.defaultModel}\x1b[0m
  Effort Level  : \x1b[1;36m${cur.effort}\x1b[0m
  Timeout       : \x1b[1;35m${timeoutDesc}\x1b[0m
  Follow-up Mode: \x1b[1;32m${cur.followupMode}\x1b[0m
  Verbosity     : \x1b[1;37m${cur.verbosity}\x1b[0m
  Mode Izin     : \x1b[1;34m${cur.permissionMode}\x1b[0m
`);
    return;
  }

  if (subCmd === 'set') {
    const key = subArgs[1]?.toLowerCase();
    const val = subArgs[2];
    if (!key || val === undefined) {
      console.log('\x1b[31m[Error]\x1b[0m Format salah. Contoh: crc settings set model claude-opus-5-5');
      return;
    }

    if (key === 'model' || key === 'defaultmodel') {
      settingsManager.update('defaultModel', val);
      console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Model default diubah ke: \x1b[1;33m${val}\x1b[0m`);
    } else if (key === 'effort') {
      settingsManager.update('effort', val);
      console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Effort level diubah ke: \x1b[1;36m${val}\x1b[0m`);
    } else if (key === 'timeout' || key === 'timeoutms') {
      const ms = parseInt(val, 10);
      settingsManager.update('timeoutMs', isNaN(ms) ? 0 : ms);
      console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Timeout diubah ke: \x1b[1;35m${val}\x1b[0m`);
    } else if (key === 'permission' || key === 'permissionmode') {
      settingsManager.update('permissionMode', val);
      console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Mode izin diubah ke: \x1b[1;34m${val}\x1b[0m`);
    } else if (key === 'verbosity') {
      settingsManager.update('verbosity', val);
      console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Verbosity diubah ke: \x1b[1;37m${val}\x1b[0m`);
    } else if (key === 'followup' || key === 'followupmode') {
      settingsManager.update('followupMode', val);
      console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Follow-up mode diubah ke: \x1b[1;32m${val}\x1b[0m`);
    } else {
      console.log(`\x1b[31m[Error]\x1b[0m Kunci "${key}" tidak dikenali. Jalankan \x1b[1;33mcrc settings -h\x1b[0m`);
    }
    return;
  }

  console.log(`\x1b[31m[Error]\x1b[0m Subperintah "crc settings ${subCmd}" tidak dikenal.`);
  printSettingsHelp();
}

/**
 * Jalankan bot langsung di terminal (foreground / interaktif, bisa Ctrl+C)
 */
async function runBotForeground(options = {}) {
  const token = config.discordToken || process.env.DISCORD_TOKEN;
  if (!token) {
    printTokenMissingCard();
    process.exit(1);
  }

  const botScript = path.join(distPath, 'bot.js');
  if (!fs.existsSync(botScript)) {
    console.log('\x1b[33m[CRC]\x1b[0m Mengompilasi TypeScript ke dist...');
    const { execSync } = await import('child_process');
    execSync('npx tsc', { cwd: projectRoot, stdio: 'inherit' });
  }

  const isVerbose = options.verbose || false;
  const childArgs = [botScript];
  if (isVerbose) {
    childArgs.push('--verbose');
  }

  const { spawn } = await import('child_process');
  const child = spawn(process.execPath, childArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { 
      ...process.env, 
      CRC_FOREGROUND: '1',
      ...(isVerbose ? { CRC_VERBOSE: '1' } : {})
    }
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });

  process.on('SIGINT', () => {
    child.kill('SIGINT');
  });
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
}

/**
 * Eksekusi manajemen channel Discord dari CLI
 */
async function runChannelCliCommand(action, options = {}) {
  const { Client, GatewayIntentBits } = await import('discord.js');
  const { 
    syncChannelsWithSessions, 
    clearCategoryChannels
  } = await import(distFile('channel-manager.js'));

  const token = config.discordToken || process.env.DISCORD_TOKEN;
  if (!token) {
    printTokenMissingCard();
    process.exit(1);
  }

  console.log(`\x1b[36m[CRC Channel]\x1b[0m Menghubungkan ke Discord API...`);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  await new Promise((resolve, reject) => {
    client.once('clientReady', resolve);
    client.login(token).catch(reject);
  });

  try {
    for (const [, guild] of client.guilds.cache) {
      console.log(`\x1b[34m[Server: ${guild.name}]\x1b[0m Menjalankan perintah channel: \x1b[1;33m${action}\x1b[0m...`);

      if (action === 'clear') {
        const deleteCategory = options.category !== false;
        const res = await clearCategoryChannels(guild, deleteCategory);
        console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Berhasil menghapus ${res.deletedChannels} channel dan ${res.deletedCategories} kategori proyek CRC.`);
      } else if (action === 'sync') {
        const res = await syncChannelsWithSessions(guild);
        console.log(`\x1b[32m✔ [Berhasil]\x1b[0m Selesai: ${res.categoriesCount} kategori proyek | Channel Baru: +${res.createdChannels} | Tersimpan: ${res.existingChannels} | Dihapus: -${res.deletedChannels} (Total: ${res.totalSessions} sesi)`);
      }
    }
  } catch (err) {
    console.error(`\x1b[31m[Error]\x1b[0m Gagal memproses perintah channel ${action}:`, err.message);
  } finally {
    await client.destroy();
  }
}

// --- HTTP REST API SERVER ---

function startApiServer(port = 3300) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data, null, 2));
    };

    const parseBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (_) {
          resolve({});
        }
      });
    });

    try {
      const activeSession = resolveCurrentSession();

      // GET /api/status
      if (req.method === 'GET' && pathname === '/api/status') {
        if (!activeSession) return sendJson(404, { success: false, error: 'Tidak ada sesi aktif.' });
        const st = getSessionStatus(activeSession);
        return sendJson(200, { success: true, session: activeSession, status: st });
      }

      // GET /api/sessions
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const { groups, flatList } = getSidebarProjectGroups();
        return sendJson(200, { success: true, count: flatList.length, groups, sessions: flatList });
      }

      // POST /api/compact
      if (req.method === 'POST' && pathname === '/api/compact') {
        if (!activeSession) return sendJson(404, { success: false, error: 'Tidak ada sesi aktif.' });
        const body = await parseBody();
        const result = await handleCompact(activeSession, body.instruction || '');
        return sendJson(result.success ? 200 : 500, result);
      }

      // POST /api/chat
      if (req.method === 'POST' && pathname === '/api/chat') {
        if (!activeSession) return sendJson(404, { success: false, error: 'Tidak ada sesi aktif.' });
        const body = await parseBody();
        if (!body.prompt) return sendJson(400, { success: false, error: 'Field "prompt" diperlukan.' });

        const runner = new ClaudeHeadless({
          session: activeSession.sessionId,
          cwd: activeSession.cwd,
          model: getSessionModel(activeSession.sessionId),
          permission: currentPermissionMode,
          message: body.prompt
        });

        const result = await runner.send();
        return sendJson(200, { success: true, response: result.text, usage: result.usage });
      }

      return sendJson(404, { success: false, error: 'Endpoint tidak ditemukan.' });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`\n\x1b[1;32m[CRC REST API]\x1b[0m Server berjalan di: \x1b[1;36mhttp://localhost:${port}\x1b[0m\n`);
  });
}

// --- MAIN CLI ENTRYPOINT ---

async function main() {
  const args = process.argv.slice(2);

  // Jika tanpa argumen sama sekali: buka dashboard interaktif
  if (args.length === 0) {
    const token = config.discordToken || process.env.DISCORD_TOKEN;
    if (!token) {
      await runSetupWizard();
    } else {
      await runInteractiveDashboard();
    }
    return;
  }

  // Jika perintah bantuan global: crc -h, crc --help, crc help
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help' || args[0].toLowerCase() === 'help')) {
    printHelp();
    return;
  }

  const isJson = args.includes('--json');
  const isMarkdown = args.includes('--markdown');
  const hasVerbose = args.includes('-v') || 
                     args.includes('--verbose') || 
                     args.includes('--detail') || 
                     args.includes('-d') ||
                     args.some(a => a === '-vf' || a === '-fv');

  const hasFollow = args.includes('-f') || 
                    args.includes('--follow') || 
                    args.includes('--tail') ||
                    args.some(a => a === '-vf' || a === '-fv');

  // Bersihkan flag khusus dari daftar argumen
  const cleanArgs = args.filter(a => 
    a !== '--json' && 
    a !== '--markdown' && 
    a !== '-v' && 
    a !== '--verbose' && 
    a !== '--detail' && 
    a !== '-d' &&
    a !== '-f' &&
    a !== '--follow' &&
    a !== '--tail' &&
    a !== '-vf' &&
    a !== '-fv'
  );

  // Jika tanpa argumen atau hanya flag verbose (misal: crc, crc -v, crc --verbose, crc --detail)
  if (cleanArgs.length === 0) {
    if (hasVerbose) {
      await runBotForeground({ verbose: true });
      return;
    }
    const token = config.discordToken || process.env.DISCORD_TOKEN;
    if (!token) {
      await runSetupWizard();
    } else {
      await runInteractiveDashboard();
    }
    return;
  }

  const command = cleanArgs[0].toLowerCase();
  const param = cleanArgs.slice(1).join(' ').trim();

  const activeSession = resolveCurrentSession();

  // menu / dashboard / tui / ui
  if (command === 'menu' || command === 'dashboard' || command === 'tui' || command === 'ui') {
    await runInteractiveDashboard();
    return;
  }

  // setup / wizard
  if (command === 'setup' || command === 'wizard') {
    await runSetupWizard();
    return;
  }

  // discord hub
  if (command === 'discord') {
    await handleDiscordCommand(cleanArgs.slice(1));
    return;
  }

  // service hub
  if (command === 'service') {
    await handleServiceCommand(cleanArgs.slice(1), args);
    return;
  }

  // session hub
  if (command === 'session') {
    await handleSessionCommand(cleanArgs.slice(1), isMarkdown, isJson);
    return;
  }

  // settings hub
  if (command === 'settings' || command === 'config' || command === 'setting') {
    await handleSettingsCommand(cleanArgs.slice(1));
    return;
  }

  // channel / channels (alias ke crc discord channel)
  if (command === 'channel' || command === 'channels') {
    await handleDiscordCommand(['channel', ...cleanArgs.slice(1)]);
    return;
  }

  // Shorthands untuk service (start, tray, daemon, stop, restart)
  if (['tray', 'start', 'run', 'daemon', 'stop', 'kill', 'restart'].includes(command)) {
    await handleServiceCommand([command, ...cleanArgs.slice(1)], args);
    return;
  }

  // logs
  if (command === 'logs' || command === 'log') {
    const follow = hasFollow || 
                   args.includes('-f') || 
                   args.includes('--follow') || 
                   args.includes('--tail') ||
                   args.some(a => a === '-vf' || a === '-fv');
    const verbose = hasVerbose || 
                    args.includes('-v') || 
                    args.includes('--verbose') || 
                    args.includes('--detail') || 
                    args.includes('-d') ||
                    args.some(a => a === '-vf' || a === '-fv');
    const open = args.includes('--open') || args.includes('-o');
    const clear = args.includes('--clear') || 
                  args.includes('-c') || 
                  args.some(a => a.toLowerCase() === 'clear') || 
                  param.toLowerCase() === 'clear';
    let lines;
    const nIndex = args.indexOf('-n');
    if (nIndex !== -1 && args[nIndex + 1]) {
      lines = parseInt(args[nIndex + 1], 10);
    }
    streamLogs({ follow, lines, open, clear, verbose });
    return;
  }

  // status (daemon + active session)
  if (command === 'status' || command === '/status') {
    if (isJson) {
      const st = activeSession ? getSessionStatus(activeSession) : null;
      const daemon = getDaemonState();
      console.log(JSON.stringify({ daemon, session: activeSession, status: st }, null, 2));
    } else {
      printDaemonStatus(activeSession?.name);
      if (activeSession) {
        console.log(formatForTerminal(handleStatus(activeSession), isMarkdown));
      }
    }
    return;
  }

  // /sessions
  if (command === '/sessions' || command === 'sessions') {
    if (isJson) {
      const { flatList } = getSidebarProjectGroups();
      console.log(JSON.stringify(flatList, null, 2));
    } else {
      console.log(formatForTerminal(handleSessions(activeSession), isMarkdown));
    }
    return;
  }

  // /model
  if (command === '/model' || command === 'model') {
    const card = await handleModel(activeSession, param || null);
    console.log(formatForTerminal(card, isMarkdown));
    return;
  }

  // /teleport
  if (command === '/teleport' || command === 'teleport') {
    if (!param) {
      console.log('Harap masukkan nomor sesi, ID, atau "auto". Contoh: crc /teleport 1');
      return;
    }
    const res = await handleTeleport(param);
    console.log(formatForTerminal(res.message, isMarkdown));
    return;
  }

  // /compact
  if (command === '/compact' || command === 'compact') {
    console.log('\x1b[33m⏳ Meringkas konteks sesi di background...\x1b[0m');
    const res = await handleCompact(activeSession, param);
    console.log(formatForTerminal(res.message, isMarkdown));
    return;
  }

  // /clear
  if (command === '/clear' || command === 'clear') {
    const card = await handleClear(activeSession);
    console.log(formatForTerminal(card, isMarkdown));
    return;
  }

  // /permission
  if (command === '/permission' || command === 'permission') {
    const card = handlePermission(param || null);
    console.log(formatForTerminal(card, isMarkdown));
    return;
  }

  // chat
  if (command === 'chat' || command === 'prompt' || command === 'send') {
    if (!param) {
      console.log('Harap masukkan prompt. Contoh: crc chat "Halo Claude" [--verbose]');
      return;
    }
    await executeChatStream(param, activeSession, hasVerbose);
    return;
  }

  // api
  if (command === 'api' || command === 'server') {
    const port = parseInt(param, 10) || 3300;
    startApiServer(port);
    return;
  }

  console.log(`\x1b[31mPerintah "${command}" tidak dikenal.\x1b[0m Jalankan \x1b[1;33mcrc --help\x1b[0m untuk bantuan.`);
}

main().catch(console.error);
