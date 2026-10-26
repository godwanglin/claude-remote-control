import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.resolve(projectRoot, '.env');

dotenv.config({ path: envPath });

export interface AppConfig {
  discordToken: string;
  ownerId?: string;
  targetSessionKeyword: string;
}

export const config: AppConfig = {
  discordToken: process.env.DISCORD_TOKEN || '',
  ownerId: process.env.OWNER_ID || undefined,
  targetSessionKeyword: process.env.TARGET_SESSION || ''
};

export function saveOwnerId(userId: string) {
  config.ownerId = userId;
  try {
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    if (envContent.includes('OWNER_ID=')) {
      envContent = envContent.replace(/OWNER_ID=.*/g, `OWNER_ID=${userId}`);
    } else {
      envContent += `\nOWNER_ID=${userId}\n`;
    }

    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
    console.log(`\x1b[32m[Security]\x1b[0m Owner berhasil dikunci secara permanen: ${userId}`);
  } catch (err: any) {
    console.warn(`[Security Warning] Gagal menyimpan OWNER_ID ke .env:`, err.message);
  }
}
