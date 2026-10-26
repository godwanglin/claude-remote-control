import fs from 'fs';
import path from 'path';

export interface DetectedMediaFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  type: 'image' | 'audio' | 'video';
  oversized?: boolean;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.flv', '.wmv']);

const ALL_EXTENSIONS_LIST = 'png|jpe?g|webp|gif|svg|bmp|mp3|wav|ogg|m4a|flac|aac|wma|mp4|webm|mov|mkv|avi|m4v|flv|wmv';

// Regex untuk path yang diapit tanda kutip / backticks (mendukung path dengan spasi)
const quotedMediaRegex = new RegExp(`["'\x60]([^"'\x60\\r\\n]+?\\.(?:${ALL_EXTENSIONS_LIST}))["'\x60]`, 'gi');

// Regex untuk path unquoted biasa (mendukung absolute Windows C:\..., relative ./..., atau nama file langsung)
const unquotedMediaRegex = new RegExp(`(?:[a-zA-Z]:[\\\\/]|(?:\\.{1,2}[\\\\/])|[\\w\\-\\.]+[\\/\\\\])?[\\w\\-\\.\\/\\\\]+\\.(?:${ALL_EXTENSIONS_LIST})\\b`, 'gi');

/**
 * Mendeteksi file gambar, audio, dan video dari teks atau input perintah tool.
 * Menjamin hanya file yang BENAR-BENAR ADA dan BERISI di disk yang dikembalikan.
 * File non-media (kode, skrip, data, dokumen) otomatis diabaikan.
 */
export function detectTurnMediaFiles(options: {
  turnSources: string[];
  cwd: string;
  maxFileSize?: number;
}): DetectedMediaFile[] {
  const { turnSources, cwd, maxFileSize = 25 * 1024 * 1024 } = options;
  const seenPaths = new Set<string>();
  const results: DetectedMediaFile[] = [];

  for (const src of turnSources) {
    if (!src || typeof src !== 'string') continue;

    const candidates: string[] = [];

    // 1. Ekstrak path yang diapit tanda kutip (misal "C:\Folder Spasi\video.mp4")
    for (const match of src.matchAll(quotedMediaRegex)) {
      if (match[1]) candidates.push(match[1]);
    }

    // 2. Ekstrak path unquoted biasa
    const unquotedMatches = src.match(unquotedMediaRegex);
    if (unquotedMatches) {
      for (const m of unquotedMatches) {
        candidates.push(m);
      }
    }

    for (let candidate of candidates) {
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
          // Pastikan beneran file reguler, tidak kosong (size > 0), dan batas wajar <= 1GB
          if (stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024 * 1024) {
            const ext = path.extname(resolved).toLowerCase();

            let mediaType: 'image' | 'audio' | 'video' | null = null;
            if (IMAGE_EXTENSIONS.has(ext)) {
              mediaType = 'image';
            } else if (AUDIO_EXTENSIONS.has(ext)) {
              mediaType = 'audio';
            } else if (VIDEO_EXTENSIONS.has(ext)) {
              mediaType = 'video';
            }

            if (!mediaType) continue;

            const isOversized = stat.size > maxFileSize;

            results.push({
              path: resolved,
              name: path.basename(resolved),
              size: stat.size,
              mtime: stat.mtimeMs,
              type: mediaType,
              oversized: isOversized
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
