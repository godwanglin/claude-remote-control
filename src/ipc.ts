/**
 * ipc.ts - Manajemen Sesi & Resolusi Lokasi Transkrip Claude
 */
import fs from 'fs';
import path from 'path';

const userHome = process.env.USERPROFILE || process.env.HOME || (process.platform === 'win32' ? 'C:/Users/aiden' : '/root');
const CLAUDE_DIR = path.join(userHome, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function getClaudeAppDirs(): string[] {
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  if (!localAppData) return [];
  return [
    path.join(localAppData, 'Claude-3p'),
    path.join(localAppData, 'Claude')
  ].filter(d => fs.existsSync(d));
}

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  name: string;
  status: string;
  cwd: string;
  messagingSocketPath?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
  startedAt?: number;
  hostSessionId?: string;
  entrypoint?: string;
}

/**
 * Mengubah path Windows (misal C:\dev\RobloxDev) menjadi nama folder proyek Claude (C--dev-RobloxDev)
 */
export function getProjectFolderFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Mendapatkan ID hostSessionId dari tab yang sedang aktif di Claude Desktop saat ini
 */
export function getActiveClaudeDesktopHostSessionId(): string | null {
  try {
    const appDirs = getClaudeAppDirs();
    for (const appDir of appDirs) {
      const cfgPath = path.join(appDir, 'claude_desktop_config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const primaryId = cfg?.preferences?.epitaxyPrefs?.['desktop-frame.paneStore.v1']?.state?.lastPrimaryCodeSession?.id;
        if (primaryId) {
          return primaryId;
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Mendapatkan info lengkap tab yang sedang aktif di Claude Desktop
 */
export function getActiveDesktopSessionInfo(): { sessionId: string; name: string; cwd: string; model?: string; hostSessionId: string } | null {
  try {
    const hostId = getActiveClaudeDesktopHostSessionId();
    if (!hostId) return null;

    const appDirs = getClaudeAppDirs();
    for (const appDir of appDirs) {
      const sessionsBaseDir = path.join(appDir, 'claude-code-sessions');
      if (!fs.existsSync(sessionsBaseDir)) continue;

      function findDesktopSession(dir: string): any {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            const res = findDesktopSession(full);
            if (res) return res;
          } else if (e.name === `${hostId}.json`) {
            return JSON.parse(fs.readFileSync(full, 'utf8'));
          }
        }
        return null;
      }

      const s = findDesktopSession(sessionsBaseDir);
      if (s && s.cliSessionId && s.cwd) {
        return {
          sessionId: s.cliSessionId,
          name: s.title || path.basename(s.cwd),
          cwd: s.cwd,
          model: s.model,
          hostSessionId: hostId
        };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Mendapatkan semua sesi aktif yang terdaftar di Claude Desktop / Claude Code
 */
export function getActiveSessions(): ClaudeSession[] {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return [];
  }

  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions: ClaudeSession[] = [];
  const activeDesktopHostId = getActiveClaudeDesktopHostSessionId();

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (data.pid && (data.sessionId || data.hostSessionId)) {
        sessions.push({
          pid: data.pid,
          sessionId: data.sessionId || data.hostSessionId,
          name: data.title || data.name || (data.cwd ? path.basename(data.cwd) : 'Claude Session'),
          status: data.status || 'idle',
          cwd: data.cwd || process.cwd(),
          messagingSocketPath: data.messagingSocketPath || '',
          updatedAt: data.updatedAt,
          statusUpdatedAt: data.statusUpdatedAt,
          startedAt: data.startedAt,
          hostSessionId: data.hostSessionId,
          entrypoint: data.entrypoint
        });
      }
    } catch (e) {}
  }

  return sessions.sort((a, b) => {
    if (activeDesktopHostId) {
      if (a.hostSessionId === activeDesktopHostId && b.hostSessionId !== activeDesktopHostId) return -1;
      if (b.hostSessionId === activeDesktopHostId && a.hostSessionId !== activeDesktopHostId) return 1;
    }
    const timeA = a.updatedAt || a.statusUpdatedAt || a.startedAt || 0;
    const timeB = b.updatedAt || b.statusUpdatedAt || b.startedAt || 0;
    return timeB - timeA;
  });
}

/**
 * Mencari sesi yang diprioritaskan (otomatis tab aktif Claude Desktop, atau cocok dengan keyword)
 */
export function getPreferredSession(keyword?: string | null): ClaudeSession | null {
  const sessions = getActiveSessions();
  if (sessions.length === 0) return null;

  if (keyword && keyword !== 'discord') {
    const matched = sessions.find(s => s.name?.toLowerCase().includes(keyword.toLowerCase()));
    if (matched) return matched;
  }

  const activeDesktopHostId = getActiveClaudeDesktopHostSessionId();
  if (activeDesktopHostId) {
    const matchedDesktop = sessions.find(s => s.hostSessionId === activeDesktopHostId);
    if (matchedDesktop) return matchedDesktop;
  }

  return sessions[0];
}

/**
 * Menemukan path absolut file transkrip .jsonl untuk sessionId tertentu.
 */
export function findTranscriptFile(sessionId: string, cwd?: string): string | null {
  if (cwd && fs.existsSync(PROJECTS_DIR)) {
    const projFolder = getProjectFolderFromCwd(cwd);
    const candidate = path.join(PROJECTS_DIR, projFolder, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (fs.existsSync(PROJECTS_DIR)) {
    function search(dir: string): string | null {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          const found = search(p);
          if (found) return found;
        } else if (e.name === `${sessionId}.jsonl`) {
          return p;
        }
      }
      return null;
    }

    const found = search(PROJECTS_DIR);
    if (found) return found;
  }

  if (cwd) {
    const projFolder = getProjectFolderFromCwd(cwd);
    const projDir = path.join(PROJECTS_DIR, projFolder);
    if (!fs.existsSync(projDir)) {
      try {
        fs.mkdirSync(projDir, { recursive: true });
      } catch (_) {}
    }
    const expectedPath = path.join(projDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(expectedPath)) {
      try {
        fs.writeFileSync(expectedPath, '', 'utf8');
      } catch (_) {}
    }
    return expectedPath;
  }

  return null;
}
