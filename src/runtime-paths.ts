import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const projectRoot = path.resolve(__dirname, '..');

/**
 * Deteksi apakah runtime berjalan dalam mode DEV (Development) atau PROD (Production)
 */
export function isDevMode(): boolean {
  if (process.env.NODE_ENV === 'development' || process.env.CRC_DEV === '1') {
    return true;
  }
  if (process.argv.includes('--dev')) {
    return true;
  }
  // Jika dieksekusi di dalam folder repositori git yang memiliki src/bot.ts
  const srcBot = path.join(projectRoot, 'src', 'bot.ts');
  if (fs.existsSync(srcBot)) {
    return true;
  }
  return false;
}

export interface RuntimePaths {
  isDev: boolean;
  rootDir: string;
  configDir: string;
  dataDir: string;
  logsDir: string;
  cacheDir: string;
  attachmentsDir: string;
  credentialsFile: string;
  settingsFile: string;
  channelsFile: string;
  daemonFile: string;
  logFile: string;
}

/**
 * Dapatkan direktori dan file runtime aktif
 */
export function getRuntimePaths(): RuntimePaths {
  const isDev = isDevMode();
  
  // DEV menggunakan .crc-dev di folder proyek, PROD menggunakan ~/.crc
  const rootDir = isDev 
    ? path.join(projectRoot, '.crc-dev')
    : path.join(os.homedir(), '.crc');

  const configDir = path.join(rootDir, 'config');
  const dataDir = path.join(rootDir, 'data');
  const logsDir = path.join(rootDir, 'logs');
  const cacheDir = path.join(rootDir, 'cache');
  const attachmentsDir = path.join(cacheDir, 'attachments');

  return {
    isDev,
    rootDir,
    configDir,
    dataDir,
    logsDir,
    cacheDir,
    attachmentsDir,
    credentialsFile: path.join(configDir, 'credentials.json'),
    settingsFile: path.join(configDir, 'settings.json'),
    channelsFile: path.join(dataDir, 'channels.json'),
    daemonFile: path.join(dataDir, 'daemon.json'),
    logFile: path.join(logsDir, 'crc.log')
  };
}

/**
 * Pastikan seluruh direktori runtime terbuat di disk
 */
export function ensureRuntimeDirs(): RuntimePaths {
  const paths = getRuntimePaths();
  const dirsToEnsure = [
    paths.rootDir,
    paths.configDir,
    paths.dataDir,
    paths.logsDir,
    paths.cacheDir,
    paths.attachmentsDir
  ];

  for (const dir of dirsToEnsure) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
  }

  return paths;
}
