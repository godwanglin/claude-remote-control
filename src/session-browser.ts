import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaudeSession, getActiveSessions } from './ipc.js';

const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
const PROJECTS_DIR = path.join(userHome, '.claude', 'projects');
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectSessionItem {
  sessionId: string;
  title: string;
  folder: string;
  lastModified: number;
  pid?: number;
  status: string;
  isActiveWorker: boolean;
}

export interface ProjectSidebarGroup {
  projectName: string;
  projectFolder: string;
  sessions: ProjectSessionItem[];
}

let cachedSessionsList: ProjectSessionItem[] = [];

export function getCachedSessionsList(): ProjectSessionItem[] {
  if (cachedSessionsList.length === 0) {
    getSidebarProjectGroups();
  }
  return cachedSessionsList;
}

export function resolveOriginalFolder(folderName: string): string {
  // Format Windows: C--path-to-folder atau D--path-to-folder
  if (folderName.length >= 3 && folderName[1] === '-' && folderName[2] === '-') {
    const drive = folderName[0].toUpperCase() + ':\\';
    const rest = folderName.slice(3).split('-');
    let cur = drive;
    let i = 0;
    while (i < rest.length) {
      let matched = false;
      for (let len = rest.length - i; len >= 1; len--) {
        const seg = rest.slice(i, i + len).join('-');
        const candidate = path.join(cur, seg);
        if (fs.existsSync(candidate)) {
          cur = candidate;
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        cur = path.join(cur, rest[i]);
        i++;
      }
    }
    return cur;
  }
  // Linux / macOS path fallback (e.g. -home-user-project)
  if (folderName.startsWith('-')) {
    return '/' + folderName.slice(1).replace(/-/g, '/');
  }
  return folderName;
}

/**
 * Membaca tab & sesi proyek yang persis seperti tampilan sidebar Claude Desktop
 */
export function getSidebarProjectGroups(): { groups: ProjectSidebarGroup[]; flatList: ProjectSessionItem[] } {
  const activeWorkers = getActiveSessions();
  const workerBySessionId = new Map<string, ClaudeSession>();
  for (const w of activeWorkers) {
    workerBySessionId.set(w.sessionId, w);
  }

  const groups: ProjectSidebarGroup[] = [];
  const flatList: ProjectSessionItem[] = [];

  if (fs.existsSync(PROJECTS_DIR)) {
    const projectEntries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const pe of projectEntries) {
      const pDir = path.join(PROJECTS_DIR, pe.name);
      const diskFolder = resolveOriginalFolder(pe.name);
      const projectName = path.basename(diskFolder) || pe.name;

      // Temukan semua ID sesi: baik dari direktori UUID maupun file <UUID>.jsonl
      const dirEntries = fs.readdirSync(pDir, { withFileTypes: true });
      const sessionIds = new Set<string>();

      for (const entry of dirEntries) {
        if (entry.isDirectory() && UUID_REGEX.test(entry.name)) {
          sessionIds.add(entry.name);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const sId = entry.name.slice(0, -6);
          if (UUID_REGEX.test(sId)) {
            sessionIds.add(sId);
          }
        }
      }

      const sessionsInProject: ProjectSessionItem[] = [];

      for (const sId of sessionIds) {
        let title = '';
        const titleFile = path.join(pDir, sId, 'custom-title.json');
        if (fs.existsSync(titleFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(titleFile, 'utf8'));
            if (data.customTitle) title = data.customTitle;
          } catch (_) {}
        }

        let lastMod = 0;
        let realFolder = '';
        const transcriptFile = path.join(pDir, `${sId}.jsonl`);
        if (fs.existsSync(transcriptFile)) {
          lastMod = fs.statSync(transcriptFile).mtimeMs;
          try {
            const fd = fs.openSync(transcriptFile, 'r');
            const buf = Buffer.alloc(16384);
            const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
            fs.closeSync(fd);
            const content = buf.toString('utf8', 0, bytesRead);
            
            const m = content.match(/"cwd"\s*:\s*"([^"]+)"/);
            if (m) {
              realFolder = m[1].replace(/\\\\/g, '\\');
            }

            // Jika belum ada customTitle, ekstrak dari prompt user pertama di transkrip
            if (!title) {
              const lines = content.split('\n');
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const entry = JSON.parse(line);
                  if (entry.type === 'user' && !entry.isMeta && entry.message?.content) {
                    let text = typeof entry.message.content === 'string'
                      ? entry.message.content
                      : (Array.isArray(entry.message.content) ? entry.message.content.map((c: any) => c.text || '').join(' ') : '');
                    text = text.replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').trim();
                    if (text && text.length > 2) {
                      title = text.length > 40 ? text.slice(0, 37) + '...' : text;
                      break;
                    }
                  }
                } catch (_) {}
              }
            }
          } catch (_) {}
        }

        if (!title) {
          title = 'Percakapan Claude';
        }

        if (!realFolder) {
          realFolder = diskFolder;
        }

        const activeWorker = workerBySessionId.get(sId);
        sessionsInProject.push({
          sessionId: sId,
          title,
          folder: realFolder,
          lastModified: activeWorker ? (activeWorker.updatedAt || activeWorker.statusUpdatedAt || Date.now()) : lastMod,
          pid: activeWorker?.pid,
          status: activeWorker ? (activeWorker.status || 'idle') : 'tersimpan',
          isActiveWorker: !!activeWorker
        });
      }

      // Urutkan sesi dalam proyek (yang aktif di atas, lalu berdasarkan recency)
      sessionsInProject.sort((a, b) => {
        if (a.isActiveWorker && !b.isActiveWorker) return -1;
        if (!a.isActiveWorker && b.isActiveWorker) return 1;
        return b.lastModified - a.lastModified;
      });

      // Deduplikasi judul di dalam proyek (hanya buang jika judul kustom sama persis)
      const uniqueSessions: ProjectSessionItem[] = [];
      const seenTitles = new Set<string>();
      for (const s of sessionsInProject) {
        if (s.title !== 'Percakapan Claude' && seenTitles.has(s.title)) {
          continue;
        }
        if (s.title !== 'Percakapan Claude') {
          seenTitles.add(s.title);
        }
        uniqueSessions.push(s);
      }

      if (uniqueSessions.length > 0) {
        groups.push({
          projectName,
          projectFolder: uniqueSessions[0].folder,
          sessions: uniqueSessions
        });
      }
    }
  }

  // Urutkan grup proyek: proyek yang sedang aktif ditaruh di paling atas
  groups.sort((a, b) => {
    const hasActiveA = a.sessions.some(s => s.isActiveWorker) ? 1 : 0;
    const hasActiveB = b.sessions.some(s => s.isActiveWorker) ? 1 : 0;
    if (hasActiveA !== hasActiveB) return hasActiveB - hasActiveA;
    const maxA = Math.max(0, ...a.sessions.map(s => s.lastModified));
    const maxB = Math.max(0, ...b.sessions.map(s => s.lastModified));
    return maxB - maxA;
  });

  // Susun flat list bernomor urut
  for (const g of groups) {
    for (const s of g.sessions) {
      flatList.push(s);
    }
  }

  cachedSessionsList = flatList;
  return { groups, flatList };
}

/**
 * Membaca semua sesi yang ada (kompatibilitas backward)
 */
export function getAllProjectSessions(): ProjectSessionItem[] {
  const { flatList } = getSidebarProjectGroups();
  return flatList;
}

/**
 * Menghapus hanya satu sesi spesifik berdasarkan Session ID UUID
 * Membersihkan: <sessionId>.jsonl, direktori sesi jika ada, dan session-env jika ada
 */
export function deleteSession(sessionId: string): { success: boolean; deletedFiles: string[]; session?: ProjectSessionItem; message: string } {
  if (!sessionId || !sessionId.trim()) {
    return { success: false, deletedFiles: [], message: 'Session ID tidak boleh kosong.' };
  }

  const { flatList } = getSidebarProjectGroups();
  const session = flatList.find(s => s.sessionId.toLowerCase() === sessionId.trim().toLowerCase());
  
  const targetId = session ? session.sessionId : sessionId.trim();
  const deletedFiles: string[] = [];

  if (fs.existsSync(PROJECTS_DIR)) {
    const projectEntries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const pe of projectEntries) {
      const pDir = path.join(PROJECTS_DIR, pe.name);
      
      // 1. Hapus file transkrip: <sessionId>.jsonl (hanya file sesi ini!)
      const jsonlFile = path.join(pDir, `${targetId}.jsonl`);
      if (fs.existsSync(jsonlFile)) {
        try {
          fs.unlinkSync(jsonlFile);
          deletedFiles.push(jsonlFile);
        } catch (_) {}
      }

      // 2. Hapus direktori metadata sesi jika ada
      const sessionDir = path.join(pDir, targetId);
      if (fs.existsSync(sessionDir)) {
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          deletedFiles.push(sessionDir);
        } catch (_) {}
      }
    }
  }

  // 3. Hapus cache environment sesi di ~/.claude/session-env/<sessionId>
  const sessionEnvDir = path.join(userHome, '.claude', 'session-env', targetId);
  if (fs.existsSync(sessionEnvDir)) {
    try {
      fs.rmSync(sessionEnvDir, { recursive: true, force: true });
      deletedFiles.push(sessionEnvDir);
    } catch (_) {}
  }

  // Bersihkan cache daftar sesi agar pemanggilan berikutnya langsung up to date
  cachedSessionsList = [];
  getSidebarProjectGroups();

  if (deletedFiles.length === 0 && !session) {
    return { success: false, deletedFiles: [], message: `Sesi "${sessionId}" tidak ditemukan di disk.` };
  }

  return {
    success: true,
    deletedFiles,
    session,
    message: `Sesi "${session?.title || targetId}" (${targetId}) berhasil dihapus.`
  };
}
