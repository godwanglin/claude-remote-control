import fs from 'fs';
import { ClaudeSession, findTranscriptFile } from './ipc.js';
import { StatusCardData, renderStatusCard } from './status-card.js';
import { settingsManager } from './settings-manager.js';

export function getSessionStatus(session: ClaudeSession): StatusCardData {
  const sCfg = settingsManager.getSessionConfig(session.sessionId);
  let model = sCfg.model.includes('5-5') ? 'Opus 5.5 · Tinggi' : (sCfg.model.includes('4-6') ? 'Opus 4.6 · Tinggi' : sCfg.model);
  let inputTokens = 85978;
  let totalTokens = 1_000_000;

  const transcriptPath = findTranscriptFile(session.sessionId);
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.message?.usage) {
            inputTokens = entry.message.usage.input_tokens || inputTokens;
            if (!sCfg.isModelOverridden) {
              const rawModel = (entry.message.model || '').toLowerCase();
              if (rawModel.includes('5-5') || rawModel.includes('5.5')) {
                model = 'Opus 5.5 · Tinggi';
              } else if (rawModel.includes('4-6') || rawModel.includes('4.6') || rawModel.includes('opus') || rawModel === 'gpt-5.6-luna') {
                model = 'Opus 4.6 · Tinggi';
              } else if (rawModel) {
                model = entry.message.model;
              }
            }
            break;
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[SessionStatus Warn] Gagal membaca transcript:', e);
    }
  }

  const permNameMap: Record<string, string> = {
    bypassPermissions: 'Lewati izin (Bypass)',
    auto: 'Auto (Otomatis)',
    acceptEdits: 'Terima Edit (Accept)',
    manual: 'Manual (Konfirmasi)',
    dontAsk: 'Jangan Tanya (Silent)',
    plan: 'Plan (Hanya Rencana)'
  };
  const permissionMode = permNameMap[sCfg.permissionMode] || sCfg.permissionMode;

  return {
    claudeCodeVersion: (session as any).version || '2.1.308',
    desktopVersion: '3.6556.2 (Windows x64)',
    model,
    permissionMode,
    sessionId: session.sessionId,
    sessionName: session.name,
    status: session.status || 'idle',
    inputTokens,
    totalTokens,
    folder: session.cwd || 'C:\\dev\\RobloxDev',
    user: 'aiden',
    organization: 'Gateway'
  };
}

export function buildStatusMessage(session: ClaudeSession, fullId: boolean = true): string {
  const data = getSessionStatus(session);
  // Lebar 62 agar full UUID utuh pas dan presisi
  const width = fullId ? 62 : 54;
  return renderStatusCard(data, width);
}
