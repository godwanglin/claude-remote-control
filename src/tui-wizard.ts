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
 * Tampilkan Dashboard Menu Interaktif Utama
 */
export async function runInteractiveDashboard(): Promise<void> {
  console.clear();
  const daemonState = getDaemonState();
  const isRunning = daemonState !== null;
  const statusBadge = isRunning 
    ? `\x1b[1;32m● AKTIF\x1b[0m (${daemonState.mode === 'tray' ? 'System Tray' : 'Headless'} - PID: ${daemonState.pid})`
    : '\x1b[1;31m○ OFFLINE\x1b[0m';

  const { flatList } = getSidebarProjectGroups();
  const activeSessionName = flatList[0]?.title || 'Tidak ada sesi terdeteksi';

  p.intro('\x1b[1;36m╭────────────────────────────────────────────────────────────╮\n│  🤖 CLAUDE REMOTE CONTROL (CRC) — DASHBOARD INTERAKTIF     │\n╰────────────────────────────────────────────────────────────╯\x1b[0m');

  console.log(`  Status Bot  : ${statusBadge}`);
  console.log(`  Sesi Utama  : \x1b[1;33m${activeSessionName}\x1b[0m`);
  console.log(`  Runtime Dir : \x1b[0;37m${getRuntimePaths().rootDir}\x1b[0m\n`);

  const choice = await p.select({
    message: 'Pilih menu aksi:',
    options: [
      { label: '🚀 Kontrol Layanan (Service)', value: 'service', hint: 'Start, Stop, Restart, Status' },
      { label: '📁 Kelola Channel Discord', value: 'channels', hint: 'Sync per Proyek, Clear' },
      { label: '🔑 Pengaturan Discord & Kredensial', value: 'discord', hint: 'Token, Owner, Invite Link, Setup Wizard' },
      { label: '⚙️ Setelan Sistem AI', value: 'settings', hint: 'Model, Effort, Timeout, Followup' },
      { label: '📜 Buka Live Logs', value: 'logs', hint: 'Streaming realtime output bot' },
      { label: '🚪 Keluar', value: 'exit' }
    ]
  });
  handleCancel(choice);

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
    handleCancel(sAction);

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
  } else if (choice === 'channels') {
    const cAction = await p.select({
      message: 'Pilih aksi channel Discord:',
      options: [
        { label: '🔄 Sinkronisasi Sesi Proyek Sekarang', value: 'sync', hint: 'Buat kategori per folder proyek & text channel' },
        { label: '🧹 Bersihkan Semua Channel & Kategori CRC', value: 'clear', hint: 'Hapus channel dan kategori CRC di Discord' },
        { label: '↩️ Kembali ke Menu Utama', value: 'back' }
      ]
    });
    handleCancel(cAction);

    if (cAction === 'sync' || cAction === 'clear') {
      if (!config.discordToken) {
        p.log.error('DISCORD_TOKEN belum disetel. Jalankan Setup Wizard terlebih dahulu.');
        return;
      }
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
    handleCancel(dAction);

    if (dAction === 'wizard') {
      await runSetupWizard();
      return;
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
    }
  } else if (choice === 'settings') {
    const current = settingsManager.settings;
    p.log.info(`Model Default : ${current.defaultModel}\nEffort Level  : ${current.effort}\nTimeout       : ${current.timeoutMs === 0 ? 'Infinity' : `${current.timeoutMs / 60000}m`}\nFollow-up Mode: ${current.followupMode}\nVerbosity     : ${current.verbosity}`);
  } else if (choice === 'logs') {
    p.outro('Membuka live stream log (tekan Ctrl+C untuk kembali)...');
    streamLogs({ follow: true, verbose: true });
    return;
  }

  p.outro('Selesai.');
}
