import path from 'path';
import { 
  Guild, 
  ChannelType, 
  CategoryChannel, 
  TextChannel, 
  Collection,
  EmbedBuilder
} from 'discord.js';
import { getSidebarProjectGroups, ProjectSessionItem } from './session-browser.js';
import { ClaudeSession } from './ipc.js';
import { 
  loadChannelsStore,
  saveChannelsStore,
  getCategoryByProjectFolder,
  setCategoryEntry,
  setChannelEntry,
  removeChannelEntry,
  removeCategoryEntry,
  getChannelByChannelId,
  ChannelEntry
} from './channels-store.js';

export const SESSION_TOPIC_PREFIX = 'SessionID:';
export const LEGACY_CATEGORY_NAME = '📁 Claude Remote';

/**
 * Format nama kategori Discord berdasarkan path folder proyek
 * Contoh: "C:\dev\RobloxDev" -> "📁 C:\dev\RobloxDev"
 */
export function formatProjectCategoryName(projectFolder: string): string {
  const normalized = path.normalize(projectFolder);
  const prefix = '📁 ';
  if (prefix.length + normalized.length <= 95) {
    return `${prefix}${normalized}`;
  }
  // Jika path sangat panjang (> 95 karakter), potong bagian tengah
  const drive = normalized.slice(0, 3); // misal C:\
  const base = path.basename(normalized);
  return `${prefix}${drive}...\\${base}`;
}

/**
 * Sanitasi judul sesi menjadi nama channel Discord yang valid
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

/**
 * Cari atau buat kategori proyek di Discord berdasarkan path folder fisik
 */
export async function getOrCreateProjectCategory(guild: Guild, projectFolder: string): Promise<CategoryChannel> {
  const expectedName = formatProjectCategoryName(projectFolder);

  // 1. Cek di cache channels-store
  const stored = getCategoryByProjectFolder(projectFolder);
  if (stored && stored.guildId === guild.id) {
    const existingCat = guild.channels.cache.get(stored.categoryId) as CategoryChannel | undefined;
    if (existingCat && existingCat.type === ChannelType.GuildCategory) {
      return existingCat;
    }
  }

  // 2. Cek di guild cache berdasarkan nama
  await guild.channels.fetch();
  const matched = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === expectedName.toLowerCase()
  ) as CategoryChannel | undefined;

  if (matched) {
    setCategoryEntry({
      categoryId: matched.id,
      categoryName: matched.name,
      guildId: guild.id,
      projectFolder
    });
    return matched;
  }

  // 3. Buat kategori baru di Discord
  const newCat = await guild.channels.create({
    name: expectedName,
    type: ChannelType.GuildCategory
  });

  setCategoryEntry({
    categoryId: newCat.id,
    categoryName: newCat.name,
    guildId: guild.id,
    projectFolder
  });

  console.log(`\x1b[32m[Category Manager]\x1b[0m Kategori Proyek "${newCat.name}" berhasil dibuat (ID: ${newCat.id})`);
  return newCat;
}

/**
 * Bersihkan kategori lama tunggal "📁 Claude Remote" jika masih ada dari versi sebelumnya
 */
export async function cleanupLegacyCategory(guild: Guild): Promise<number> {
  await guild.channels.fetch();
  const legacyCat = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && 
         (c.name.toLowerCase() === LEGACY_CATEGORY_NAME.toLowerCase() || c.name.toLowerCase() === 'claude remote')
  ) as CategoryChannel | undefined;

  if (!legacyCat) return 0;

  console.log(`\x1b[33m[Channel Migration]\x1b[0m Ditemukan kategori lama "${legacyCat.name}". Memulai pembersihan...`);
  const children = guild.channels.cache.filter(c => c.parentId === legacyCat.id);
  let cleaned = 0;

  for (const [, ch] of children) {
    try {
      await ch.delete('Migrasi ke Kategori per-Path Proyek');
      removeChannelEntry(ch.id);
      cleaned++;
      await new Promise(r => setTimeout(r, 200));
    } catch (_) {}
  }

  try {
    await legacyCat.delete('Migrasi ke Kategori per-Path Proyek');
  } catch (_) {}

  console.log(`\x1b[32m[Channel Migration]\x1b[0m Kategori lama "${legacyCat.name}" berhasil dibersihkan (${cleaned} channel dimigrasi).`);
  return cleaned;
}

export interface SyncResult {
  categoriesCount: number;
  createdChannels: number;
  deletedChannels: number;
  existingChannels: number;
  totalSessions: number;
}

/**
 * Sinkronisasi 2-arah Kategori Proyek & Channel Discord dengan tab sesi Claude di PC
 */
export async function syncChannelsWithSessions(guild: Guild): Promise<SyncResult> {
  // 1. Bersihkan kategori lama tunggal jika ada
  await cleanupLegacyCategory(guild);

  // 2. Baca daftar grup sesi proyek dari PC
  const { groups, flatList } = getSidebarProjectGroups();
  if (flatList.length === 0) {
    console.warn('\x1b[33m[Channel Manager Warn]\x1b[0m Tidak ada sesi Claude yang ditemukan di PC.');
    return {
      categoriesCount: 0,
      createdChannels: 0,
      deletedChannels: 0,
      existingChannels: 0,
      totalSessions: 0
    };
  }

  await guild.channels.fetch();
  const activeSessionIds = new Set(flatList.map(s => s.sessionId));
  const store = loadChannelsStore();

  let createdCount = 0;
  let deletedCount = 0;
  let existingCount = 0;

  // 3. PEMBERSIHAN (PRUNING) SESI YANG SUDAH DIHAPUS DI PC
  for (const [chId, entry] of Object.entries(store.channels)) {
    if (entry.guildId === guild.id && !activeSessionIds.has(entry.sessionId)) {
      const discordCh = guild.channels.cache.get(chId);
      if (discordCh) {
        try {
          console.log(`\x1b[33m[Channel Pruner]\x1b[0m Menghapus channel #${discordCh.name} karena sesi Claude sudah dihapus.`);
          await discordCh.delete('Sesi Claude telah dihapus di PC');
          deletedCount++;
          await new Promise(r => setTimeout(r, 250));
        } catch (_) {}
      }
      removeChannelEntry(chId);
    }
  }

  // 4. SINKRONISASI PER-FOLDER PROYEK
  const missingCreations: { session: ProjectSessionItem; category: CategoryChannel }[] = [];

  for (const group of groups) {
    if (group.sessions.length === 0) continue;

    // Pastikan kategori proyek ada di Discord
    const category = await getOrCreateProjectCategory(guild, group.projectFolder);

    // Filter channel di bawah kategori ini
    const existingInCat = guild.channels.cache.filter(
      c => c.parentId === category.id && c.type === ChannelType.GuildText
    ) as Collection<string, TextChannel>;

    const existingSessionsInCat = new Set<string>();
    for (const [, ch] of existingInCat) {
      const sId = extractSessionIdFromTopic(ch.topic);
      if (sId) {
        existingSessionsInCat.add(sId);
        // Pastikan store terupdate
        const matchedSess = group.sessions.find(s => s.sessionId === sId);
        if (matchedSess) {
          setChannelEntry({
            channelId: ch.id,
            sessionId: sId,
            sessionTitle: matchedSess.title,
            projectFolder: group.projectFolder,
            channelName: ch.name,
            categoryId: category.id,
            guildId: guild.id,
            createdAt: ch.createdTimestamp
          });
          existingCount++;
        }
      }
    }

    // Cari sesi yang belum punya channel di kategori proyek ini
    for (const sess of group.sessions) {
      if (!existingSessionsInCat.has(sess.sessionId)) {
        missingCreations.push({ session: sess, category });
      }
    }
  }

  // 5. PEMBUATAN CHANNEL BARU (BATCHING AMAN 3 CHANNEL PER DETIK)
  if (missingCreations.length > 0) {
    console.log(`\x1b[36m[Channel Sync]\x1b[0m Memulai pembuatan ${missingCreations.length} channel baru (3 channel / detik)...`);

    for (let i = 0; i < missingCreations.length; i += 3) {
      const batch = missingCreations.slice(i, i + 3);

      await Promise.allSettled(
        batch.map(async ({ session, category }) => {
          try {
            const channelName = sanitizeChannelName(session.title, session.sessionId);
            const topic = formatChannelTopic(session);

            const newChannel = await guild.channels.create({
              name: channelName,
              type: ChannelType.GuildText,
              parent: category.id,
              topic
            });

            setChannelEntry({
              channelId: newChannel.id,
              sessionId: session.sessionId,
              sessionTitle: session.title,
              projectFolder: session.folder,
              channelName: newChannel.name,
              categoryId: category.id,
              guildId: guild.id,
              createdAt: Date.now()
            });

            createdCount++;
            console.log(`\x1b[32m[Channel Sync]\x1b[0m Berhasil membuat #${newChannel.name} di bawah "${category.name}"`);
            await sendChannelWelcomeEmbed(newChannel, session);
          } catch (err: any) {
            console.error(`[Channel Sync Error] Gagal membuat channel #${session.title}:`, err.message);
          }
        })
      );

      if (i + 3 < missingCreations.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  return {
    categoriesCount: groups.length,
    createdChannels: createdCount,
    deletedChannels: deletedCount,
    existingChannels: existingCount,
    totalSessions: flatList.length
  };
}

/**
 * Hapus seluruh kategori proyek dan text channel yang dikelola oleh CRC
 */
export async function clearCategoryChannels(guild: Guild, deleteCategories = true): Promise<{ deletedChannels: number; deletedCategories: number }> {
  await guild.channels.fetch();
  const store = loadChannelsStore();
  let deletedCh = 0;
  let deletedCat = 0;

  // Hapus semua channel yang tercatat di store
  for (const [chId] of Object.entries(store.channels)) {
    const ch = guild.channels.cache.get(chId);
    if (ch) {
      try {
        console.log(`\x1b[33m[Channel Clear]\x1b[0m Menghapus channel #${ch.name}...`);
        await ch.delete('Dibersihkan via clearCategoryChannels');
        deletedCh++;
        await new Promise(r => setTimeout(r, 200));
      } catch (_) {}
    }
    removeChannelEntry(chId);
  }

  // Hapus semua kategori proyek
  if (deleteCategories) {
    for (const [folderKey, catEntry] of Object.entries(store.categories)) {
      const cat = guild.channels.cache.get(catEntry.categoryId);
      if (cat) {
        try {
          console.log(`\x1b[33m[Category Clear]\x1b[0m Menghapus kategori "${cat.name}"...`);
          await cat.delete('Dibersihkan via clearCategoryChannels');
          deletedCat++;
          await new Promise(r => setTimeout(r, 200));
        } catch (_) {}
      }
      removeCategoryEntry(folderKey);
    }
  }

  // Bersihkan juga legacy jika masih ada
  await cleanupLegacyCategory(guild);

  return { deletedChannels: deletedCh, deletedCategories: deletedCat };
}

/**
 * Resolusi ClaudeSession dari channel Discord secara instan $O(1)$
 */
export function resolveClaudeSessionFromChannel(channelId: string, topic?: string | null): ClaudeSession | null {
  // 1. Coba lookup dari channels-store O(1)
  const entry = getChannelByChannelId(channelId);
  if (entry) {
    return {
      pid: process.pid,
      sessionId: entry.sessionId,
      name: entry.sessionTitle,
      cwd: entry.projectFolder,
      status: 'idle',
      messagingSocketPath: ''
    };
  }

  // 2. Fallback via regex topic
  const sId = extractSessionIdFromTopic(topic);
  if (sId) {
    const { flatList } = getSidebarProjectGroups();
    const matched = flatList.find(s => s.sessionId === sId);
    if (matched) {
      return {
        pid: process.pid,
        sessionId: matched.sessionId,
        name: matched.title,
        cwd: matched.folder,
        status: 'idle',
        messagingSocketPath: ''
      };
    }
  }

  return null;
}
