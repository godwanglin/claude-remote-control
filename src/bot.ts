import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  Message,
  ApplicationCommandOptionType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  StringSelectMenuBuilder
} from 'discord.js';
import { config, saveOwnerId } from './config.js';
import { 
  findTranscriptFile, 
  ClaudeSession,
  getActiveDesktopSessionInfo,
  getPreferredSession
} from './ipc.js';
import { getSidebarProjectGroups } from './session-browser.js';
import { MessageBuilder, packStepsIntoBubbles, StepRecord } from './message-builder.js';
import { 
  handleStatus, 
  handleSessions, 
  handleModel, 
  handleTeleport, 
  handlePermission, 
  handleCompact,
  currentPermissionMode,
  getSessionModel,
  botSettings,
  renderCoreSettingsCard,
  renderSystemSettingsCard,
  AVAILABLE_MODELS,
  PERMISSION_MODES
} from './commands-handler.js';
import { settingsManager } from './settings-manager.js';
import { ClaudeHeadless, getHostCredentials } from './claude-headless.js';
import { detectTurnMediaFiles, DetectedMediaFile } from './media-detector.js';

// Pastikan environment gateway Claude Desktop terinjeksi ke bot
const hostCreds = getHostCredentials();
for (const [k, v] of Object.entries(hostCreds)) {
  if (!process.env[k]) {
    process.env[k] = v;
  }
}

// Redirect log bila berjalan di headless background daemon
if (process.env.CRC_DAEMON_MODE === 'headless') {
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const daemonDir = path.join(projectRoot, '.daemon');
    if (!fs.existsSync(daemonDir)) fs.mkdirSync(daemonDir, { recursive: true });
    const logFile = path.join(daemonDir, 'crc.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    process.stdout.write = (chunk: any) => { logStream.write(chunk); return true; };
    process.stderr.write = (chunk: any) => { logStream.write(chunk); return true; };
  } catch (_) {}
}

// Deteksi flag log detail (--verbose / -v / --detail) dari argumen CLI atau environment
export const isVerboseLog = process.argv.includes('--verbose') || 
                            process.argv.includes('-v') || 
                            process.argv.includes('--detail') || 
                            process.argv.includes('-d') || 
                            process.env.CRC_VERBOSE === '1';

export function logDetail(category: string, message: string, color: string = '\x1b[36m'): void {
  if (!isVerboseLog) return;
  const timestamp = new Date().toLocaleTimeString('id-ID', { hour12: false });
  console.log(`${color}[${timestamp}] [${category}]\x1b[0m ${message}`);
}

if (!config.discordToken) {
  console.error('\x1b[31m[Error]\x1b[0m DISCORD_TOKEN tidak ditemukan di file .env!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

process.on('unhandledRejection', (reason) => {
  console.error('\x1b[31m[Unhandled Rejection]\x1b[0m', reason);
});

process.on('uncaughtException', (err) => {
  console.error('\x1b[31m[Uncaught Exception]\x1b[0m', err);
});

client.on('error', (err) => {
  console.error('\x1b[31m[Discord Client Error]\x1b[0m', err.message);
});

let currentTargetSession: ClaudeSession | null = null;
let isManualSessionLocked = settingsManager.settings.isManualSessionLocked;
let activeRunner: ClaudeHeadless | null = null;

// Antrean pesan dan penampung follow-up interaktif
interface QueuedItem {
  id: string;
  message: Message;
  rawText: string;
  activeSession: ClaudeSession;
  timestamp: number;
  interactiveMessage?: Message;
}

const messageQueue: QueuedItem[] = [];
const pendingFollowups = new Map<string, QueuedItem>();
let isCurrentAbortForSteer = false;

function safeContent(text: string): string {
  if (text.length <= 1950) return text;
  const cut = text.slice(0, 1920);
  const codeBlockCount = (cut.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    return cut + '\n... [Pesan dipotong]\n```';
  }
  return cut + '\n... [Pesan dipotong]';
}

/**
 * Memastikan sesi target selalu valid dan sinkron dengan tab Claude Desktop.
 */
async function ensureActiveSession(): Promise<ClaudeSession | null> {
  // Jika user tidak manual lock ke sesi tertentu via /teleport,
  // otomatis gunakan sesi yang sedang dibuka di Claude Desktop
  if (!isManualSessionLocked || !currentTargetSession) {
    const desktopInfo = getActiveDesktopSessionInfo();
    if (desktopInfo) {
      currentTargetSession = {
        pid: process.pid,
        sessionId: desktopInfo.sessionId,
        name: desktopInfo.name,
        cwd: desktopInfo.cwd,
        status: 'idle',
        messagingSocketPath: ''
      };
      return currentTargetSession;
    }
  }

  if (currentTargetSession) {
    return currentTargetSession;
  }

  // Fallback: Ambil sesi terkini dari direktori projects
  const { flatList } = getSidebarProjectGroups();
  if (flatList.length > 0) {
    const primary = flatList[0];
    currentTargetSession = {
      pid: process.pid,
      sessionId: primary.sessionId,
      name: primary.title,
      cwd: primary.folder,
      status: 'idle',
      messagingSocketPath: ''
    };
    return currentTargetSession;
  }

  return null;
}

/**
 * Membangun ActionRow dropdown Discord untuk memilih sesi tujuan teleport
 */
function buildSessionsDropdown(currentSession: ClaudeSession | null): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const { flatList } = getSidebarProjectGroups();
  if (flatList.length === 0) return null;

  const select = new StringSelectMenuBuilder()
    .setCustomId('select_teleport_session')
    .setPlaceholder('📁 Pilih sesi tujuan untuk teleport...');

  const options: any[] = [];

  // Opsi 1: Auto-Sync Desktop
  const isAutoActive = !isManualSessionLocked;
  options.push({
    label: '🔄 Auto-Sync Desktop',
    description: 'Otomatis ikuti tab Claude Desktop yang aktif di PC',
    value: 'auto',
    default: isAutoActive
  });

  // Opsi 2..N: Sesi-sesi yang ada (maksimal 24 opsi berikutnya, total limit Discord 25 opsi)
  const maxSessions = 24;
  flatList.slice(0, maxSessions).forEach((s, idx) => {
    const isCurrent = currentSession && s.sessionId === currentSession.sessionId && isManualSessionLocked;
    const folderName = s.folder.split('\\').pop() || s.folder;
    
    // Label max 100 char
    const title = s.title.length > 50 ? s.title.slice(0, 48) + '..' : s.title;
    const label = `[${idx + 1}] ${title}`;
    
    // Description max 100 char
    const desc = `Proyek: ${folderName}`.slice(0, 100);

    options.push({
      label,
      description: desc,
      value: s.sessionId,
      default: isCurrent
    });
  });

  select.addOptions(options);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * Bubble 1 Components: Setelan Inti (Sesi, Model, Izin)
 */
function buildCoreSettingsComponents(currentSession: ClaudeSession | null): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const { flatList } = getSidebarProjectGroups();

  // 1. Dropdown Sesi
  const sessionSelect = new StringSelectMenuBuilder()
    .setCustomId('settings_session')
    .setPlaceholder('Pilih Sesi Tujuan...');

  const sessionOptions: any[] = [];
  const isAutoActive = !isManualSessionLocked;
  sessionOptions.push({
    label: 'Auto-Sync Desktop',
    description: 'Otomatis ikuti tab Claude Desktop yang aktif di PC',
    value: 'auto',
    default: isAutoActive
  });

  flatList.slice(0, 24).forEach((s, idx) => {
    const isCurrent = currentSession && s.sessionId === currentSession.sessionId && isManualSessionLocked;
    const folderName = s.folder.split('\\').pop() || s.folder;
    const title = s.title.length > 50 ? s.title.slice(0, 48) + '..' : s.title;

    sessionOptions.push({
      label: `[${idx + 1}] ${title}`,
      description: `Proyek: ${folderName}`.slice(0, 100),
      value: s.sessionId,
      default: isCurrent
    });
  });
  sessionSelect.addOptions(sessionOptions);

  // 2. Dropdown Model
  const activeModelId = currentSession ? getSessionModel(currentSession.sessionId) : 'claude-opus-5-5';
  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId('settings_model')
    .setPlaceholder('Pilih Model AI...');

  const modelOptions = AVAILABLE_MODELS.map(m => ({
    label: `${m.name} (${m.id})`,
    description: m.desc.slice(0, 100),
    value: m.id,
    default: m.id === activeModelId
  }));
  modelSelect.addOptions(modelOptions);

  // 3. Dropdown Izin
  const permSelect = new StringSelectMenuBuilder()
    .setCustomId('settings_permission')
    .setPlaceholder('Pilih Mode Izin...');

  const permOptions = PERMISSION_MODES.map(p => ({
    label: `${p.name} (${p.id})`,
    description: p.desc.slice(0, 100),
    value: p.id,
    default: p.id === currentPermissionMode
  }));
  permSelect.addOptions(permOptions);

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sessionSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(permSelect)
  ];
}

/**
 * Bubble 2 Components: Preferensi Sistem (Tampilan, Effort, Timeout, Notif)
 */
function buildSystemSettingsComponents(): ActionRowBuilder<StringSelectMenuBuilder>[] {
  // 1. Dropdown Gaya Tampilan
  const verbositySelect = new StringSelectMenuBuilder()
    .setCustomId('settings_verbosity')
    .setPlaceholder('Pilih Gaya Tampilan Log...')
    .addOptions([
      {
        label: 'Detail',
        description: 'Tampilkan perintah terminal, output tool, dan teks jawaban',
        value: 'detail',
        default: botSettings.verbosity === 'detail'
      },
      {
        label: 'Ringkas',
        description: 'Hanya tampilkan teks akhir jawaban Claude',
        value: 'compact',
        default: botSettings.verbosity === 'compact'
      }
    ]);

  // 2. Dropdown Effort / Mikir
  const effortSelect = new StringSelectMenuBuilder()
    .setCustomId('settings_effort')
    .setPlaceholder('Pilih Level Berpikir (Effort)...')
    .addOptions([
      {
        label: 'Maksimal (xhigh)',
        description: 'Penalaran mendalam maksimum untuk problem rumit',
        value: 'xhigh',
        default: botSettings.effort === 'xhigh'
      },
      {
        label: 'Tinggi (high)',
        description: 'Penalaran tingkat tinggi',
        value: 'high',
        default: botSettings.effort === 'high'
      },
      {
        label: 'Normal (medium)',
        description: 'Penalaran seimbang standar',
        value: 'medium',
        default: botSettings.effort === 'medium'
      },
      {
        label: 'Cepat (low)',
        description: 'Respon cepat dengan penalaran minimal',
        value: 'low',
        default: botSettings.effort === 'low'
      }
    ]);

  // 3. Dropdown Timeout
  const timeoutSelect = new StringSelectMenuBuilder()
    .setCustomId('settings_timeout')
    .setPlaceholder('Pilih Batas Waktu Proses...')
    .addOptions([
      {
        label: 'Tanpa Batas (Infinity)',
        description: 'Bebas waktu, proses berjalan sampai selesai tanpa batas',
        value: '0',
        default: botSettings.timeoutMs === 0
      },
      {
        label: '3 Menit',
        description: 'Timeout otomatis setelah 180 detik',
        value: '180000',
        default: botSettings.timeoutMs === 180_000
      },
      {
        label: '5 Menit',
        description: 'Timeout otomatis setelah 300 detik (Default)',
        value: '300000',
        default: botSettings.timeoutMs === 300_000
      },
      {
        label: '10 Menit',
        description: 'Timeout otomatis setelah 600 detik',
        value: '600000',
        default: botSettings.timeoutMs === 600_000
      },
      {
        label: '15 Menit',
        description: 'Timeout otomatis setelah 900 detik',
        value: '900000',
        default: botSettings.timeoutMs === 900_000
      },
      {
        label: '30 Menit',
        description: 'Timeout otomatis setelah 1800 detik (Tugas Berat)',
        value: '1800000',
        default: botSettings.timeoutMs === 1_800_000
      }
    ]);

  // 4. Dropdown Notifikasi
  const notifySelect = new StringSelectMenuBuilder()
    .setCustomId('settings_notify')
    .setPlaceholder('Pilih Notifikasi Selesai...')
    .addOptions([
      {
        label: 'Silent',
        description: 'Tanpa mention / tag saat tugas selesai',
        value: 'silent',
        default: botSettings.notify === 'silent'
      },
      {
        label: 'Mention (@User)',
        description: 'Tag akun Anda di chat begitu tugas selesai',
        value: 'mention',
        default: botSettings.notify === 'mention'
      }
    ]);

  // 5. Dropdown Mode Follow-up Pesan
  const currentFollowup = settingsManager.settings.followupMode || 'default';
  const followupSelect = new StringSelectMenuBuilder()
    .setCustomId('settings_followup')
    .setPlaceholder('Pilih Mode Follow-up Pesan...')
    .addOptions([
      {
        label: 'Tanya Dulu (Default)',
        description: 'Tampilkan tombol pilihan interaktif tiap ada pesan baru',
        value: 'default',
        default: currentFollowup === 'default'
      },
      {
        label: 'Otomatis Antre',
        description: 'Pesan baru otomatis masuk antrean & diproses berurutan',
        value: 'queue',
        default: currentFollowup === 'queue'
      },
      {
        label: 'Kirim Sekarang (Interupsi)',
        description: 'Stop proses sekarang & langsung jalankan pesan baru',
        value: 'steer',
        default: currentFollowup === 'steer'
      }
    ]);

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(verbositySelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(timeoutSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(notifySelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(followupSelect)
  ];
}

// Definisi 7 Slash Commands Resmi
const SLASH_COMMANDS = [
  {
    name: 'status',
    description: 'Tampilkan info sesi Claude, model, dan pemakaian jendela konteks presisi'
  },
  {
    name: 'sessions',
    description: 'Tampilkan tab project dan daftar sesi Claude yang tersimpan di PC'
  },
  {
    name: 'model',
    description: 'Tampilkan atau ganti model Claude yang aktif',
    options: [
      {
        name: 'pilih',
        description: 'Pilih nomor atau ID model (1: Opus 5.5, 2: Opus 4.6)',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: '1. Opus 5.5 (claude-opus-5-5)', value: '1' },
          { name: '2. Opus 4.6 (claude-opus-4-6)', value: '2' }
        ]
      }
    ]
  },
  {
    name: 'teleport',
    description: 'Pindah kontrol ke sesi / project Claude lain (bisa nomor 1-6 atau auto)',
    options: [
      {
        name: 'session_id',
        description: 'Nomor urut (1-6), Session ID, nama sesi, atau "auto"',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'compact',
    description: 'Ringkas riwayat obrolan sesi aktif untuk menghemat konteks token',
    options: [
      {
        name: 'instruksi',
        description: 'Instruksi khusus apa yang ingin dipertahankan dalam ringkasan (opsional)',
        type: ApplicationCommandOptionType.String,
        required: false
      }
    ]
  },
  {
    name: 'permission',
    description: 'Lihat atau ubah mode perizinan Claude Code',
    options: [
      {
        name: 'mode',
        description: 'Pilih mode perizinan',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: '1. Bypass Permissions (Lewati semua izin)', value: 'bypassPermissions' },
          { name: '2. Auto (Otomatis deteksi izin)', value: 'auto' },
          { name: '3. Accept Edits (Terima semua perubahan file)', value: 'acceptEdits' },
          { name: '4. Manual (Minta persetujuan tiap aksi)', value: 'manual' },
          { name: '5. Don\'t Ask (Jangan pernah tanya izin)', value: 'dontAsk' },
          { name: '6. Plan (Hanya rencana/baca saja)', value: 'plan' }
        ]
      }
    ]
  },
  {
    name: 'clear',
    description: 'Bersihkan tampilan chat di channel Discord (memori Claude tetap aman terjaga)'
  },
  {
    name: 'stop',
    description: 'Hentikan paksa proses Claude yang sedang berjalan saat ini'
  },
  {
    name: 'settings',
    description: 'Pusat kontrol setelan lengkap Claude (Sesi, Model, Izin, Tampilan, Effort, Timeout, Notif)'
  }
] as any;

client.once('clientReady', async (c) => {
  console.log('\x1b[36m====================================================\x1b[0m');
  console.log(`\x1b[32m  BOT CLAUDE REMOTE AKTIF: ${c.user.tag}\x1b[0m`);
  console.log(`\x1b[35m  MODE: HEADLESS NATIVE RUNNER (Anti-Timeout)\x1b[0m`);
  if (isVerboseLog) {
    console.log(`\x1b[1;33m  LOG VERBOSE: AKTIF (Live detail pesan, tool use, output)\x1b[0m`);
  }
  console.log('\x1b[36m====================================================\x1b[0m');
  
  if (config.ownerId) {
    console.log(`\x1b[33m[Security]\x1b[0m Terkunci untuk Owner ID: ${config.ownerId}`);
  } else {
    console.log(`\x1b[33m[Security]\x1b[0m Mode Auto-Claim: Kirim pesan apapun di Discord untuk mengklaim bot ini sebagai Owner!`);
  }

  // Cari sesi aktif awal
  if (isManualSessionLocked && settingsManager.settings.manualSessionId) {
    const { flatList } = getSidebarProjectGroups();
    const matched = flatList.find(s => s.sessionId === settingsManager.settings.manualSessionId);
    if (matched) {
      currentTargetSession = {
        pid: process.pid,
        sessionId: matched.sessionId,
        name: matched.title,
        cwd: matched.folder,
        status: 'idle',
        messagingSocketPath: ''
      };
      console.log(`\x1b[36m[Settings]\x1b[0m Memulihkan sesi manual terkunci: "${currentTargetSession.name}" (${currentTargetSession.sessionId})`);
    }
  }

  if (!currentTargetSession) {
    currentTargetSession = await ensureActiveSession();
  }
  if (currentTargetSession) {
    console.log(`\x1b[36m[Claude Target]\x1b[0m Terhubung ke sesi: "${currentTargetSession.name}" (${currentTargetSession.sessionId})`);
  } else {
    console.warn(`\x1b[33m[Claude Target]\x1b[0m Belum ada sesi Claude Desktop yang terdeteksi.`);
  }

  // Sinkronisasi 7 Slash Commands ke Discord API
  try {
    await c.application.commands.set(SLASH_COMMANDS);
    console.log('\x1b[32m[Slash Commands]\x1b[0m 7 Slash Commands berhasil disinkronkan ke Discord API!');
  } catch (err: any) {
    console.warn('[Slash Commands Warn]', err.message);
  }
});

// --- DISCORD NATIVE SLASH COMMANDS & COMPONENTS INTERACTION ---
client.on('interactionCreate', async (interaction) => {
  // Handler untuk Dropdown Menu (/sessions dan /settings)
  if (interaction.isStringSelectMenu()) {
    logDetail('Dropdown', `${interaction.customId} ➜ [${interaction.values.join(', ')}] oleh @${interaction.user.tag}`, '\x1b[33m');
    if (config.ownerId && interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: '⛔ Akses ditolak. Bot ini terkunci khusus untuk Owner.', ephemeral: true });
      return;
    }

    const { customId } = interaction;
    const selectedTarget = interaction.values[0];
    await interaction.deferUpdate();

    // 1. Sesi (dari /sessions atau /settings)
    if (customId === 'select_teleport_session' || customId === 'settings_session') {
      const result = await handleTeleport(selectedTarget);
      if (result.session) {
        currentTargetSession = result.session;
        isManualSessionLocked = !result.isAuto;
        settingsManager.save({
          isManualSessionLocked: !result.isAuto,
          manualSessionId: result.isAuto ? undefined : result.session.sessionId
        });
      }

      const activeSession = await ensureActiveSession();
      if (customId === 'select_teleport_session') {
        const updatedCard = handleSessions(activeSession);
        const updatedDropdown = buildSessionsDropdown(activeSession);
        await interaction.editReply({
          content: safeContent(updatedCard),
          components: updatedDropdown ? [updatedDropdown] : []
        });
      } else {
        await interaction.editReply({
          content: safeContent(renderCoreSettingsCard(activeSession)),
          components: buildCoreSettingsComponents(activeSession)
        });
      }
      return;
    }

    // 2. Model AI (/settings)
    if (customId === 'settings_model') {
      await handleModel(currentTargetSession, selectedTarget);
      const activeSession = await ensureActiveSession();
      await interaction.editReply({
        content: safeContent(renderCoreSettingsCard(activeSession)),
        components: buildCoreSettingsComponents(activeSession)
      });
      return;
    }

    // 3. Mode Izin (/settings)
    if (customId === 'settings_permission') {
      handlePermission(selectedTarget);
      const activeSession = await ensureActiveSession();
      await interaction.editReply({
        content: safeContent(renderCoreSettingsCard(activeSession)),
        components: buildCoreSettingsComponents(activeSession)
      });
      return;
    }

    // 4. Gaya Tampilan Verbosity (/settings)
    if (customId === 'settings_verbosity') {
      botSettings.verbosity = selectedTarget as any;
      settingsManager.update('verbosity', selectedTarget as any);
      await interaction.editReply({
        content: safeContent(renderSystemSettingsCard()),
        components: buildSystemSettingsComponents()
      });
      return;
    }

    // 5. Level Berpikir / Effort (/settings)
    if (customId === 'settings_effort') {
      botSettings.effort = selectedTarget as any;
      settingsManager.update('effort', selectedTarget as any);
      await interaction.editReply({
        content: safeContent(renderSystemSettingsCard()),
        components: buildSystemSettingsComponents()
      });
      return;
    }

    // 6. Batas Waktu Timeout (/settings)
    if (customId === 'settings_timeout') {
      const ms = parseInt(selectedTarget, 10);
      botSettings.timeoutMs = ms;
      settingsManager.update('timeoutMs', ms);
      await interaction.editReply({
        content: safeContent(renderSystemSettingsCard()),
        components: buildSystemSettingsComponents()
      });
      return;
    }

    // 7. Notifikasi Selesai (/settings)
    if (customId === 'settings_notify') {
      botSettings.notify = selectedTarget as any;
      settingsManager.update('notify', selectedTarget as any);
      await interaction.editReply({
        content: safeContent(renderSystemSettingsCard()),
        components: buildSystemSettingsComponents()
      });
      return;
    }

    // 8. Mode Follow-up Pesan (/settings)
    if (customId === 'settings_followup') {
      settingsManager.update('followupMode', selectedTarget as any);
      await interaction.editReply({
        content: safeContent(renderSystemSettingsCard()),
        components: buildSystemSettingsComponents()
      });
      return;
    }

    return;
  }

  // Handler untuk Tombol Interaktif (misal Tombol Stop & Follow-up Action)
  if (interaction.isButton()) {
    const { customId } = interaction;

    if (config.ownerId && interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: '⛔ Akses ditolak. Bot ini terkunci khusus untuk Owner.', ephemeral: true });
      return;
    }

    // 1. Tombol Stop / Batalkan Task Utama
    if (customId.startsWith('stop_')) {
      if (activeRunner) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => {});
        }
        activeRunner.abort('user');
      } else {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: 'ℹ️ Tidak ada proses Claude yang sedang berjalan.', ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    // 2. Tombol Pilihan Follow-up: Masukkan Antrean
    if (customId.startsWith('fp_queue_')) {
      const id = customId.replace('fp_queue_', '');
      const item = pendingFollowups.get(id);
      if (!item) {
        await interaction.reply({ content: 'ℹ️ Pilihan ini sudah kadaluarsa atau sudah diproses.', ephemeral: true }).catch(() => {});
        return;
      }
      pendingFollowups.delete(id);
      messageQueue.push(item);

      const steerBtn = new ButtonBuilder()
        .setCustomId(`queue_steer_${item.id}`)
        .setLabel('⚡ Kirim Sekarang')
        .setStyle(ButtonStyle.Primary);

      const cancelBtn = new ButtonBuilder()
        .setCustomId(`queue_cancel_${item.id}`)
        .setLabel('❌ Batalkan Antrean')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(steerBtn, cancelBtn);

      await interaction.update({
        content: `📥 **[Antrean #${messageQueue.length}]** Instruksi dimasukkan ke antrean.\nAkan diproses otomatis begitu langkah aktif selesai.`,
        components: [row]
      }).catch(() => {});
      return;
    }

    // 3. Tombol Pilihan Follow-up: Kirim Sekarang / Interupsi Langsung
    if (customId.startsWith('fp_steer_') || customId.startsWith('queue_steer_')) {
      const id = customId.startsWith('fp_steer_') ? customId.replace('fp_steer_', '') : customId.replace('queue_steer_', '');
      let item = pendingFollowups.get(id);
      if (item) {
        pendingFollowups.delete(id);
      } else {
        const qIdx = messageQueue.findIndex(q => q.id === id);
        if (qIdx !== -1) {
          item = messageQueue.splice(qIdx, 1)[0];
        }
      }

      if (!item) {
        await interaction.reply({ content: 'ℹ️ Pilihan ini sudah kadaluarsa atau sudah diproses.', ephemeral: true }).catch(() => {});
        return;
      }

      await interaction.update({
        content: `⚡ **[Interupsi]** Menghentikan proses sebelumnya & langsung menjalankan instruksi ini...`,
        components: []
      }).catch(() => {});

      if (activeRunner) {
        isCurrentAbortForSteer = true;
        activeRunner.abort('user');
      }

      setTimeout(async () => {
        const currentSession = await ensureActiveSession();
        if (currentSession) {
          await executeClaudeTurn(item.message, item.rawText, currentSession, true);
        }
      }, 700);
      return;
    }

    // 4. Tombol Batalkan Follow-up / Antrean
    if (customId.startsWith('fp_cancel_') || customId.startsWith('queue_cancel_')) {
      const id = customId.startsWith('fp_cancel_') ? customId.replace('fp_cancel_', '') : customId.replace('queue_cancel_', '');
      pendingFollowups.delete(id);
      const qIdx = messageQueue.findIndex(q => q.id === id);
      if (qIdx !== -1) {
        messageQueue.splice(qIdx, 1);
      }

      await interaction.update({
        content: '❌ Instruksi dibatalkan.',
        components: []
      }).catch(() => {});
      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  logDetail('Slash Command', `/${commandName} dijalankan oleh @${interaction.user.tag}`, '\x1b[1;33m');

  // Security whitelist check
  if (config.ownerId && interaction.user.id !== config.ownerId) {
    await interaction.reply({ content: '⛔ Akses ditolak. Bot ini terkunci khusus untuk Owner.', ephemeral: true });
    return;
  }

  try {
    const activeSession = await ensureActiveSession();

    // 1. /status
    if (commandName === 'status') {
      const card = handleStatus(activeSession);
      await interaction.reply({ content: safeContent(card), ephemeral: true });
      return;
    }

    // 2. /sessions
    if (commandName === 'sessions') {
      const card = handleSessions(activeSession);
      const dropdownRow = buildSessionsDropdown(activeSession);
      await interaction.reply({
        content: safeContent(card),
        components: dropdownRow ? [dropdownRow] : [],
        ephemeral: true
      });
      return;
    }

    // 3. /model
    if (commandName === 'model') {
      const chosen = interaction.options.getString('pilih');
      await interaction.deferReply({ ephemeral: true });
      const card = await handleModel(activeSession, chosen);
      await interaction.editReply(safeContent(card));
      return;
    }

    // 4. /teleport
    if (commandName === 'teleport') {
      const target = interaction.options.getString('session_id', true);
      await interaction.deferReply({ ephemeral: true });
      const result = await handleTeleport(target);
      if (result.session) {
        currentTargetSession = result.session;
        isManualSessionLocked = !result.isAuto;
        settingsManager.save({
          isManualSessionLocked: !result.isAuto,
          manualSessionId: result.isAuto ? undefined : result.session.sessionId
        });
      }
      await interaction.editReply(safeContent(result.message));
      return;
    }

    // 5. /compact
    if (commandName === 'compact') {
      const instruction = interaction.options.getString('instruksi') || '';
      await interaction.deferReply({ ephemeral: true });
      const result = await handleCompact(activeSession, instruction);
      await interaction.editReply(safeContent(result.message));
      return;
    }

    // 6. /permission
    if (commandName === 'permission') {
      const mode = interaction.options.getString('mode');
      const card = handlePermission(mode);
      await interaction.reply({ content: safeContent(card), ephemeral: true });
      return;
    }

    // 7. /clear (Bersihkan tampilan chat di Discord tanpa menyentuh memori Claude)
    if (commandName === 'clear') {
      if (interaction.guild && interaction.channel && 'bulkDelete' in interaction.channel) {
        await interaction.deferReply({ ephemeral: true });
        try {
          const fetched = await interaction.channel.messages.fetch({ limit: 100 });
          const deletable = fetched.filter(m => (Date.now() - m.createdTimestamp) < 14 * 24 * 60 * 60 * 1000);
          if (deletable.size > 0) {
            await (interaction.channel as any).bulkDelete(deletable, true);
          }
          await interaction.editReply('🧹 Channel telah dibersihkan. Memori & riwayat Claude tetap aman terjaga!');
        } catch (err: any) {
          await interaction.editReply(`❌ Gagal membersihkan pesan: ${err.message}`);
        }
      } else {
        await interaction.reply({
          content: 'ℹ️ Di DM, Discord tidak mengizinkan bot menghapus pesan user karena kebijakan privasi.\nGunakan Channel Server untuk fitur pembersihan layar penuh.\n*(Catatan: Memori sesi Claude Anda tetap aman utuh).*',
          ephemeral: true
        });
      }
      return;
    }

    // 8. /stop
    if (commandName === 'stop') {
      if (!activeRunner && messageQueue.length === 0) {
        await interaction.reply({ content: 'ℹ️ Tidak ada proses Claude yang sedang berjalan atau mengantre.', ephemeral: true });
        return;
      }
      if (activeRunner) activeRunner.abort('user');
      const queueCount = messageQueue.length;
      messageQueue.length = 0;
      pendingFollowups.clear();
      const text = queueCount > 0
        ? `⏹️ **[Stop]** Proses Claude dan ${queueCount} pesan dalam antrean berhasil dihentikan paksa.`
        : '⏹️ **[Stop]** Proses Claude berhasil dihentikan paksa.';
      await interaction.reply({ content: text, ephemeral: true });
      return;
    }

    // 9. /settings (2 Bubble Pengaturan - Ephemeral)
    if (commandName === 'settings') {
      const coreCard = renderCoreSettingsCard(activeSession);
      const coreRows = buildCoreSettingsComponents(activeSession);
      await interaction.reply({
        content: safeContent(coreCard),
        components: coreRows,
        ephemeral: true
      });

      const sysCard = renderSystemSettingsCard();
      const sysRows = buildSystemSettingsComponents();
      await interaction.followUp({
        content: safeContent(sysCard),
        components: sysRows,
        ephemeral: true
      });
      return;
    }
  } catch (err: any) {
    console.error(`[Command Error: /${commandName}]`, err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ Terjadi kesalahan saat memproses /${commandName}: ${err.message}`);
    } else {
      await interaction.reply({ content: `❌ Terjadi kesalahan: ${err.message}`, ephemeral: true });
    }
  }
});

// --- QUEUE PROCESSOR & CLAUDE TURN EXECUTOR ---
function checkAndProcessNextQueue() {
  if (isCurrentAbortForSteer) {
    isCurrentAbortForSteer = false;
    return;
  }

  if (messageQueue.length === 0) return;

  const nextItem = messageQueue.shift()!;
  setTimeout(async () => {
    if (nextItem.interactiveMessage) {
      await nextItem.interactiveMessage.edit({
        content: `▶️ **[Memproses Antrean]** Menjalankan instruksi: "${nextItem.rawText.slice(0, 80)}"`,
        components: []
      }).catch(() => {});
    }
    const currentSession = await ensureActiveSession();
    if (currentSession) {
      await executeClaudeTurn(nextItem.message, nextItem.rawText, currentSession, false);
    }
  }, 700);
}

/**
 * Mengeksekusi satu turn perintah Claude secara headless dengan multi-bubble delivery
 */
async function executeClaudeTurn(
  message: Message,
  rawText: string,
  activeSession: ClaudeSession,
  isSteer: boolean = false
) {
  const hasAttachments = message.attachments.size > 0;

  // UI Setup: Siapkan pesan progress di Discord dengan Stop Button
  const stopButtonId = `stop_${Date.now()}`;
  const stopButton = new ButtonBuilder()
    .setCustomId(stopButtonId)
    .setLabel('⏹️ Stop / Batalkan')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

  const initialMsg = new MessageBuilder()
    .status('running', isSteer ? '⚡ Mengalihkan instruksi & memproses...' : 'Menghubungkan ke sesi Claude & memproses...')
    .build();

  const replyMessage = await message.reply({
    content: initialMsg,
    components: [row]
  });

  // State Pelacak Alur Eksekusi & Multi-Bubble Delivery
  const steps: StepRecord[] = [];
  const turnSources: string[] = [];
  let isDone = false;
  let statusText = isSteer ? 'Mengalihkan ke instruksi baru...' : 'Claude sedang berpikir...';
  const bubbleMessages: Message[] = [replyMessage];
  const lastKnownBubbles: string[] = [''];
  let isUpdating = false;
  let pendingUpdate = false;
  let pendingFinished = false;
  let pendingMedia: DetectedMediaFile[] | undefined;
  let lastEditTime = 0;
  let editTimer: NodeJS.Timeout | null = null;

  // Setup Runner Headless
  const sessionModel = getSessionModel(activeSession.sessionId);
  logDetail('Sesi Target', `"${activeSession.name}" (${activeSession.sessionId.slice(0, 8)}...) | Folder: ${activeSession.cwd} | Model: ${sessionModel}`, '\x1b[1;34m');

  const runner = new ClaudeHeadless({
    session: activeSession.sessionId,
    cwd: activeSession.cwd,
    model: sessionModel,
    permission: currentPermissionMode,
    message: rawText,
    timeout: botSettings.timeoutMs
  }).effort(botSettings.effort);

  // Lampirkan attachments dari Discord jika ada
  if (hasAttachments) {
    const attachList = message.attachments.map(att => ({
      url: att.url,
      name: att.name,
      contentType: att.contentType || undefined
    }));
    runner.attachments(attachList);
  }

  activeRunner = runner;

  // Fungsi pengiriman & update multi-bubble Discord (Anti-Potong Codeblock)
  const performDiscordUpdate = async (finished: boolean = false, mediaFiles?: DetectedMediaFile[]) => {
    const targetBubbles = packStepsIntoBubbles(
      steps,
      botSettings.verbosity,
      finished ? undefined : `⚙️ *${statusText}*`,
      1850
    );

    for (let i = 0; i < targetBubbles.length; i++) {
      const bubbleContent = targetBubbles[i];
      const isLastBubble = i === targetBubbles.length - 1;

      if (i < bubbleMessages.length) {
        // Bubble sudah ada di Discord
        const existingMsg = bubbleMessages[i];
        const isCurrentActive = isLastBubble && !finished;
        const targetComponents = isCurrentActive ? [row] : [];

        const contentChanged = lastKnownBubbles[i] !== bubbleContent;
        const componentsNeedClear = !isCurrentActive && existingMsg.components.length > 0;

        if (contentChanged || componentsNeedClear || (finished && isLastBubble)) {
          if (finished && isLastBubble && mediaFiles && mediaFiles.length > 0) {
            const filesToSend = mediaFiles.slice(0, 10).map(f => ({
              attachment: f.path,
              name: f.name
            }));
            try {
              await existingMsg.edit({ content: bubbleContent, files: filesToSend, components: [] });
              lastKnownBubbles[i] = bubbleContent;
              console.log(`\x1b[32m[Auto-Attach Media]\x1b[0m Berhasil melampirkan ${filesToSend.length} media ke Discord: ${mediaFiles.map(f => f.name).join(', ')}`);
              continue;
            } catch (err: any) {
              console.warn('[Auto-Attach Edit Fallback]', err.message);
              await existingMsg.edit({ content: bubbleContent, components: [] }).catch(() => {});
              await message.reply({ files: filesToSend }).catch((e: any) => console.error('[Auto-Attach Send Error]', e));
              lastKnownBubbles[i] = bubbleContent;
              continue;
            }
          }

          try {
            await existingMsg.edit({
              content: bubbleContent,
              components: targetComponents
            });
            lastKnownBubbles[i] = bubbleContent;
          } catch (err: any) {
            console.warn(`[Discord Edit Bubble ${i + 1} Warn]`, err.message);
          }
        }
      } else {
        // Perlu kirim bubble baru ke channel
        const prevIdx = bubbleMessages.length - 1;
        if (prevIdx >= 0 && bubbleMessages[prevIdx].components.length > 0) {
          await bubbleMessages[prevIdx].edit({ components: [] }).catch(() => {});
        }

        const isCurrentActive = isLastBubble && !finished;
        const targetComponents = isCurrentActive ? [row] : [];

        try {
          const newMsg = await (message.channel as any).send({
            content: bubbleContent,
            components: targetComponents
          });
          bubbleMessages.push(newMsg);
          lastKnownBubbles.push(bubbleContent);
        } catch (err: any) {
          console.error(`[Discord Send Bubble ${i + 1} Error]`, err);
        }
      }
    }
  };

  // Throttled Editor: maksimal 1 update tiap 1.2 detik agar tidak kena Discord Rate-Limit
  const triggerDiscordUpdate = async (finished: boolean = false, mediaFiles?: DetectedMediaFile[]) => {
    if (finished) pendingFinished = true;
    if (mediaFiles) pendingMedia = mediaFiles;

    if (finished) {
      if (editTimer) clearTimeout(editTimer);
      if (isUpdating) {
        pendingUpdate = true;
        return;
      }
      isUpdating = true;
      try {
        await performDiscordUpdate(true, pendingMedia);
      } finally {
        isUpdating = false;
      }
      return;
    }

    const now = Date.now();
    if (now - lastEditTime >= 1200 && !isUpdating) {
      if (editTimer) clearTimeout(editTimer);
      lastEditTime = now;
      isUpdating = true;
      try {
        await performDiscordUpdate(false);
      } finally {
        isUpdating = false;
        if (pendingUpdate) {
          pendingUpdate = false;
          triggerDiscordUpdate(pendingFinished, pendingMedia);
        }
      }
    } else if (!editTimer) {
      editTimer = setTimeout(() => {
        editTimer = null;
        triggerDiscordUpdate(pendingFinished, pendingMedia);
      }, Math.max(100, 1200 - (now - lastEditTime)));
    }
  };

  // --- LISTENERS DARI CLAUDE HEADLESS ---
  let isStreamingResponse = false;

  runner.on('status', () => {
    if (isStreamingResponse) {
      process.stdout.write('\n');
      isStreamingResponse = false;
    }
    logDetail('Claude Status', 'Claude sedang berpikir / menganalisis...', '\x1b[33m');
    statusText = 'Claude sedang berpikir / menganalisis...';
    triggerDiscordUpdate();
  });

  runner.on('api_retry', (data: { attempt: number; max: number; status: string | number; waitMs: number }) => {
    const waitSec = data.waitMs ? ` (tunggu ${(data.waitMs / 1000).toFixed(0)}s)` : '';
    statusText = `⚠️ Gateway API sibuk [${data.status}] - mencoba ulang (${data.attempt}/${data.max})${waitSec}...`;
    logDetail('API Retry', `Gateway ${data.status} ➜ Mencoba ulang (${data.attempt}/${data.max})${waitSec}`, '\x1b[1;33m');
    triggerDiscordUpdate();
  });

  runner.on('tool_use', (tool) => {
    if (isStreamingResponse) {
      process.stdout.write('\n');
      isStreamingResponse = false;
    }

    let cmd = tool.name;
    if (tool.input?.command) {
      cmd = tool.input.command;
      turnSources.push(tool.input.command);
    } else if (tool.input?.path || tool.input?.file_path) {
      cmd = `${tool.name}: ${tool.input.path || tool.input.file_path}`;
      turnSources.push(tool.input.path || tool.input.file_path);
    } else if (tool.input?.pattern) {
      cmd = `grep: ${tool.input.pattern}`;
    }

    if (tool.input?.output || tool.input?.out) {
      turnSources.push(tool.input.output || tool.input.out);
    }

    const shortCmd = cmd.replace(/\r?\n+/g, ' ').trim();
    logDetail('Tool Use', `⚙️  \x1b[1m${tool.name}\x1b[0m ➜ ${shortCmd.slice(0, 160)}${shortCmd.length > 160 ? '...' : ''}`, '\x1b[1;36m');

    steps.push({
      type: 'tool',
      toolName: tool.name,
      command: cmd,
      output: ''
    });

    statusText = `Menjalankan tool: ${tool.name}...`;
    triggerDiscordUpdate();
  });

  runner.on('tool_result', (res) => {
    if (isStreamingResponse) {
      process.stdout.write('\n');
      isStreamingResponse = false;
    }

    if (res.output) {
      turnSources.push(res.output);
    }

    const lastTool = [...steps].reverse().find(s => s.type === 'tool');
    if (lastTool) {
      lastTool.output = res.output || '';
      lastTool.isError = res.isError;
    }

    const shortOut = (res.output || '').replace(/\r?\n+/g, ' ').trim();
    const statusColor = res.isError ? '\x1b[31m[ERROR]\x1b[0m' : '\x1b[32m[OK]\x1b[0m';
    logDetail('Tool Result', `${statusColor} ${shortOut.slice(0, 120)}${shortOut.length > 120 ? '...' : ''}`, '\x1b[32m');

    statusText = 'Menganalisis hasil tool...';
    triggerDiscordUpdate();
  });

  runner.on('turn_complete', (summary) => {
    if (isStreamingResponse) {
      process.stdout.write('\n');
      isStreamingResponse = false;
    }
    const inTok = summary.usage?.input_tokens ?? 0;
    const outTok = summary.usage?.output_tokens ?? 0;
    const cost = summary.costUSD ? `$${summary.costUSD.toFixed(4)}` : '-';
    logDetail('Turn Stats', `Tokens [in=${inTok}, out=${outTok}] | Biaya: ${cost}`, '\x1b[34m');
  });

  runner.on('text_delta', (chunk) => {
    turnSources.push(chunk);

    if (isVerboseLog) {
      if (!isStreamingResponse) {
        isStreamingResponse = true;
        const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
        process.stdout.write(`\x1b[1;32m[${time}] [Claude Balasan]\x1b[0m `);
      }
      process.stdout.write(chunk);
    }

    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.type === 'text') {
      lastStep.text = (lastStep.text || '') + chunk;
    } else {
      steps.push({ type: 'text', text: chunk });
    }
    triggerDiscordUpdate();
  });

  runner.on('done', async (summary) => {
    if (isStreamingResponse) {
      process.stdout.write('\n');
      isStreamingResponse = false;
    } else if (isVerboseLog && summary.text) {
      logDetail('Claude Balasan', `\x1b[1;37m${summary.text}\x1b[0m`, '\x1b[1;32m');
    }

    isDone = true;
    activeRunner = null;

    if (summary.text) {
      turnSources.push(summary.text);
      const hasTextStep = steps.some(s => s.type === 'text' && s.text?.includes(summary.text));
      if (!hasTextStep && steps.length === 0) {
        steps.push({ type: 'text', text: summary.text });
      }
    }

    // Deteksi file media (gambar & audio) yang dihasilkan dan BENAR-BENAR ADA di disk
    const detectedMedia = detectTurnMediaFiles({
      turnSources,
      cwd: activeSession.cwd
    });

    if (detectedMedia.length > 0) {
      logDetail('Media Terdeteksi', `📎 Ditemukan ${detectedMedia.length} file di disk: ${detectedMedia.map(f => `${f.name} (${(f.size / 1024).toFixed(1)} KB)`).join(', ')}`, '\x1b[1;32m');
    }

    await triggerDiscordUpdate(true, detectedMedia);
    const lastMsg = bubbleMessages[bubbleMessages.length - 1] || replyMessage;
    lastMsg.react('✅').catch(() => {});
    if (botSettings.notify === 'mention') {
      message.reply({ content: `🔔 <@${message.author.id}> Tugas selesai!` }).catch(() => {});
    }
    const logDesc = rawText ? rawText.slice(0, 30) : `[${message.attachments.size} Lampiran]`;
    console.log(`\x1b[32m[Headless Done]\x1b[0m Tugas "${logDesc}" selesai dengan sukses!`);

    checkAndProcessNextQueue();
  });

  runner.on('error', (err) => {
    activeRunner = null;
    logDetail('Runner Error', err.message, '\x1b[1;31m');
    if (!isDone) {
      console.error('[Headless Execution Error]', err);
      const errMsg = `❌ **[Error]** Gagal memproses perintah: ${err.message}`;
      steps.push({ type: 'text', text: errMsg });
      triggerDiscordUpdate(true);
    }
    checkAndProcessNextQueue();
  });

  runner.on('aborted', async (reason: 'user' | 'timeout' = 'user') => {
    isDone = true;
    activeRunner = null;

    if (reason === 'timeout') {
      const mins = Math.round(botSettings.timeoutMs / 60000);
      logDetail('Timeout', `Tugas dihentikan otomatis karena mencapai batas timeout ${mins} menit.`, '\x1b[1;33m');
      steps.push({
        type: 'text',
        text: `\n\n⏱️ **[Timeout ${mins} Menit]** Proses Claude otomatis dihentikan karena durasi tugas melebihi batas waktu (${mins} menit).\n💡 *Tip: Jika tugasmu panjang/kompleks (seperti testing Roblox Studio), kamu bisa menaikkan batas waktu di \`/settings\` ke 10, 15, atau 30 menit.*`
      });
    } else {
      logDetail('Aborted', 'Eksekusi dihentikan oleh pengguna (tombol Stop).', '\x1b[31m');
      steps.push({ type: 'text', text: '\n\n⏹️ **[Dibatalkan]** Eksekusi dihentikan oleh pengguna.' });
    }

    triggerDiscordUpdate(true);
    checkAndProcessNextQueue();
  });

  try {
    await runner.send();
  } catch (_) {
    // Error sudah ditangani via event listener runner.on('error')
  }
}

// --- DISCORD MESSAGE EVENT HANDLER ---
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  const rawText = message.content.trim();
  const hasAttachments = message.attachments.size > 0;
  if (!rawText && !hasAttachments) return;

  // --- 1. AUTO-CLAIM OWNER ---
  if (!config.ownerId) {
    saveOwnerId(message.author.id);
    await message.reply(`🔒 **[Security Alert]** Akun Anda (\`${message.author.tag}\` - ID: \`${message.author.id}\`) telah **didaftarkan sebagai OWNER TUNGGAL** bot ini!\nBot sekarang hanya akan merespons perintah dari Anda.`);
    return;
  }

  // --- 2. SECURITY WHITELIST CHECK ---
  if (message.author.id !== config.ownerId) {
    return;
  }

  const senderName = `@${message.author.tag}`;
  const channelName = (message.channel as any).name ? `#${(message.channel as any).name}` : 'Direct Message';
  const attachNames = message.attachments.size > 0 
    ? ` 📎 [${message.attachments.size} lampiran: ${message.attachments.map(a => a.name).join(', ')}]` 
    : '';

  logDetail('Pesan Masuk', `${senderName} di ${channelName}: "${rawText || '(hanya lampiran)'}"${attachNames}`, '\x1b[1;35m');

  // --- 3. DUKUNGAN COMMAND TEKS (PREFIX / ATAU !) ---
  const isCommand = rawText.startsWith('/') || rawText.startsWith('!');
  const cmdParts = rawText.slice(1).split(/\s+/);
  const cmd = cmdParts[0].toLowerCase();
  const cmdArg = cmdParts.slice(1).join(' ').trim();

  if (isCommand) {
    logDetail('Command Teks', `Menjalankan: /${cmd} ${cmdArg}`.trim(), '\x1b[33m');
  }

  const activeSession = await ensureActiveSession();

  if (isCommand) {
    if (cmd === 'ping') {
      const pingMs = client.ws.ping;
      const replyMsg = `🏓 Pong! Latency: **${pingMs}ms**`;
      logDetail('Bot Balasan', `🏓 Pong! Latency: ${pingMs}ms`, '\x1b[1;32m');
      await message.reply(replyMsg);
      return;
    }

    if (cmd === 'status') {
      const card = handleStatus(activeSession);
      logDetail('Bot Balasan', `Mengirim kartu status sesi (${activeSession?.name || '-'}) ke Discord`, '\x1b[1;32m');
      await message.reply(safeContent(card));
      return;
    }

    if (cmd === 'sessions' || cmd === 'sesi') {
      const card = handleSessions(activeSession);
      const dropdownRow = buildSessionsDropdown(activeSession);
      logDetail('Bot Balasan', `Mengirim daftar sesi proyek ke Discord`, '\x1b[1;32m');
      await message.reply({
        content: safeContent(card),
        components: dropdownRow ? [dropdownRow] : []
      });
      return;
    }

    if (cmd === 'model') {
      const card = await handleModel(activeSession, cmdArg || null);
      logDetail('Bot Balasan', `Model aktif: ${getSessionModel(activeSession?.sessionId)}`, '\x1b[1;32m');
      await message.reply(safeContent(card));
      return;
    }

    if (cmd === 'teleport' || cmd === 'switch') {
      if (!cmdArg) {
        const errReply = '❌ Harap masukkan nomor urut sesi (1-6), Session ID, atau "auto". Contoh: `/teleport 1` atau `/teleport auto`';
        logDetail('Bot Balasan', errReply, '\x1b[31m');
        await message.reply(errReply);
        return;
      }
      const result = await handleTeleport(cmdArg);
      if (result.session) {
        currentTargetSession = result.session;
        isManualSessionLocked = !result.isAuto;
        settingsManager.save({
          isManualSessionLocked: !result.isAuto,
          manualSessionId: result.isAuto ? undefined : result.session.sessionId
        });
      }
      logDetail('Bot Balasan', result.message.replace(/```[a-z]*\n?/g, '').trim(), '\x1b[1;32m');
      await message.reply(safeContent(result.message));
      return;
    }

    if (cmd === 'compact') {
      logDetail('Bot Balasan', '⏳ Meringkas riwayat sesi (compacting)...', '\x1b[33m');
      const waitMsg = await message.reply('⏳ Sedang meringkas riwayat sesi (compacting)...');
      const result = await handleCompact(activeSession, cmdArg);
      logDetail('Bot Balasan', result.message.replace(/```[a-z]*\n?/g, '').trim(), '\x1b[1;32m');
      await waitMsg.edit(safeContent(result.message));
      return;
    }

    if (cmd === 'permission' || cmd === 'izin') {
      const card = handlePermission(cmdArg || null);
      logDetail('Bot Balasan', `Mode izin: ${currentPermissionMode}`, '\x1b[1;32m');
      await message.reply(safeContent(card));
      return;
    }

    if (cmd === 'clear') {
      logDetail('Bot Balasan', 'Membersihkan pesan Discord...', '\x1b[33m');
      if (message.guild && message.channel && 'bulkDelete' in message.channel) {
        try {
          const fetched = await message.channel.messages.fetch({ limit: 100 });
          const deletable = fetched.filter(m => (Date.now() - m.createdTimestamp) < 14 * 24 * 60 * 60 * 1000);
          if (deletable.size > 0) {
            await (message.channel as any).bulkDelete(deletable, true);
          }
          const notifyMsg = await (message.channel as any).send('🧹 Channel Discord telah dibersihkan. Memori Claude tetap aman!');
          setTimeout(() => notifyMsg.delete().catch(() => {}), 5000);
        } catch (err: any) {
          await message.reply(`❌ Gagal membersihkan pesan: ${err.message}`);
        }
      } else {
        await message.reply('ℹ️ Di DM, Discord tidak mengizinkan bot menghapus pesan pengguna.\nGunakan Channel Server untuk pembersihan layar.\n*(Catatan: Memori sesi Claude Anda tetap aman utuh).*');
      }
      return;
    }

    if (cmd === 'stop' || cmd === 'abort' || cmd === 'cancel') {
      if (!activeRunner && messageQueue.length === 0) {
        logDetail('Bot Balasan', 'Tidak ada proses Claude yang sedang berjalan.', '\x1b[33m');
        await message.reply('ℹ️ Tidak ada proses Claude yang sedang berjalan saat ini.');
        return;
      }
      if (activeRunner) activeRunner.abort('user');
      const queueCount = messageQueue.length;
      messageQueue.length = 0;
      pendingFollowups.clear();
      const text = queueCount > 0
        ? `⏹️ **[Stop]** Proses Claude dan ${queueCount} pesan dalam antrean berhasil dihentikan paksa.`
        : '⏹️ **[Stop]** Proses Claude berhasil dihentikan paksa.';
      logDetail('Bot Balasan', text, '\x1b[1;31m');
      await message.reply(text);
      return;
    }

    if (cmd === 'settings' || cmd === 'setelan') {
      const coreCard = renderCoreSettingsCard(activeSession);
      const coreRows = buildCoreSettingsComponents(activeSession);
      await message.reply({
        content: safeContent(coreCard),
        components: coreRows
      });

      const sysCard = renderSystemSettingsCard();
      const sysRows = buildSystemSettingsComponents();
      await (message.channel as any).send({
        content: safeContent(sysCard),
        components: sysRows
      });
      return;
    }
  }

  // --- 4. EKSEKUSI PROMPT ATAU FOLLOW-UP KE HEADLESS CLAUDE RUNNER ---
  if (!activeSession) {
    await message.reply('❌ Gagal terhubung ke Claude: Tidak ada sesi Claude yang ditemukan di PC.');
    return;
  }

  // Jika Claude sedang memproses perintah sebelumnya (Follow-up Handlers)
  if (activeRunner) {
    const followupMode = settingsManager.settings.followupMode || 'default';

    // 1. Mode Antre Otomatis (Queue)
    if (followupMode === 'queue') {
      const queueItem: QueuedItem = {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        message,
        rawText,
        activeSession,
        timestamp: Date.now()
      };
      messageQueue.push(queueItem);

      const steerBtn = new ButtonBuilder()
        .setCustomId(`queue_steer_${queueItem.id}`)
        .setLabel('⚡ Kirim Sekarang')
        .setStyle(ButtonStyle.Primary);

      const cancelBtn = new ButtonBuilder()
        .setCustomId(`queue_cancel_${queueItem.id}`)
        .setLabel('❌ Batalkan Antrean')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(steerBtn, cancelBtn);

      const notice = await message.reply({
        content: `📥 **[Antrean #${messageQueue.length}]** Instruksi dicatat ke antrean.\nAkan otomatis dijalankan begitu tugas aktif selesai.`,
        components: [row]
      });
      queueItem.interactiveMessage = notice;
      logDetail('Follow-up Queue', `Pesan masuk antrean #${messageQueue.length}: "${rawText.slice(0, 50)}"`, '\x1b[33m');
      return;
    }

    // 2. Mode Kirim Sekarang (Interupsi Langsung / Steer)
    if (followupMode === 'steer') {
      await message.reply('⚡ **[Interupsi]** Menghentikan proses sebelumnya & langsung menjalankan instruksi terbaru...');
      logDetail('Follow-up Steer', `Menginterupsi proses aktif untuk: "${rawText.slice(0, 50)}"`, '\x1b[1;33m');
      isCurrentAbortForSteer = true;
      activeRunner.abort('user');
      setTimeout(async () => {
        await executeClaudeTurn(message, rawText, activeSession, true);
      }, 700);
      return;
    }

    // 3. Mode Default: Tampilkan 3 Tombol Pilihan Interaktif
    const pendingId = `fp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const pendingItem: QueuedItem = {
      id: pendingId,
      message,
      rawText,
      activeSession,
      timestamp: Date.now()
    };
    pendingFollowups.set(pendingId, pendingItem);

    const queueBtn = new ButtonBuilder()
      .setCustomId(`fp_queue_${pendingId}`)
      .setLabel('📥 Masukkan Antrean')
      .setStyle(ButtonStyle.Primary);

    const steerBtn = new ButtonBuilder()
      .setCustomId(`fp_steer_${pendingId}`)
      .setLabel('⚡ Kirim Sekarang')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`fp_cancel_${pendingId}`)
      .setLabel('❌ Batalkan')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(queueBtn, steerBtn, cancelBtn);

    const choiceNotice = await message.reply({
      content: `⏳ **Claude sedang memproses perintah sebelumnya.**\nApa yang ingin kamu lakukan dengan instruksi baru ini?`,
      components: [row]
    });
    pendingItem.interactiveMessage = choiceNotice;
    logDetail('Follow-up Prompt', `Menampilkan pilihan follow-up untuk: "${rawText.slice(0, 50)}"`, '\x1b[33m');
    return;
  }

  // Jika idle, langsung jalankan turn normal
  await executeClaudeTurn(message, rawText, activeSession, false);
});

client.login(config.discordToken).catch(err => {
  console.error('\x1b[31m[Login Error]\x1b[0m Gagal login ke Discord:', err.message);
  process.exit(1);
});
