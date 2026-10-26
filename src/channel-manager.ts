import path from 'path';
import { 
  Guild, 
  ChannelType, 
  CategoryChannel, 
  TextChannel, 
  PermissionsBitField,
  Collection,
  EmbedBuilder
} from 'discord.js';
import { getAllProjectSessions, ProjectSessionItem } from './session-browser.js';
import { ClaudeSession } from './ipc.js';

export const DEFAULT_CATEGORY_NAME = '📁 Claude Remote';
export const SESSION_TOPIC_PREFIX = 'SessionID:';

/**
 * Sanitasi judul sesi menjadi nama channel Discord yang valid.
 * Contoh: "Layout dua panel QuestHistoryGui" -> "layout-dua-panel-questhistorygui-4491"
 */
export function sanitizeChannelName(title: string, sessionId: string): string {
  let clean = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!clean) clean = 'claude-tab';
  if (clean.length > 45) clean = clean.slice(0, 45).replace(/-+$/, '');

  const suffix = sessionId.slice(-4);
  return `${clean}-${suffix}`;
}

/**
 * Format string topic channel Discord dengan metadata sesi
 */
export function formatChannelTopic(session: ProjectSessionItem): string {
  const shortFolder = session.folder ? path.basename(session.folder) : 'project';
  return `${SESSION_TOPIC_PREFIX} ${session.sessionId} | Proyek: ${shortFolder} | Dibuat otomatis oleh Claude Remote Control`;
}

/**
 * Ekstrak Session ID dari teks topic Discord channel
 */
export function extractSessionIdFromTopic(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const match = topic.match(/SessionID:\s*([0-9a-fA-F-]{36})/i);
  return match ? match[1] : null;
}

/**
 * Cari atau buat kategori Claude Remote di guild
 */
export async function getOrCreateCategory(guild: Guild, categoryName = DEFAULT_CATEGORY_NAME): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && 
         (c.name.toLowerCase() === categoryName.toLowerCase() || c.name.toLowerCase().includes('claude remote'))
  ) as CategoryChannel | undefined;

  if (existing) {
    return existing;
  }

  const newCategory = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory
  });

  console.log(`\x1b[32m[Category Manager]\x1b[0m Kategori "${categoryName}" berhasil dibuat di server "${guild.name}" (ID: ${newCategory.id})`);
  return newCategory;
}

/**
 * Kirim embed informasi awal saat channel sesi baru pertama kali dibuat
 */
async function sendChannelWelcomeEmbed(channel: TextChannel, session: ProjectSessionItem): Promise<void> {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x00FF99)
      .setTitle(`💬 Tab Sesi: ${session.title}`)
      .setDescription('Channel ini terhubung langsung ke tab/sesi Claude Desktop di PC kamu.\nSetiap pesan yang dikirim di channel ini akan langsung dieksekusi pada sesi ini secara terisolasi.')
      .addFields(
        { name: '🆔 Session ID', value: `\`${session.sessionId}\``, inline: false },
        { name: '📁 Folder Proyek', value: `\`${session.folder}\``, inline: false },
        { name: '⚡ Status', value: '🟢 Siap Menerima Prompt', inline: true }
      )
      .setFooter({ text: 'Ketik pesan di channel ini untuk langsung mengobrol dengan Claude!' })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err: any) {
    console.warn(`[Channel Manager Warn] Gagal mengirim pesan selamat datang di #${channel.name}:`, err.message);
  }
}

export interface SyncChannelsResult {
  category: CategoryChannel;
  created: number;
  deleted: number;
  existing: number;
  totalSessions: number;
}

/**
 * Sinkronisasi 2-arah antara sesi Claude di PC dengan text channels di Discord.
 * - Sesi baru dibuatkan channel dengan rate limit safety (3 channel per detik).
 * - Sesi yang telah dihapus di PC dibersihkan dari Discord (dengan proteksi safety guard).
 */
export async function syncChannelsWithSessions(
  guild: Guild, 
  options: { maxChannels?: number; categoryName?: string } = {}
): Promise<SyncChannelsResult> {
  const maxChannels = options.maxChannels || 40;
  const category = await getOrCreateCategory(guild, options.categoryName || DEFAULT_CATEGORY_NAME);

  // Ambil semua sesi dari disk PC
  const allSessions = getAllProjectSessions();
  if (!allSessions || allSessions.length === 0) {
    console.warn('\x1b[33m[Channel Manager Warn]\x1b[0m Tidak ada sesi Claude yang terbaca dari PC. Melewati proses sinkronisasi/pembersihan untuk keamanan.');
    return {
      category,
      created: 0,
      deleted: 0,
      existing: 0,
      totalSessions: 0
    };
  }

  // Ambil N sesi terbaru (berdasarkan lastModified)
  const sortedSessions = [...allSessions].sort((a, b) => b.lastModified - a.lastModified);
  const targetSessions = sortedSessions.slice(0, maxChannels);
  const targetSessionMap = new Map<string, ProjectSessionItem>();
  for (const s of targetSessions) {
    targetSessionMap.set(s.sessionId, s);
  }

  // Dapatkan seluruh text channel di dalam kategori ini
  await guild.channels.fetch();
  const managedChannels = guild.channels.cache.filter(
    c => c.parentId === category.id && c.type === ChannelType.GuildText
  ) as Collection<string, TextChannel>;

  const existingBySessionId = new Map<string, TextChannel>();
  for (const [, ch] of managedChannels) {
    const sId = extractSessionIdFromTopic(ch.topic);
    if (sId) {
      existingBySessionId.set(sId, ch);
    }
  }

  let deletedCount = 0;
  let createdCount = 0;
  let existingCount = 0;

  // 1. PEMBERSIHAN (PRUNING) SESI YANG SUDAH DIHAPUS DI PC
  // Safety Guard: Hanya hapus jika sesi valid terbaca (> 0) dan channel memiliki SessionID di topic
  for (const [sId, ch] of existingBySessionId) {
    const isStillExistsOnPC = allSessions.some(s => s.sessionId === sId);
    if (!isStillExistsOnPC) {
      try {
        console.log(`\x1b[33m[Channel Pruner]\x1b[0m Menghapus channel #${ch.name} karena sesi Claude (${sId.slice(0, 8)}...) sudah dihapus di PC.`);
        await ch.delete('Sesi Claude telah dihapus di PC.');
        deletedCount++;
        await new Promise(r => setTimeout(r, 350));
      } catch (err: any) {
        console.error(`[Channel Pruner Error] Gagal menghapus #${ch.name}:`, err.message);
      }
    } else {
      existingCount++;
    }
  }

  // 2. PEMBUATAN CHANNEL BARU (BATCHED 3 CHANNEL PER DETIK)
  const missingSessions: ProjectSessionItem[] = [];
  for (const s of targetSessions) {
    if (!existingBySessionId.has(s.sessionId)) {
      missingSessions.push(s);
    }
  }

  if (missingSessions.length > 0) {
    console.log(`\x1b[36m[Channel Sync]\x1b[0m Ditemukan ${missingSessions.length} sesi baru. Memulai pembuatan channel bertahap (3 channel / detik)...`);

    for (let i = 0; i < missingSessions.length; i += 3) {
      const batch = missingSessions.slice(i, i + 3);
      
      await Promise.allSettled(
        batch.map(async (session) => {
          try {
            const channelName = sanitizeChannelName(session.title, session.sessionId);
            const topic = formatChannelTopic(session);

            const newChannel = await guild.channels.create({
              name: channelName,
              type: ChannelType.GuildText,
              parent: category.id,
              topic
            });

            createdCount++;
            console.log(`\x1b[32m[Channel Sync]\x1b[0m Berhasil membuat #${newChannel.name} untuk sesi "${session.title}"`);
            await sendChannelWelcomeEmbed(newChannel, session);
          } catch (err: any) {
            console.error(`[Channel Sync Error] Gagal membuat channel untuk sesi "${session.title}":`, err.message);
          }
        })
      );

      // Beri jeda 1 detik jika masih ada batch berikutnya (Rate limit safety)
      if (i + 3 < missingSessions.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  console.log(`\x1b[32m[Channel Sync Selesai]\x1b[0m Kategori: "${category.name}" | Baru: ${createdCount} | Tersimpan: ${existingCount} | Dihapus: ${deletedCount}`);

  return {
    category,
    created: createdCount,
    deleted: deletedCount,
    existing: existingCount,
    totalSessions: targetSessions.length
  };
}

/**
 * Mengubah ProjectSessionItem atau Session ID menjadi objek ClaudeSession
 */
export function resolveClaudeSessionFromId(sessionId: string): ClaudeSession | null {
  const allSessions = getAllProjectSessions();
  const matched = allSessions.find(s => s.sessionId === sessionId);
  if (!matched) return null;

  return {
    pid: process.pid,
    sessionId: matched.sessionId,
    name: matched.title,
    cwd: matched.folder,
    status: 'idle',
    messagingSocketPath: ''
  };
}

/**
 * Menghapus seluruh text channel di dalam kategori Claude Remote (dan opsional kategorinya)
 */
export async function clearCategoryChannels(
  guild: Guild,
  categoryName = DEFAULT_CATEGORY_NAME,
  deleteCategory = false
): Promise<{ deletedChannels: number; categoryDeleted: boolean }> {
  await guild.channels.fetch();
  const category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && 
         (c.name.toLowerCase() === categoryName.toLowerCase() || c.name.toLowerCase().includes('claude remote'))
  ) as CategoryChannel | undefined;

  if (!category) {
    return { deletedChannels: 0, categoryDeleted: false };
  }

  const childChannels = guild.channels.cache.filter(
    c => c.parentId === category.id && c.type === ChannelType.GuildText
  ) as Collection<string, TextChannel>;

  let count = 0;
  for (const [, ch] of childChannels) {
    try {
      console.log(`\x1b[33m[Channel Clear]\x1b[0m Menghapus channel #${ch.name}...`);
      await ch.delete('Dibersihkan via crc channel clear');
      count++;
      await new Promise(r => setTimeout(r, 250));
    } catch (err: any) {
      console.error(`[Channel Clear Error] Gagal menghapus #${ch.name}:`, err.message);
    }
  }

  let catDeleted = false;
  if (deleteCategory) {
    try {
      console.log(`\x1b[33m[Category Clear]\x1b[0m Menghapus kategori "${category.name}"...`);
      await category.delete('Dibersihkan via crc channel clear');
      catDeleted = true;
    } catch (err: any) {
      console.error(`[Category Clear Error] Gagal menghapus kategori:`, err.message);
    }
  }

  return { deletedChannels: count, categoryDeleted: catDeleted };
}

