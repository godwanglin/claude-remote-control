/**
 * MessageBuilder - Fluent API untuk menyusun pesan Discord
 * dengan format ANSI terminal dan berbagai codeblock bahasa pemrograman.
 */
export class MessageBuilder {
  private parts: string[] = [];
  private static readonly ESC = '\u001b';
  private static readonly MAX_DISCORD_LENGTH = 1950; // Aman di bawah batas 2000 karakter Discord

  /**
   * Menambahkan teks biasa / paragraf markdown
   */
  public text(content: string): this {
    if (content && content.trim()) {
      this.parts.push(content);
    }
    return this;
  }

  /**
   * Menambahkan command terminal dengan formatting warna ANSI:
   * - Command: Biru Cyan (1;34m)
   * - Output Sukses: Hijau (1;32m)
   * - Output Error: Merah (1;31m)
   * 
   * Jika dipanggil berurutan, otomatis disatukan ke dalam 1 box terminal yang sama
   * sehingga tidak ada celah spasi antar kotak!
   */
  public commandAnsi(command: string, output?: string, isError: boolean = false): this {
    const esc = MessageBuilder.ESC;
    const cmdLine = `${esc}[1;34m> ${command.trim()}${esc}[0m`;
    
    let blockContent = cmdLine;
    if (output && output.trim()) {
      let cleanOut = output.trim();
      // Deteksi jika output adalah payload base64 image yang sangat panjang
      if (cleanOut.includes('"type":"image"') && cleanOut.includes('"type":"base64"')) {
        cleanOut = `[Data Gambar Base64 (${cleanOut.length} bytes)]`;
      } else if (cleanOut.length > 800) {
        cleanOut = cleanOut.slice(0, 750) + '\n... [output dipotong]';
      }
      const outColor = isError ? `${esc}[1;31m` : `${esc}[1;32m`;
      blockContent += `\n${outColor}${cleanOut}${esc}[0m`;
    }

    const ansiBlock = `\`\`\`ansi\n${blockContent}\n\`\`\``;
    this.parts.push(ansiBlock);
    return this;
  }

  /**
   * Menambahkan generic code block (TypeScript, JavaScript, Python, JSON, dll)
   */
  public code(language: string, content: string): this {
    const lang = (language || '').toLowerCase().trim();
    const codeBlock = `\`\`\`${lang}\n${content.trim()}\n\`\`\``;
    this.parts.push(codeBlock);
    return this;
  }

  /**
   * Menambahkan indikator status realtime saat proses sedang berjalan
   */
  public status(type: 'thinking' | 'running' | 'success' | 'error', text: string): this {
    const icons = {
      thinking: '⏳',
      running: '⚙️',
      success: '✅',
      error: '❌'
    };
    const icon = icons[type] || '📌';
    this.parts.push(`${icon} *${text.trim()}*`);
    return this;
  }

  /**
   * Menambahkan code block format git diff (+ hijau, - merah).
   * Dilengkapi proteksi batasan baris/karakter agar pesan tidak kepanjangan.
   */
  public diff(filename: string, patch: string, maxLines: number = 12): this {
    const lines = patch.trim().split('\n');
    
    // Hitung jumlah penambahan (+) dan pengurangan (-)
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    const stats = (additions > 0 || deletions > 0) ? ` \`(+${additions} -${deletions})\`` : '';
    const header = filename ? `📄 \`${filename}\`${stats}\n` : '';

    let displayedLines = lines;
    let truncatedNotice = '';

    if (lines.length > maxLines) {
      displayedLines = lines.slice(0, maxLines);
      const hiddenCount = lines.length - maxLines;
      truncatedNotice = `\n... [dan ${hiddenCount} baris perubahan lainnya]`;
    }

    const diffContent = displayedLines.join('\n') + truncatedNotice;
    const diffBlock = `${header}\`\`\`diff\n${diffContent}\n\`\`\``;
    this.parts.push(diffBlock);
    return this;
  }

  /**
   * Menambahkan tabel kotak Unicode presisi dan rapi di Discord
   */
  public table(headers: string[], rows: string[][]): this {
    if (!headers || headers.length === 0) return this;

    const colCount = headers.length;
    // Hitung lebar maksimum tiap kolom
    const colWidths: number[] = headers.map((h, i) => {
      let max = h.length;
      for (const row of rows) {
        const cell = row[i] || '';
        if (cell.length > max) max = cell.length;
      }
      return max + 2; // padding 1 spasi kiri dan kanan
    });

    const formatRow = (cells: string[]) => {
      return '│' + cells.map((cell, i) => {
        const text = cell || '';
        const padding = ' '.repeat(colWidths[i] - text.length - 1);
        return ` ${text}${padding}`;
      }).join('│') + '│';
    };

    const topBorder = '┌' + colWidths.map(w => '─'.repeat(w)).join('┬') + '┐';
    const midBorder = '├' + colWidths.map(w => '─'.repeat(w)).join('┼') + '┤';
    const botBorder = '└' + colWidths.map(w => '─'.repeat(w)).join('┴') + '┘';

    const tableLines = [
      topBorder,
      formatRow(headers),
      midBorder,
      ...rows.map(row => formatRow(row)),
      botBorder
    ];

    const tableBlock = `\`\`\`text\n${tableLines.join('\n')}\n\`\`\``;
    this.parts.push(tableBlock);
    return this;
  }

  /**
   * Menambahkan kutipan blockquote (>)
   */
  public quote(content: string): this {
    const quoted = content
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
    this.parts.push(quoted);
    return this;
  }

  /**
   * Menambahkan baris baru / enter secara eksplisit.
   * Default: 1x enter (\n).
   * Contoh: .newline(2) atau .enter(2) untuk memberikan jarak baris kosong.
   */
  public newline(count: number = 1): this {
    const times = Math.max(1, count);
    this.parts.push('\n'.repeat(times));
    return this;
  }

  /**
   * Alias dari .newline()
   */
  public enter(count: number = 1): this {
    return this.newline(count);
  }

  /**
   * Menambahkan garis divider unicode halus
   */
  public divider(): this {
    this.parts.push('──────────────────────────────');
    return this;
  }

  /**
   * Reset seluruh buffer pesan
   */
  public clear(): this {
    this.parts = [];
    return this;
  }

  /**
   * Menggabungkan seluruh bagian pesan menjadi string final siap kirim ke Discord.
   * Dilengkapi pengaman otomatis agar tidak melebihi batas 2000 karakter Discord.
   */
  public build(maxLength: number = MessageBuilder.MAX_DISCORD_LENGTH): string {
    let result = '';

    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      const isNewline = /^\n+$/.test(part);
      const isCode = part.startsWith('```');
      const prevPart = i > 0 ? this.parts[i - 1] : '';
      const prevIsNewline = /^\n+$/.test(prevPart);
      const prevIsCode = prevPart.endsWith('```');

      // Pengaturan jarak:
      if (result.length > 0 && !isNewline && !prevIsNewline) {
        if (isCode && prevIsCode) {
          result += '\n'; // Berikan baris baru antar codeblock agar tidak menyatu menjadi 6 backticks!
        } else if (isCode || prevIsCode) {
          result += '\n';
        } else {
          result += '\n\n';
        }
      }

      result += part;
    }

    // Pemangkas aman jika melebihi batas Discord
    if (result.length > maxLength) {
      const cut = result.slice(0, maxLength - 30);
      // Periksa apakah terpotong di dalam codeblock (jumlah ``` ganjil)
      const codeBlockCount = (cut.match(/```/g) || []).length;
      if (codeBlockCount % 2 !== 0) {
        result = cut + '\n... [Log dipotong]\n```';
      } else {
        result = cut + '\n... [Log dipotong]';
      }
    }

    return result.trim();
  }
}

export interface StepRecord {
  type: 'tool' | 'text';
  toolName?: string;
  command?: string;
  output?: string;
  isError?: boolean;
  text?: string;
}

/**
 * Memformat satu step eksekusi tool menjadi blok ANSI Markdown yang valid dan utuh
 */
export function formatToolStep(step: { command?: string; output?: string; isError?: boolean }): string {
  const esc = '\u001b';
  const cmdLine = `${esc}[1;34m> ${(step.command || '').trim()}${esc}[0m`;
  let blockContent = cmdLine;
  if (step.output && step.output.trim()) {
    let cleanOut = step.output.trim();
    if (cleanOut.includes('"type":"image"') && cleanOut.includes('"type":"base64"')) {
      cleanOut = `[Data Gambar Base64 (${cleanOut.length} bytes)]`;
    } else if (cleanOut.length > 800) {
      cleanOut = cleanOut.slice(0, 750) + '\n... [output dipotong]';
    }
    const outColor = step.isError ? `${esc}[1;31m` : `${esc}[1;32m`;
    blockContent += `\n${outColor}${cleanOut}${esc}[0m`;
  }
  return `\`\`\`ansi\n${blockContent}\n\`\`\``;
}

/**
 * Memecah code block yang luar biasa panjang secara aman per baris
 * sehingga setiap chunk selalu memiliki fence pembuka dan penutup yang valid!
 */
export function splitLargeCodeBlock(block: string, maxLen: number = 1700): string[] {
  if (block.length <= maxLen) return [block];
  const lines = block.split('\n');
  const openFence = lines[0]; // misal ```lua atau ```ansi
  const closeFence = '```';
  const innerLines = lines.slice(1, -1);
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentLen = openFence.length + closeFence.length + 2;

  for (const line of innerLines) {
    if (currentLen + line.length + 1 > maxLen && currentLines.length > 0) {
      chunks.push(`${openFence}\n${currentLines.join('\n')}\n${closeFence}`);
      currentLines = [`// (Lanjutan)\n${line}`];
      currentLen = openFence.length + closeFence.length + 2 + currentLines[0].length;
    } else {
      currentLines.push(line);
      currentLen += line.length + 1;
    }
  }

  if (currentLines.length > 0) {
    chunks.push(`${openFence}\n${currentLines.join('\n')}\n${closeFence}`);
  }
  return chunks;
}

/**
 * Mengurai teks markdown Claude menjadi unit-unit atomik (code block & paragraf)
 * agar tidak pernah terpotong di tengah code block atau format markdown!
 */
export function parseMarkdownUnits(text: string): string[] {
  const units: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) {
      const paras = before.split(/\n\s*\n/);
      for (const p of paras) {
        if (p.trim()) units.push(p.trim());
      }
    }
    const rawBlock = match[0].trim();
    if (rawBlock.length > 1700) {
      units.push(...splitLargeCodeBlock(rawBlock, 1700));
    } else {
      units.push(rawBlock);
    }
    lastIndex = match.index + match[0].length;
  }

  const remaining = text.slice(lastIndex).trim();
  if (remaining) {
    const count = (remaining.match(/```/g) || []).length;
    let safeRemaining = remaining;
    if (count % 2 !== 0) {
      safeRemaining += '\n```';
    }
    const paras = safeRemaining.split(/\n\s*\n/);
    for (const p of paras) {
      if (p.trim()) units.push(p.trim());
    }
  }

  return units;
}

/**
 * Mengemas rangkaian step eksekusi menjadi pesan-pesan (bubbles) Discord
 * secara utuh dan aman tanpa memecah blok tool atau code block di tengah jalan.
 */
export function packStepsIntoBubbles(
  steps: StepRecord[], 
  verbosity: 'detail' | 'compact' = 'detail',
  statusFooter?: string,
  maxBubbleLen: number = 1850
): string[] {
  const units: string[] = [];

  for (const step of steps) {
    if (step.type === 'tool' && step.command) {
      if (verbosity === 'detail') {
        units.push(formatToolStep(step));
      }
    } else if (step.type === 'text' && step.text) {
      const parsed = parseMarkdownUnits(step.text);
      units.push(...parsed);
    }
  }

  if (units.length === 0) {
    return statusFooter ? [statusFooter] : [''];
  }

  const bubbles: string[] = [];
  let currentBubble = '';

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const separator = currentBubble.length > 0 ? '\n\n' : '';

    if (currentBubble.length + separator.length + unit.length <= maxBubbleLen) {
      currentBubble += separator + unit;
    } else {
      if (currentBubble.length > 0) {
        bubbles.push(currentBubble.trim());
        currentBubble = unit;
      } else {
        // Fallback jika unit tunggal lebih panjang dari maxBubbleLen
        let remaining = unit;
        while (remaining.length > maxBubbleLen) {
          bubbles.push(remaining.slice(0, maxBubbleLen));
          remaining = remaining.slice(maxBubbleLen);
        }
        currentBubble = remaining;
      }
    }
  }

  // Tambahkan status footer ke bubble terakhir jika ada
  if (statusFooter) {
    const sep = currentBubble.length > 0 ? '\n\n' : '';
    if (currentBubble.length + sep.length + statusFooter.length <= 1950) {
      currentBubble += sep + statusFooter;
    } else {
      if (currentBubble.trim().length > 0) bubbles.push(currentBubble.trim());
      currentBubble = statusFooter;
    }
  }

  if (currentBubble.trim().length > 0) {
    bubbles.push(currentBubble.trim());
  }

  return bubbles.length > 0 ? bubbles : [''];
}
