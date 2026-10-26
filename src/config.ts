import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getRuntimePaths, ensureRuntimeDirs, projectRoot } from './runtime-paths.js';

const envPath = path.resolve(projectRoot, '.env');
dotenv.config({ path: envPath });

export interface AppConfig {
  discordToken: string;
  ownerId?: string;
  targetSessionKeyword: string;
}

/**
 * Muat kredensial dari credentials.json atau fallback ke .env / environment variables
 */
function loadInitialConfig(): AppConfig {
  const paths = ensureRuntimeDirs();
  let token = process.env.DISCORD_TOKEN || '';
  let ownerId = process.env.OWNER_ID || undefined;

  if (fs.existsSync(paths.credentialsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(paths.credentialsFile, 'utf8'));
      if (data.discordToken) token = data.discordToken;
      if (data.ownerId) ownerId = data.ownerId;
    } catch (_) {}
  }

  return {
    discordToken: token,
    ownerId,
    targetSessionKeyword: process.env.TARGET_SESSION || ''
  };
}

export const config: AppConfig = loadInitialConfig();

/**
 * Simpan kredensial (Token Discord dan/atau Owner ID) secara permanen
 */
export function saveCredentials(token?: string, ownerId?: string): void {
  const paths = ensureRuntimeDirs();
  
  if (token !== undefined) config.discordToken = token;
  if (ownerId !== undefined) config.ownerId = ownerId;

  // 1. Simpan ke credentials.json
  try {
    const creds = {
      discordToken: config.discordToken,
      ownerId: config.ownerId,
      updatedAt: Date.now()
    };
    fs.writeFileSync(paths.credentialsFile, JSON.stringify(creds, null, 2), 'utf8');
  } catch (err: any) {
    console.warn(`[Config Warn] Gagal menyimpan ke credentials.json:`, err.message);
  }

  // 2. Jika dalam mode dev dan file .env ada di projectRoot, sinkronkan juga ke .env
  if (fs.existsSync(envPath)) {
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (token !== undefined) {
        if (envContent.includes('DISCORD_TOKEN=')) {
          envContent = envContent.replace(/DISCORD_TOKEN=.*/g, `DISCORD_TOKEN=${token}`);
        } else {
          envContent += `\nDISCORD_TOKEN=${token}\n`;
        }
      }
      if (ownerId !== undefined) {
        if (envContent.includes('OWNER_ID=')) {
          envContent = envContent.replace(/OWNER_ID=.*/g, `OWNER_ID=${ownerId}`);
        } else {
          envContent += `\nOWNER_ID=${ownerId}\n`;
        }
      }
      fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
    } catch (_) {}
  }
}

export function saveOwnerId(userId: string): void {
  saveCredentials(undefined, userId);
  console.log(`\x1b[32m[Security]\x1b[0m Owner berhasil dikunci secara permanen: ${userId}`);
}

/**
 * Verifikasi token bot langsung ke Discord REST API (/users/@me)
 */
export async function verifyDiscordToken(token: string): Promise<{ valid: boolean; botUser?: any; error?: string }> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { valid: false, error: 'Token kosong.' };
  }

  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bot ${cleanToken}`
      }
    });

    if (res.status === 200) {
      const data = await res.json();
      return { valid: true, botUser: data };
    }

    if (res.status === 401) {
      return { valid: false, error: 'Token tidak valid (Unauthorized 401).' };
    }

    return { valid: false, error: `Discord API merespons dengan HTTP ${res.status}.` };
  } catch (err: any) {
    return { valid: false, error: `Gagal menghubungi Discord API: ${err.message}` };
  }
}

/**
 * Verifikasi User ID owner langsung ke Discord REST API (/users/{userId})
 */
export async function verifyDiscordOwner(token: string, ownerId: string): Promise<{ valid: boolean; user?: any; error?: string }> {
  const cleanOwnerId = ownerId.trim();
  if (!cleanOwnerId) {
    return { valid: false, error: 'Owner ID kosong.' };
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/users/${cleanOwnerId}`, {
      headers: {
        Authorization: `Bot ${token.trim()}`
      }
    });

    if (res.status === 200) {
      const data = await res.json();
      return { valid: true, user: data };
    }

    return { valid: false, error: `User ID tidak ditemukan di Discord (HTTP ${res.status}).` };
  } catch (err: any) {
    return { valid: false, error: `Gagal verifikasi owner: ${err.message}` };
  }
}

/**
 * Menghasilkan link invite OAuth2 bot dengan permissions Administrator (8)
 */
export function getBotInviteUrl(clientId: string, permissions: string = '8'): string {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
}
