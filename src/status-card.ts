const esc = '\u001b';
const stripAnsi = (str: string) => str.replace(/\u001b\[[0-9;]*m/g, '');

export interface StatusCardData {
  claudeCodeVersion: string;
  desktopVersion?: string;
  model: string;
  permissionMode?: string;
  sessionId: string;
  sessionName?: string;
  status: 'idle' | 'busy' | string;
  inputTokens: number;
  totalTokens: number;
  folder: string;
  user: string;
  organization?: string;
}

export function formatTokens(num: number): string {
  if (num >= 1_000_000) {
    const m = num / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}k`;
  }
  return num.toString();
}

export function wrapRow(row: string, maxWidth: number): string[] {
  const visualLen = stripAnsi(row).length;
  if (visualLen <= maxWidth) return [row];

  const colonIdx = row.indexOf(': ');
  if (colonIdx !== -1) {
    const prefix = row.slice(0, colonIdx + 2);
    const value = row.slice(colonIdx + 2);
    const prefixLen = stripAnsi(prefix).length;
    const valueWidth = maxWidth - prefixLen;

    if (valueWidth > 10) {
      const ansiMatch = value.match(/^\u001b\[[0-9;]*m/);
      const ansiStart = ansiMatch ? ansiMatch[0] : '';
      const rawVal = stripAnsi(value);

      const subLines: string[] = [];
      let rem = rawVal;
      while (rem.length > valueWidth) {
        let cut = valueWidth;
        const slice = rem.slice(0, valueWidth);
        const delim = Math.max(
          slice.lastIndexOf('\\'),
          slice.lastIndexOf('/'),
          slice.lastIndexOf(' '),
          slice.lastIndexOf('-')
        );
        if (delim > 8) cut = delim + 1;
        subLines.push(rem.slice(0, cut));
        rem = rem.slice(cut);
      }
      if (rem) subLines.push(rem);

      const indent = ' '.repeat(prefixLen);
      return subLines.map((s, i) => {
        const colored = ansiStart ? `${ansiStart}${s}${esc}[0m` : s;
        return i === 0 ? `${prefix}${colored}` : `${indent}${colored}`;
      });
    }
  }

  // Fallback wrapping untuk teks biasa
  const subLines: string[] = [];
  const words = row.split(' ');
  let cur = '';

  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (stripAnsi(test).length <= maxWidth) {
      cur = test;
    } else {
      if (cur) subLines.push(cur);
      cur = w;
    }
  }
  if (cur) subLines.push(cur);
  return subLines.length > 0 ? subLines : [row];
}

export function renderStatusCard(data: StatusCardData, width: number = 62): string {
  const usableWidth = width - 4; // 1 border + 1 space kiri & kanan

  const usedTokens = data.inputTokens || 0;
  const totalTokens = data.totalTokens || 1_000_000;
  const remainingTokens = Math.max(0, totalTokens - usedTokens);
  const percent = Math.min(100, Math.max(0, (usedTokens / totalTokens) * 100));
  const percentStr = percent.toFixed(1) + '%';

  // Bar progress 20 blok
  const barTotal = 20;
  const filledCount = Math.min(barTotal, Math.max(0, Math.round((usedTokens / totalTokens) * barTotal)));
  const emptyCount = barTotal - filledCount;

  // Warna status token
  let tokenColor = `${esc}[1;32m`; // Hijau
  if (percent >= 90) tokenColor = `${esc}[1;31m`; // Merah
  else if (percent >= 70) tokenColor = `${esc}[1;33m`; // Kuning

  const filledBar = `${tokenColor}${'■'.repeat(filledCount)}${esc}[0m`;
  const emptyBar = `${esc}[0;30m${'□'.repeat(emptyCount)}${esc}[0m`;
  const barVisual = `[${'■'.repeat(filledCount)}${'□'.repeat(emptyCount)}]`;

  // Status dot footer
  const isIdle = (data.status || 'idle').toLowerCase() === 'idle';
  const statusColor = isIdle ? `${esc}[1;32m` : `${esc}[1;33m`;
  const statusLabel = isIdle ? '● Aktif (Idle)' : '● Memproses (Busy)';
  const footerColored = `${statusColor}${statusLabel}${esc}[0m`;

  // Baris-baris data (label dibuat seragam 18 karakter)
  const padLabel = (lbl: string) => lbl.padEnd(18, ' ');

  // ID Sesi bersih tanpa titik-titik (...)
  const maxSessionIdLen = usableWidth - 22; // 2 space + 18 label + 2 (": ")
  const cleanSessionId = data.sessionId.length > maxSessionIdLen
    ? data.sessionId.slice(0, maxSessionIdLen)
    : data.sessionId;

  const rows: (string | null)[] = [
    null,
    `${esc}[1;36mSESI${esc}[0m`,
    `  ${padLabel('Claude Code')}: ${esc}[1;33m${data.claudeCodeVersion}${esc}[0m`,
    `  ${padLabel('Desktop')}: ${data.desktopVersion || '3.6556.2 (Windows x64)'}`,
    `  ${padLabel('Model')}: ${esc}[1;32m${data.model}${esc}[0m`,
    `  ${padLabel('Izin')}: ${data.permissionMode || 'Lewati izin (Bypass)'}`,
    `  ${padLabel('ID Sesi')}: ${cleanSessionId}`,
    null,
    `${esc}[1;36mJENDELA KONTEKS${esc}[0m`,
    `  ${padLabel('Penggunaan')}: ${tokenColor}${formatTokens(usedTokens)} / ${formatTokens(totalTokens)} (${percentStr})${esc}[0m`,
    `  [${filledBar}${emptyBar}]  ${formatTokens(remainingTokens)} sisa`,
    null,
    `${esc}[1;36mLINGKUNGAN & AKUN${esc}[0m`,
    `  ${padLabel('Folder')}: ${esc}[1;36m${data.folder}${esc}[0m`,
    `  ${padLabel('User')}: ${data.user}${data.organization ? ` (${data.organization})` : ''}`,
    null
  ];

  // Top border: ┌── CLAUDE SESSION STATUS ──────────────────────────┐
  const titleText = `── CLAUDE SESSION STATUS `;
  const topDashCount = Math.max(0, width - 2 - titleText.length);
  const topLine = `${esc}[1;37m┌${titleText}${'─'.repeat(topDashCount)}┐${esc}[0m`;

  // Bottom border: └─── ● Aktif (Idle) ────────────────────────────────┘
  const footerPrefix = `─── `;
  const footerTextRaw = `${footerPrefix}${statusLabel} `;
  const bottomDashCount = Math.max(0, width - 2 - footerTextRaw.length);
  const bottomLine = `${esc}[1;37m└${footerPrefix}${footerColored} ${esc}[1;37m${'─'.repeat(bottomDashCount)}┘${esc}[0m`;

  const flattenedRows: (string | null)[] = [];
  for (const row of rows) {
    if (row === null) {
      flattenedRows.push(null);
    } else {
      flattenedRows.push(...wrapRow(row, usableWidth));
    }
  }

  const bodyLines = flattenedRows.map(row => {
    if (row === null) {
      return `${esc}[1;37m│${esc}[0m${' '.repeat(width - 2)}${esc}[1;37m│${esc}[0m`;
    }
    const visualLen = stripAnsi(row).length;
    const pad = Math.max(0, usableWidth - visualLen);
    return `${esc}[1;37m│${esc}[0m ${row}${' '.repeat(pad)} ${esc}[1;37m│${esc}[0m`;
  });

  return ['```ansi', topLine, ...bodyLines, bottomLine, '```'].join('\n');
}
