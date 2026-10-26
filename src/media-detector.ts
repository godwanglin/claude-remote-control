import fs from 'fs';
import path from 'path';

export interface DetectedMediaFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  type: 'image' | 'audio';
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

/**
 * Mendeteksi file gambar dan audio dari teks atau input perintah tool.
 * Menjamin hanya file yang BENAR-BENAR ADA dan BERISI di disk yang dikembalikan.
 * File non-media (kode, skrip, data, dokumen) otomatis diabaikan.
 */
export function detectTurnMediaFiles(options: {
  turnSources: string[];
  cwd: string;
}): DetectedMediaFile[] {
  const { turnSources, cwd } = options;
  // Regex mendeteksi path lokal berakhiran ekstensi media (image / audio)
  const mediaRegex = /(?:[a-zA-Z]:[\\\/]|(?:\.{1,2}[\\\/])|[\w\-\.]+[\/\\])?[\w\-\.\/\\]+\.(?:png|jpe?g|webp|gif|mp3|wav|ogg|m4a)\b/gi;
  const seenPaths = new Set<string>();
  const results: DetectedMediaFile[] = [];

  for (const src of turnSources) {
    if (!src || typeof src !== 'string') continue;
    const matches = src.match(mediaRegex);
    if (!matches) continue;

    for (let candidate of matches) {
      // Bersihkan tanda baca pembuka dan penutup seperti backtick, petik, kurung, koma, dsb
      candidate = candidate.replace(/^[`'"(\[]+/, '').replace(/[`'")\],;:*]+$/, '').trim();
      if (!candidate) continue;

      const resolved = path.isAbsolute(candidate)
        ? path.normalize(candidate)
        : path.normalize(path.resolve(cwd, candidate));

      // Jangan attach kembali file lampiran input user yang tersimpan di cache attachments
      const normalizedKey = resolved.replace(/\\/g, '/').toLowerCase();
      if (normalizedKey.includes('/.claude/cache/attachments/') || normalizedKey.includes('/cache/attachments/')) {
        continue;
      }

      const key = resolved.toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);

      // Verifikasi mutlak: Pastikan file BENAR-BENAR ADA di disk fisik
      if (fs.existsSync(resolved)) {
        try {
          const stat = fs.statSync(resolved);
          // Pastikan beneran file reguler, tidak kosong (size > 0), dan tidak melebihi limit 25MB Discord
          if (stat.isFile() && stat.size > 0 && stat.size <= 25 * 1024 * 1024) {
            const ext = path.extname(resolved).toLowerCase();
            const mediaType: 'image' | 'audio' = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'audio';

            results.push({
              path: resolved,
              name: path.basename(resolved),
              size: stat.size,
              mtime: stat.mtimeMs,
              type: mediaType
            });
          }
        } catch (_) {
          // Abaikan jika ada permission error pada file
        }
      }
    }
  }

  return results;
}
