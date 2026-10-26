import { ApplicationCommandOptionType } from 'discord.js';
import { settingsManager } from './settings-manager.js';

/**
 * Membangun array Slash Commands resmi dengan pilihan model AI dinamis
 */
export function getSlashCommands(): any[] {
  const models = settingsManager.getModels();
  const choices = models.map((m, idx) => ({
    name: `${idx + 1}. ${m.name} (${m.id})`.slice(0, 100),
    value: String(idx + 1)
  })).slice(0, 25);

  const modelDesc = choices.length > 0 
    ? `Pilih nomor/ID model (${models.map((m, i) => `${i + 1}: ${m.name}`).slice(0, 3).join(', ')}${models.length > 3 ? '...' : ''})`
    : 'Pilih nomor atau ID model';

  return [
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
          description: modelDesc.slice(0, 100),
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: choices
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
      name: 'sync',
      description: 'Sinkronisasi kategori dan channel Discord dengan sesi Claude di PC'
    },
    {
      name: 'settings',
      description: 'Pusat kontrol setelan lengkap Claude (Sesi, Model, Izin, Tampilan, Effort, Timeout, Notif)'
    }
  ];
}

/**
 * Daftarkan / sinkronkan Slash Commands ke Discord API
 */
export async function syncSlashCommands(client: any): Promise<number> {
  if (!client || !client.application) return 0;
  const commands = getSlashCommands();
  await client.application.commands.set(commands);
  return commands.length;
}
