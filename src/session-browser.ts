import fs from 'fs';
import path from 'path';
import { ClaudeSession, getActiveSessions } from './ipc.js';

const PROJECTS_DIR = path.join(process.env.USERPROFILE || 'C:/Users/aiden', '.claude', 'projects');
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
  const drive = folderName[0] + ':\\';
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
      .filter(d => d.isDirectory() && d.name.startsWith('C--'));

    for (const pe of projectEntries) {
      const pDir = path.join(PROJECTS_DIR, pe.name);
      const diskFolder = resolveOriginalFolder(pe.name);
      const projectName = path.basename(diskFolder) || pe.name;

      const subdirs = fs.readdirSync(pDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && UUID_REGEX.test(d.name));

      const sessionsInProject: ProjectSessionItem[] = [];

      for (const sd of subdirs) {
        const sId = sd.name;
        let title = 'Percakapan Claude';
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
            const buf = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            const content = buf.toString('utf8', 0, bytesRead);
            const m = content.match(/"cwd"\s*:\s*"([^"]+)"/);
            if (m) {
              realFolder = m[1].replace(/\\\\/g, '\\');
            }
          } catch (_) {}
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

      // Deduplikasi judul di dalam proyek (seperti Claude Desktop yang hanya menampilkan sesi unik terbaru)
      const uniqueSessions: ProjectSessionItem[] = [];
      const seenTitles = new Set<string>();
      for (const s of sessionsInProject) {
        if (!seenTitles.has(s.title)) {
          seenTitles.add(s.title);
          uniqueSessions.push(s);
        }
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
