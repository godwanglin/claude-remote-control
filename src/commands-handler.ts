import fs from 'fs';
import path from 'path';
import { 
  ClaudeSession, 
  getActiveSessions, 
  getPreferredSession,
  findTranscriptFile
} from './ipc.js';
import { buildStatusMessage, getSessionStatus } from './session-status.js';
import { wrapRow } from './status-card.js';
import { getAllProjectSessions, getCachedSessionsList, getSidebarProjectGroups, ProjectSessionItem } from './session-browser.js';
import { ClaudeHeadless, ClaudePermissionMode } from './claude-headless.js';
import { settingsManager, StoredSettings } from './settings-manager.js';

const esc = '\u001b';
const stripAnsi = (str: string) => str.replace(/\u001b\[[0-9;]*m/g, '');

export function makeBox(title: string, lines: (string | null)[], width: number = 62): string {
  const usableWidth = width - 4;
  const titleText = `── ${title} `;
  const topDash = Math.max(0, width - 2 - titleText.length);
  const topLine = `┌${titleText}${'─'.repeat(topDash)}┐`;
  const bottomLine = `└${'─'.repeat(width - 2)}┘`;

  const flattenedLines: (string | null)[] = [];
  for (const line of lines) {
    if (line === null || line === '') {
      flattenedLines.push(null);
    } else {
      flattenedLines.push(...wrapRow(line, usableWidth));
    }
  }

  const body = flattenedLines.map(line => {
    if (line === null || line === '') {
      return `│${' '.repeat(width - 2)}│`;
    }
    const visualLen = stripAnsi(line).length;
    const pad = Math.max(0, usableWidth - visualLen);
    return `│ ${line}${' '.repeat(pad)} │`;
  });

  return ['```ansi', topLine, ...body, bottomLine, '```'].join('\n');
}

export const botSettings = settingsManager.settings;

export function renderCoreSettingsCard(currentSession: ClaudeSession | null): string {
  const activeModelId = currentSession ? getSessionModel(currentSession.sessionId) : 'claude-opus-5-5';
  const activeModelObj = AVAILABLE_MODELS.find(m => m.id === activeModelId) || AVAILABLE_MODELS[0];
  const activePermObj = PERMISSION_MODES.find(m => m.id === currentPermissionMode) || PERMISSION_MODES[0];
  const shortFolder = currentSession ? (currentSession.cwd.split('\\').pop() || currentSession.cwd) : '-';

  const lines: (string | null)[] = [
    null,
    `${esc}[1;32m> KONFIGURASI INTI SAAT INI:${esc}[0m`,
    `  Sesi    : ${esc}[1;37m${currentSession?.name || '-'}${esc}[0m (${shortFolder})`,
    `  Model   : ${esc}[1;33m${activeModelObj.name} (${activeModelObj.id})${esc}[0m`,
    `  Izin    : ${esc}[1;36m${activePermObj.name}${esc}[0m`,
    null,
    `${esc}[0;37mPilih dropdown di bawah untuk mengubah setelan inti.${esc}[0m`,
    null
  ];

  return makeBox('SETELAN INTI CLAUDE', lines, 62);
}

export function renderSystemSettingsCard(): string {
  const verbosityLabel = botSettings.verbosity === 'detail' 
    ? 'Detail (Tool, Terminal & Jawaban)' 
    : 'Ringkas (Hanya Teks Jawaban)';

  const effortLabel = botSettings.effort === 'xhigh'
    ? 'Maksimal (xhigh)'
    : botSettings.effort === 'high'
    ? 'Tinggi (high)'
    : botSettings.effort === 'medium'
    ? 'Normal (medium)'
    : 'Cepat (low)';

  const timeoutLabel = botSettings.timeoutMs === 0 
    ? 'Tanpa Batas (Infinity)' 
    : `${botSettings.timeoutMs / 60000} Menit`;
  const notifyLabel = botSettings.notify === 'mention' ? 'Mention (@User)' : 'Silent (Tanpa Tag)';

  const lines: (string | null)[] = [
    null,
    `${esc}[1;32m> PREFERENSI SISTEM SAAT INI:${esc}[0m`,
    `  Tampilan : ${esc}[1;37m${verbosityLabel}${esc}[0m`,
    `  Effort   : ${esc}[1;33m${effortLabel}${esc}[0m`,
    `  Timeout  : ${esc}[1;36m${timeoutLabel}${esc}[0m`,
    `  Notif    : ${esc}[1;35m${notifyLabel}${esc}[0m`,
    null,
    `${esc}[0;37mPilih dropdown di bawah untuk mengubah preferensi.${esc}[0m`,
    null
  ];

  return makeBox('PREFERENSI OUTPUT & SISTEM', lines, 62);
}

/**
 * 1. /status
 */
export function handleStatus(currentSession: ClaudeSession | null): string {
  if (!currentSession) {
    return '❌ Tidak ada sesi Claude yang aktif saat ini.';
  }
  return buildStatusMessage(currentSession, true);
}

/**
 * 2. /sessions (Cukup menampilkan sesi yang sedang terhubung)
 */
export function handleSessions(currentSession: ClaudeSession | null): string {
  const lines: (string | null)[] = [null];

  if (currentSession) {
    const shortFolder = currentSession.cwd.split('\\').pop() || currentSession.cwd;
    lines.push(`${esc}[1;32m> SESI TERHUBUNG SAAT INI:${esc}[0m`);
    lines.push(`  Judul   : ${esc}[1;37m${currentSession.name}${esc}[0m`);
    lines.push(`  Proyek  : ${esc}[1;36m${shortFolder}${esc}[0m`);
    lines.push(`  ID Sesi : ${currentSession.sessionId.slice(0, 18)}..`);
    lines.push(null);
  } else {
    lines.push(`${esc}[1;33mBelum ada sesi yang terhubung.${esc}[0m`);
    lines.push(null);
  }

  return makeBox('SESI CLAUDE TERHUBUNG', lines, 62);
}

/**
 * 3. /model
 */
export const AVAILABLE_MODELS = [
  {
    index: 1,
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    desc: 'Paling mumpuni untuk pekerjaan ambisius.'
  },
  {
    index: 2,
    id: 'claude-opus-4-6',
    name: 'Opus 4.6',
    desc: 'Model Claude Opus 4.6 standar.'
  }
];

// Mapping model aktif per session ID di memory & persistent settings.json
export const sessionModelMap = new Map<string, string>();

export function getSessionModel(sessionId?: string): string {
  if (sessionId && sessionModelMap.has(sessionId)) {
    return sessionModelMap.get(sessionId)!;
  }
  return settingsManager.getSessionModel(sessionId);
}

export async function handleModel(currentSession: ClaudeSession | null, selectedModel?: string | null): Promise<string> {
  const activeModelId = currentSession ? getSessionModel(currentSession.sessionId) : 'claude-opus-5-5';
  const activeModelObj = AVAILABLE_MODELS.find(m => m.id === activeModelId) || AVAILABLE_MODELS[0];

  if (selectedModel) {
    const q = selectedModel.trim().toLowerCase();
    let matched = AVAILABLE_MODELS.find(m => 
      String(m.index) === q ||
      m.id.toLowerCase() === q ||
      m.name.toLowerCase() === q ||
      q.includes(m.name.toLowerCase().replace('opus ', '')) ||
      (q === 'opus-5.5' && m.id === 'claude-opus-5-5') ||
      (q === 'opus-4.6' && m.id === 'claude-opus-4-6') ||
      (q === '5.5' && m.id === 'claude-opus-5-5') ||
      (q === '4.6' && m.id === 'claude-opus-4-6')
    );

    if (!matched && q === '0') {
      matched = AVAILABLE_MODELS[0];
    }

    if (!matched) {
      return `❌ Model \`${selectedModel}\` tidak valid.\nPilihan model yang tersedia:\n• \`/model 1\` (${AVAILABLE_MODELS[0].name})\n• \`/model 2\` (${AVAILABLE_MODELS[1].name})`;
    }

    if (currentSession) {
      sessionModelMap.set(currentSession.sessionId, matched.id);
      settingsManager.setSessionModel(currentSession.sessionId, matched.id);

      // Tulis model attachment ke file transkrip .jsonl agar Claude Desktop tersinkronisasi
      try {
        const transcriptPath = findTranscriptFile(currentSession.sessionId, currentSession.cwd);
        if (transcriptPath && fs.existsSync(transcriptPath)) {
          const content = fs.readFileSync(transcriptPath, 'utf8').trim();
          const linesArr = content.split('\n');
          const lastLine = linesArr[linesArr.length - 1];
          let parentUuid = '';
          try {
            const parsed = JSON.parse(lastLine);
            parentUuid = parsed.uuid || parsed.parentUuid || '';
          } catch (_) {}

          const record = {
            parentUuid: parentUuid || undefined,
            isSidechain: false,
            attachment: {
              type: 'model',
              identity: {
                modelId: matched.id,
                marketingName: matched.name,
                knowledgeCutoff: matched.id.includes('5-5') ? 'June 2026' : 'May 2025'
              }
            }
          };
          fs.appendFileSync(transcriptPath, JSON.stringify(record) + '\n', 'utf8');
        }
      } catch (err: any) {
        console.warn('[Model Switch Warn]', err.message);
      }
    }

    const lines: (string | null)[] = [
      null,
      `${esc}[1;32m[OK] MODEL BERHASIL DIUBAH${esc}[0m`,
      null,
      `  Model : ${esc}[1;33m${matched.name} (${matched.id})${esc}[0m`,
      `  Sesi  : ${currentSession?.name || 'Sesi Aktif'}`,
      null
    ];
    return makeBox('PENGATURAN MODEL CLAUDE', lines, 62);
  }

  const lines: (string | null)[] = [
    null,
    `${esc}[1;32m> MODEL AKTIF SAAT INI:${esc}[0m`,
    `  Model : ${esc}[1;33m${activeModelObj.name} (${activeModelObj.id})${esc}[0m`,
    `  Sesi  : ${currentSession?.name || 'Sesi Aktif'}`,
    null
  ];

  return makeBox('MODEL CLAUDE', lines, 62);
}

/**
 * 4. /teleport <session-id | nomor | nama | auto>
 */
export async function handleTeleport(targetArg: string): Promise<{ session: ClaudeSession | null; message: string; isAuto?: boolean }> {
  const q = targetArg.trim().toLowerCase();

  // Mode Auto-Sync (mengikuti tab aktif Claude Desktop)
  if (q === 'auto' || q === 'sync') {
    const pref = getPreferredSession();
    const lines: (string | null)[] = [
      null,
      `${esc}[1;32m[OK] MODE AUTO-SYNC DIAKTIFKAN${esc}[0m`,
      null,
      `  Sesi Sekarang : ${esc}[1;37m${pref?.name || 'Sesi Terkini'}${esc}[0m`,
      `  Folder        : ${esc}[1;36m${pref?.cwd || '-'}${esc}[0m`,
      null,
      `${esc}[0;37mBot otomatis mengikuti tab sesi Claude Desktop yang aktif!${esc}[0m`,
      null
    ];
    return {
      session: pref,
      message: makeBox('AUTO-SYNC CLAUDE DESKTOP', lines, 62),
      isAuto: true
    };
  }

  const all = getCachedSessionsList();

  // 1. Cek jika targetArg adalah nomor urut [1], [2], dst
  const num = parseInt(q, 10);
  let targetItem: ProjectSessionItem | undefined;
  if (!isNaN(num) && num >= 1 && num <= all.length) {
    targetItem = all[num - 1];
  } else {
    // 2. Cek by ID / Title
    targetItem = all.find(s => 
      s.sessionId.toLowerCase() === q ||
      s.sessionId.toLowerCase().startsWith(q) ||
      s.title.toLowerCase().includes(q)
    );
  }

  if (targetItem) {
    const newSession: ClaudeSession = {
      pid: targetItem.pid || process.pid,
      sessionId: targetItem.sessionId,
      name: targetItem.title,
      status: 'idle',
      cwd: targetItem.folder,
      messagingSocketPath: ''
    };

    const lines: (string | null)[] = [
      null,
      `${esc}[1;32m[OK] TELEPORT SESI BERHASIL${esc}[0m`,
      null,
      `  Judul   : ${esc}[1;37${targetItem.title}${esc}[0m`,
      `  Folder  : ${esc}[1;36m${targetItem.folder}${esc}[0m`,
      `  ID Sesi : ${targetItem.sessionId}`,
      null,
      `${esc}[0;37mKontrol bot sekarang berpindah ke sesi ini secara headless!${esc}[0m`,
      null
    ];

    return {
      session: newSession,
      message: makeBox('TELEPORT KONTROL SESI', lines, 62)
    };
  }

  return { 
    session: null, 
    message: `❌ Sesi dengan identifier \`${targetArg}\` tidak ditemukan.\nGunakan \`/sessions\` untuk melihat nomor atau ID sesi yang tersedia.` 
  };
}

/**
 * 5. /permission [mode]
 */
export let currentPermissionMode: ClaudePermissionMode = settingsManager.settings.permissionMode || 'bypassPermissions';

export const PERMISSION_MODES: { id: ClaudePermissionMode; index: number; name: string; desc: string }[] = [
  {
    id: 'bypassPermissions',
    index: 1,
    name: 'Bypass Permissions',
    desc: 'Lewati semua izin (Otomatis dieksekusi tanpa konfirmasi).'
  },
  {
    id: 'auto',
    index: 2,
    name: 'Auto',
    desc: 'Deteksi & evaluasi izin secara otomatis oleh Claude.'
  },
  {
    id: 'acceptEdits',
    index: 3,
    name: 'Accept Edits',
    desc: 'Otomatis terima semua perubahan file (edit/create).'
  },
  {
    id: 'manual',
    index: 4,
    name: 'Manual',
    desc: 'Minta persetujuan manual tiap kali aksi dijalankan.'
  },
  {
    id: 'dontAsk',
    index: 5,
    name: 'Don\'t Ask',
    desc: 'Jangan pernah tanya izin interaktif.'
  },
  {
    id: 'plan',
    index: 6,
    name: 'Plan',
    desc: 'Hanya analisis & rencana tanpa melakukan modifikasi file.'
  }
];

export function handlePermission(selectedMode?: string | null): string {
  if (selectedMode) {
    const q = selectedMode.trim().toLowerCase();
    const matched = PERMISSION_MODES.find(m => 
      String(m.index) === q ||
      m.id.toLowerCase() === q ||
      (q === 'bypass' && m.id === 'bypassPermissions') ||
      (q === 'ask' && m.id === 'manual') ||
      (q === 'acceptedits' && m.id === 'acceptEdits') ||
      (q === 'dontask' && m.id === 'dontAsk')
    );

    if (matched) {
      currentPermissionMode = matched.id;
      settingsManager.update('permissionMode', matched.id);
      const lines: (string | null)[] = [
        null,
        `${esc}[1;32m[OK] MODE PERIZINAN BERHASIL DIUBAH${esc}[0m`,
        null,
        `  Mode Baru : ${esc}[1;33m${matched.name} (${matched.id})${esc}[0m`,
        `  Aturan    : ${matched.desc}`,
        null,
        `${esc}[0;37mClaude Code sekarang berjalan dengan aturan izin ini.${esc}[0m`,
        null
      ];
      return makeBox('PENGATURAN MODE PERIZINAN', lines, 62);
    } else {
      return `❌ Mode perizinan \`${selectedMode}\` tidak valid.`;
    }
  }

  const activeModeObj = PERMISSION_MODES.find(m => m.id === currentPermissionMode) || PERMISSION_MODES[0];

  const lines: (string | null)[] = [
    null,
    `${esc}[1;32m> MODE PERIZINAN AKTIF:${esc}[0m`,
    `  ${esc}[1;33m${activeModeObj.name} (${activeModeObj.id})${esc}[0m`,
    null,
    `  Aturan : ${activeModeObj.desc}`,
    null
  ];

  return makeBox('STATUS PERIZINAN CLAUDE', lines, 62);
}

/**
 * 6. /compact (Meringkas riwayat sesi aktif secara headless)
 */
export async function handleCompact(
  currentSession: ClaudeSession | null, 
  instruction: string = ''
): Promise<{ success: boolean; message: string }> {
  if (!currentSession) {
    return { success: false, message: '❌ Tidak ada sesi Claude yang aktif saat ini.' };
  }

  try {
    const runner = new ClaudeHeadless({
      session: currentSession.sessionId,
      cwd: currentSession.cwd,
      model: getSessionModel(currentSession.sessionId),
      permission: currentPermissionMode,
      timeout: 180_000 // 3 menit
    });

    await runner.compact(instruction);

    const lines: (string | null)[] = [
      null,
      `${esc}[1;32m[OK] SESI BERHASIL DIRINGKAS (COMPACT)${esc}[0m`,
      null,
      `  Sesi    : ${esc}[1;37m${currentSession.name}${esc}[0m`,
      `  Folder  : ${esc}[1;36m${currentSession.cwd}${esc}[0m`,
      instruction ? `  Catatan : "${instruction}"` : null,
      null,
      `${esc}[0;37mRiwayat lama telah dirangkum menjadi batas ringkasan baru.${esc}[0m`,
      `${esc}[0;37mJendela konteks token sekarang kembali lega dan hemat!${esc}[0m`,
      null
    ];

    return {
      success: true,
      message: makeBox('COMPACT KONTEKS SESI', lines, 62)
    };
  } catch (err: any) {
    return {
      success: false,
      message: `❌ Gagal melakukan compact sesi: ${err.message}`
    };
  }
}

/**
 * 7. /clear (Mereset percakapan)
 */
export async function handleClear(currentSession: ClaudeSession | null): Promise<string> {
  if (!currentSession) {
    return '❌ Tidak ada sesi Claude yang aktif saat ini.';
  }

  try {
    const runner = new ClaudeHeadless({
      session: currentSession.sessionId,
      cwd: currentSession.cwd,
      model: getSessionModel(currentSession.sessionId),
      permission: currentPermissionMode,
      message: '/clear'
    });
    await runner.send();
  } catch (err: any) {
    console.warn('[Clear Warn]', err.message);
  }

  const lines: (string | null)[] = [
    null,
    `${esc}[1;33m[CLEAR] KONTEKS SESI DI-RESET${esc}[0m`,
    null,
    `  Sesi   : ${esc}[1;37m${currentSession.name}${esc}[0m`,
    `  Folder : ${esc}[1;36m${currentSession.cwd}${esc}[0m`,
    null,
    `${esc}[0;37mRiwayat obrolan sesi ini telah dikosongkan kembali.${esc}[0m`,
    `${esc}[0;37mPenggunaan jendela konteks dimulai dari awal.${esc}[0m`,
    null
  ];

  return makeBox('RESET KONTEKS OBROLAN', lines, 62);
}
