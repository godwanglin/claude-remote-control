import * as p from '@clack/prompts';
import { 
  config, 
  saveCredentials, 
  saveOwnerId, 
  verifyDiscordToken, 
  verifyDiscordOwner, 
  getBotInviteUrl 
} from './config.js';
import { 
  getDaemonState, 
  startDaemon, 
  stopDaemon, 
  restartDaemon, 
  streamLogs 
} from './daemon.js';
import { settingsManager } from './settings-manager.js';
import { getSidebarProjectGroups } from './session-browser.js';
import { getRuntimePaths } from './runtime-paths.js';
import { syncChannelsWithSessions, clearCategoryChannels } from './channel-manager.js';

export function printTokenMissingCard(): void {
  console.log(`
\x1b[1;33m╭──────────────────────────────────────────────────────────╮\x1b[0m
\x1b[1;33m│\x1b[0m  \x1b[1;31m⚠️  DISCORD BOT TOKEN BELUM DIATUR                      \x1b[0m\x1b[1;33m│\x1b[0m
\x1b[1;33m│\x1b[0m                                                          \x1b[1;33m│\x1b[0m
\x1b[1;33m│\x1b[0m  Token bot Discord belum disetel di kredensial CRC!      \x1b[1;33m│\x1b[0m
\x1b[1;33m│\x1b[0m                                                          \x1b[1;33m│\x1b[0m
\x1b[1;33m│\x1b[0m  \x1b[1;36mCara setup mudah:\x1b[0m                                       \x1b[1;33m│\x1b[0m
\x1b[1;33m│\x1b[0m    1. Jalankan wizard interaktif:  \x1b[1;32mcrc setup\x1b[0m              \x1b[1;33m│\x1b[0m
\x1b[1;33m│\x1b[0m    2. Atau setel via CLI:          \x1b[1;32mcrc discord token <KEY>\x1b[0m \x1b[1;33m│\x1b[0m
\x1b[1;33m╰──────────────────────────────────────────────────────────╯\x1b[0m
`);
}

function handleCancel(value: any) {
  if (p.isCancel(value)) {
    p.cancel('Operasi dibatalkan.');
    process.exit(0);
  }
}

/**
 * Setup Wizard interaktif ramah pemula untuk konfigurasi awal bot
 */
export async function runSetupWizard(): Promise<void> {
  console.clear();
  p.intro('\x1b[1;36m✨ CLAUDE REMOTE CONTROL (CRC) — SETUP WIZARD\x1b[0m');

  // 1. Input Discord Bot Token
  const tokenInput = await p.password({
    message: 'Masukkan Discord Bot Token:',
    mask: '•'
  });
  handleCancel(tokenInput);

  const token = (tokenInput as string).trim();
  if (!token) {
    p.log.error('Token tidak boleh kosong.');
    p.outro('Setup dibatalkan.');
    return;
  }

  // 2. Verifikasi token ke Discord API
  const s = p.spinner();
  s.start('Menghubungkan & memvalidasi token ke Discord REST API...');
  const tokenCheck = await verifyDiscordToken(token);

  if (!tokenCheck.valid || !tokenCheck.botUser) {
    s.stop(`\x1b[31m❌ Token tidak valid!\x1b[0m ${tokenCheck.error || ''}`);
    p.outro('Silakan periksa kembali token bot dari Discord Developer Portal.');
    return;
  }

  const botUser = tokenCheck.botUser;
  s.stop(`\x1b[32m✔ Token valid!\x1b[0m Terhubung ke bot: \x1b[1;32m${botUser.username}#${botUser.discriminator || '0000'}\x1b[0m (ID: ${botUser.id})`);

  // 3. Input Owner ID (Opsional)
  const ownerInput = await p.text({
    message: 'Masukkan User ID Discord Owner (opsional, tekan Enter untuk auto-claim saat chat pertama):',
    placeholder: config.ownerId || 'Contoh: 1036530575948927018'
  });
  handleCancel(ownerInput);

  let ownerId = (ownerInput as string).trim();
  if (ownerId) {
    s.start('Memverifikasi akun Owner ID ke Discord API...');
    const ownerCheck = await verifyDiscordOwner(token, ownerId);
    if (ownerCheck.valid && ownerCheck.user) {
      s.stop(`\x1b[32m✔ Owner ditemukan!\x1b[0m Terdaftar untuk: \x1b[1;32m@${ownerCheck.user.username}\x1b[0m`);
    } else {
      s.stop(`\x1b[33m⚠️ Owner ID disimpan\x1b[0m (${ownerCheck.error || 'Akan diverifikasi saat online'})`);
    }
  }

  // 4. Simpan Kredensial Permanen
  saveCredentials(token, ownerId || undefined);
  p.log.success('Kredensial berhasil disimpan di runtime config!');

  // 5. Tampilkan Invite Link Siap Klik
  const inviteUrl = getBotInviteUrl(botUser.id);
  p.note(inviteUrl, '🔗 Link Invite Bot ke Server Discord:');

  // 6. Pilihan Tindakan Berikutnya
  const nextAction = await p.select({
    message: 'Pilih aksi untuk menjalankan bot sekarang:',
    options: [
      { label: '🚀 Jalankan di System Tray (Taskbar Windows)', value: 'tray', hint: 'Recommended' },
      { label: '🖥️ Jalankan langsung di Terminal (Foreground)', value: 'start' },
      { label: '🚪 Selesai (Nanti jalankan manual)', value: 'exit' }
    ]
  });
  handleCancel(nextAction);

  if (nextAction === 'tray') {
    s.start('Memulai background daemon System Tray...');
    await startDaemon('tray');
    s.stop('\x1b[32m✔ System Tray aktif!\x1b[0m Periksa taskbar kanan bawah Windows.');
  } else if (nextAction === 'start') {
    p.outro('Menjalankan bot di terminal...');
    return;
  }

  p.outro('🎉 Setup selesai! Selamat menggunakan Claude Remote Control.');
}

/**
 * Submenu interaktif untuk melihat & mengubah Setelan Sistem AI
 */
async function handleSettingsMenu(): Promise<void> {
  while (true) {
    const cur = settingsManager.settings;
    const timeoutDesc = cur.timeoutMs === 0 ? 'Infinity' : `${cur.timeoutMs / 60000}m`;

    const settingsCard = [
      `Model Default : \x1b[1;33m${cur.defaultModel}\x1b[0m`,
      `Effort Level  : \x1b[1;36m${cur.effort}\x1b[0m`,
      `Timeout       : \x1b[1;35m${timeoutDesc}\x1b[0m`,
      `Follow-up Mode: \x1b[1;32m${cur.followupMode}\x1b[0m`,
      `Verbosity     : \x1b[1;37m${cur.verbosity}\x1b[0m`,
      `Mode Izin     : \x1b[1;34m${cur.permissionMode}\x1b[0m`
    ].join('\n');

    p.note(settingsCard, '⚙️ Nilai Pengaturan AI Saat Ini:');

    const sChoice = await p.select({
      message: 'Pilih setelan yang ingin diubah:',
      options: [
        { label: '🧠 Ganti Model Default', value: 'model', hint: cur.defaultModel },
        { label: '⚡ Ganti Effort Level', value: 'effort', hint: cur.effort },
        { label: '⏱️ Ganti Timeout Prompt', value: 'timeout', hint: timeoutDesc },
        { label: '💬 Ganti Follow-up Mode', value: 'followup', hint: cur.followupMode },
        { label: '📜 Ganti Verbosity Log', value: 'verbosity', hint: cur.verbosity },
        { label: '🛡️ Ganti Mode Izin (Permission)', value: 'permission', hint: cur.permissionMode },
        { label: '↩️ Kembali ke Menu Utama', value: 'back' }
      ]
    });

    if (p.isCancel(sChoice) || sChoice === 'back') {
      return;
    }

    if (sChoice === 'model') {
      const models = settingsManager.getModels();
      const currentDef = settingsManager.settings.defaultModel;
      const modelOptions = models.map(m => ({
        label: m.name,
        value: m.id,
        hint: m.id.toLowerCase() === (currentDef || '').toLowerCase() ? '(Sedang Aktif)' : (m.desc || `Model ${m.name}`)
      }));
      const selected = await p.select({
        message: 'Pilih model Claude default:',
        options: modelOptions
      });
      if (!p.isCancel(selected)) {
        settingsManager.update('defaultModel', selected as string);
        p.log.success(`Model default diubah ke: \x1b[1;33m${selected}\x1b[0m`);
      }
    } else if (sChoice === 'effort') {
      const selected = await p.select({
        message: 'Pilih effort level (kedalaman penalaran AI):',
        options: [
          { label: 'Low', value: 'low', hint: 'Respon cepat & hemat token' },
          { label: 'Medium', value: 'medium', hint: 'Seimbang' },
          { label: 'High', value: 'high', hint: 'Penalaran mendalam' },
          { label: 'Extra High (xhigh)', value: 'xhigh', hint: 'Maksimal untuk tugas rumit' }
        ]
      });
      if (!p.isCancel(selected)) {
        settingsManager.update('effort', selected as any);
        p.log.success(`Effort level diubah ke: \x1b[1;36m${selected}\x1b[0m`);
      }
    } else if (sChoice === 'timeout') {
      const selected = await p.select({
        message: 'Pilih batas waktu eksekusi (timeout):',
        options: [
          { label: 'Tanpa Batas (Infinity)', value: 0, hint: 'Menunggu sampai Claude benar-benar selesai' },
          { label: '5 Menit', value: 300_000 },
          { label: '10 Menit', value: 600_000 },
          { label: '30 Menit', value: 1_800_000 }
        ]
      });
      if (!p.isCancel(selected)) {
        settingsManager.update('timeoutMs', selected as number);
        p.log.success(`Timeout diubah ke: \x1b[1;35m${selected === 0 ? 'Infinity' : `${(selected as number)/60000}m`}\x1b[0m`);
      }
    } else if (sChoice === 'followup') {
      const selected = await p.select({
        message: 'Pilih follow-up mode:',
        options: [
          { label: 'Steer', value: 'steer', hint: 'Koreksi instan saat Claude sedang bekerja' },
          { label: 'Default', value: 'default', hint: 'Normal tunggu giliran' },
          { label: 'Queue', value: 'queue', hint: 'Antrekan pesan berikutnya' }
        ]
      });
      if (!p.isCancel(selected)) {
        settingsManager.update('followupMode', selected as any);
        p.log.success(`Follow-up mode diubah ke: \x1b[1;32m${selected}\x1b[0m`);
      }
    } else if (sChoice === 'verbosity') {
      const selected = await p.select({
        message: 'Pilih verbosity tampilan log:',
        options: [
          { label: 'Detail', value: 'detail', hint: 'Tampilkan langkah tool, pemikiran, & status' },
          { label: 'Compact', value: 'compact', hint: 'Ringkas, hanya output akhir' }
        ]
      });
      if (!p.isCancel(selected)) {
        settingsManager.update('verbosity', selected as any);
        p.log.success(`Verbosity diubah ke: \x1b[1;37m${selected}\x1b[0m`);
      }
    } else if (sChoice === 'permission') {
      const selected = await p.select({
        message: 'Pilih mode izin (permission):',
        options: [
          { label: 'Bypass Permissions (Recommended)', value: 'bypassPermissions', hint: 'Langsung eksekusi tanpa pop-up persetujuan' },
          { label: 'Auto Confirm', value: 'autoConfirm', hint: 'Otomatis setuju aksi aman' },
          { label: 'Plan', value: 'plan', hint: 'Rencanakan dulu sebelum eksekusi' },
          { label: 'Accept Edits', value: 'acceptEdits', hint: 'Otomatis terima edit file' },
          { label: 'Manual', value: 'manual', hint: 'Konfirmasi manual tiap tool' }
        ]
      });
      if (!p.isCancel(selected)) {
        settingsManager.update('permissionMode', selected as any);
        p.log.success(`Mode izin diubah ke: \x1b[1;34m${selected}\x1b[0m`);
      }
    }
  }
}

/**
 * Tampilkan Dashboard Menu Interaktif Utama
 */
export async function runInteractiveDashboard(): Promise<void> {
  while (true) {
    console.clear();
    const daemonState = getDaemonState();
    const isRunning = daemonState !== null;
    const statusBadge = isRunning 
      ? `\x1b[1;32m● AKTIF\x1b[0m (${daemonState.mode === 'tray' ? 'System Tray' : 'Headless'} - PID: ${daemonState.pid})`
      : '\x1b[1;31m○ OFFLINE\x1b[0m';

    const { flatList } = getSidebarProjectGroups();
    const activeSessionName = flatList[0]?.title || 'Tidak ada sesi terdeteksi';

    p.intro('\x1b[1;36m╭────────────────────────────────────────────────────────────╮\n│  🤖 CLAUDE REMOTE CONTROL (CRC) — DASHBOARD INTERAKTIF     │\n╰────────────────────────────────────────────────────────────╯\x1b[0m');

    p.note(
      `Status Bot  : ${statusBadge}\nSesi Utama  : \x1b[1;33m${activeSessionName}\x1b[0m\nRuntime Dir : \x1b[0;37m${getRuntimePaths().rootDir}\x1b[0m`,
      '📊 Ringkasan Sistem:'
    );

    const choice = await p.select({
      message: 'Pilih menu aksi:',
      options: [
        { label: '🚀 Kontrol Layanan (Service)', value: 'service', hint: 'Start, Stop, Restart, Status' },
        { label: '📁 Kelola Channel Discord', value: 'channels', hint: 'Sync per Proyek, Clear' },
        { label: '🔑 Pengaturan Discord & Kredensial', value: 'discord', hint: 'Token, Owner, Invite Link, Setup Wizard' },
        { label: '⚙️ Setelan Sistem AI', value: 'settings', hint: 'Ubah Model, Effort, Timeout, Permission' },
        { label: '📜 Buka Live Logs', value: 'logs', hint: 'Streaming realtime output bot' },
        { label: '🚪 Keluar', value: 'exit' }
      ]
    });

    if (p.isCancel(choice) || choice === 'exit') {
      p.outro('Sampai jumpa! 👋');
      return;
    }

    if (choice === 'service') {
      const sAction = await p.select({
        message: 'Pilih aksi layanan:',
        options: [
          { label: '▶️ Jalankan di System Tray (Taskbar Windows)', value: 'tray' },
          { label: '▶️ Jalankan di Background Headless', value: 'headless' },
          { label: '🔄 Restart Bot', value: 'restart' },
          { label: '⏹️ Stop Bot', value: 'stop' },
          { label: '↩️ Kembali ke Menu Utama', value: 'back' }
        ]
      });

      if (!p.isCancel(sAction) && sAction !== 'back') {
        if (sAction === 'tray' || sAction === 'headless') {
          const s = p.spinner();
          s.start(`Memulai layanan dalam mode ${sAction}...`);
          await startDaemon(sAction as any);
          s.stop(`✔ Layanan ${sAction} berhasil dimulai!`);
        } else if (sAction === 'restart') {
          const s = p.spinner();
          s.start('Me-restart layanan bot...');
          await restartDaemon();
          s.stop('✔ Layanan bot berhasil di-restart!');
        } else if (sAction === 'stop') {
          const s = p.spinner();
          s.start('Menghentikan layanan bot...');
          await stopDaemon();
          s.stop('✔ Layanan bot telah dihentikan.');
        }
        await new Promise(r => setTimeout(r, 1200));
      }
    } else if (choice === 'channels') {
      const cAction = await p.select({
        message: 'Pilih aksi channel Discord:',
        options: [
          { label: '🔄 Sinkronisasi Sesi Proyek Sekarang', value: 'sync', hint: 'Buat kategori per folder proyek & text channel' },
          { label: '🧹 Bersihkan Semua Channel & Kategori CRC', value: 'clear', hint: 'Hapus channel dan kategori CRC di Discord' },
          { label: '↩️ Kembali ke Menu Utama', value: 'back' }
        ]
      });

      if (!p.isCancel(cAction) && cAction !== 'back') {
        if (!config.discordToken) {
          p.log.error('DISCORD_TOKEN belum disetel. Jalankan Setup Wizard terlebih dahulu.');
          await new Promise(r => setTimeout(r, 1500));
        } else {
          const s = p.spinner();
          s.start('Menghubungkan ke Discord API...');
          try {
            const { Client, GatewayIntentBits } = await import('discord.js');
            const client = new Client({ intents: [GatewayIntentBits.Guilds] });
            await new Promise<void>((resolve, reject) => {
              client.once('clientReady', () => resolve());
              client.login(config.discordToken).catch(reject);
            });

            if (cAction === 'sync') {
              s.message('Menyinkronkan kategori proyek & channel...');
              for (const [, guild] of client.guilds.cache) {
                const res = await syncChannelsWithSessions(guild);
                p.log.success(`Server "${guild.name}": ${res.categoriesCount} kategori, +${res.createdChannels} dibuat, ${res.existingChannels} tersimpan, -${res.deletedChannels} dibersihkan.`);
              }
              s.stop('✔ Sinkronisasi selesai!');
            } else if (cAction === 'clear') {
              s.message('Membersihkan channel & kategori CRC...');
              for (const [, guild] of client.guilds.cache) {
                const res = await clearCategoryChannels(guild, true);
                p.log.success(`Server "${guild.name}": ${res.deletedChannels} channel & ${res.deletedCategories} kategori dihapus.`);
              }
              s.stop('✔ Pembersihan selesai!');
            }
            await client.destroy();
          } catch (err: any) {
            s.stop(`❌ Gagal: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } else if (choice === 'discord') {
      const dAction = await p.select({
        message: 'Pilih aksi kredensial Discord:',
        options: [
          { label: '✨ Jalankan Setup Wizard Lengkap', value: 'wizard' },
          { label: '🔗 Dapatkan Link Invite Bot', value: 'invite' },
          { label: '🔍 Cek Status & Kesehatan Koneksi', value: 'status' },
          { label: '↩️ Kembali', value: 'back' }
        ]
      });

      if (!p.isCancel(dAction) && dAction !== 'back') {
        if (dAction === 'wizard') {
          await runSetupWizard();
        } else if (dAction === 'invite') {
          const s = p.spinner();
          s.start('Mengambil info bot...');
          const check = await verifyDiscordToken(config.discordToken);
          if (check.valid && check.botUser) {
            s.stop('✔ Info bot terverifikasi.');
            const invite = getBotInviteUrl(check.botUser.id);
            p.note(invite, '🔗 Link Invite Bot ke Server Discord Anda:');
          } else {
            s.stop('❌ Token bot belum disetel atau tidak valid.');
            p.log.warn('Jalankan "Setup Wizard" terlebih dahulu untuk menyetel token.');
          }
          await new Promise(r => setTimeout(r, 2500));
        } else if (dAction === 'status') {
          const s = p.spinner();
          s.start('Memeriksa koneksi Discord API...');
          const check = await verifyDiscordToken(config.discordToken);
          if (check.valid && check.botUser) {
            s.stop(`✔ Bot: \x1b[32m${check.botUser.username}#${check.botUser.discriminator || '0000'}\x1b[0m (ID: ${check.botUser.id})`);
            p.log.info(`Owner Terdaftar: ${config.ownerId ? `ID ${config.ownerId}` : '(Belum disetel, mode auto-claim aktif)'}`);
          } else {
            s.stop(`❌ Status: Tidak terhubung (${check.error || 'Token belum disetel'})`);
          }
          await new Promise(r => setTimeout(r, 2500));
        }
      }
    } else if (choice === 'settings') {
      await handleSettingsMenu();
    } else if (choice === 'logs') {
      p.outro('Membuka live stream log (tekan Ctrl+C untuk kembali)...');
      streamLogs({ follow: true, verbose: true });
      return;
    }
  }
}
