import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const SESSION_ID = '2226e8b4-5c7a-4acc-80f7-a6f011c5fddc';

// 1. Ambil prompt dari argumen CLI
const promptArgs = process.argv.slice(2).join(' ').trim();
const prompt = promptArgs || 'tolong cek versi nodejs dan git di pc aku';

// Warna ANSI untuk tampilan terminal
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

// 2. Baca kredensial gateway aktif dari Claude Desktop
function getHostCredentials() {
  const claude3pDir = path.join(process.env.LOCALAPPDATA || 'C:/Users/aiden/AppData/Local', 'Claude-3p');
  if (fs.existsSync(claude3pDir)) {
    const credFiles = fs.readdirSync(claude3pDir).filter(f => f.startsWith('host-creds-') && f.endsWith('.json'));
    if (credFiles.length > 0) {
      credFiles.sort((a, b) => {
        const statA = fs.statSync(path.join(claude3pDir, a));
        const statB = fs.statSync(path.join(claude3pDir, b));
        return statB.mtimeMs - statA.mtimeMs;
      });
      try {
        const data = JSON.parse(fs.readFileSync(path.join(claude3pDir, credFiles[0]), 'utf8'));
        if (data.env) return data.env;
      } catch (_) {}
    }
  }
  return {};
}

const hostCreds = getHostCredentials();
const spawnEnv = {
  ...process.env,
  ...hostCreds,
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3p'
};

console.log(`${colors.cyan}============================================================${colors.reset}`);
console.log(`${colors.bold}${colors.green}  CLAUDE NATIVE STREAM TESTER${colors.reset}`);
console.log(`${colors.cyan}============================================================${colors.reset}`);
console.log(`${colors.gray}Target Session :${colors.reset} ${colors.yellow}${SESSION_ID}${colors.reset}`);
console.log(`${colors.gray}Gateway URL    :${colors.reset} ${hostCreds.ANTHROPIC_BASE_URL || 'Default'}`);
console.log(`${colors.gray}Prompt         :${colors.reset} "${colors.bold}${prompt}${colors.reset}"`);
console.log(`${colors.cyan}------------------------------------------------------------${colors.reset}\n`);

// 3. Spawn Claude Code CLI native
const args = [
  '-p', prompt,
  '-r', SESSION_ID,
  '--model=claude-opus-5-5',
  '--permission-mode=bypassPermissions',
  '--allow-dangerously-skip-permissions',
  '--output-format=stream-json',
  '--include-partial-messages',
  '--verbose'
];

// Cari binary claude langsung agar cepat & tanpa warning shell
function getClaudeBinary() {
  const localAppDir = path.join(process.env.LOCALAPPDATA || 'C:/Users/aiden/AppData/Local', 'Claude-3p', 'claude-code');
  if (fs.existsSync(localAppDir)) {
    const versions = fs.readdirSync(localAppDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const vDir = path.join(localAppDir, v);
      if (fs.statSync(vDir).isDirectory()) {
        const hashes = fs.readdirSync(vDir);
        for (const h of hashes) {
          const candidate = path.join(vDir, h, 'claude.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return 'claude';
}

const claudeBin = getClaudeBinary();

const child = spawn(claudeBin, args, {
  env: spawnEnv,
  stdio: ['pipe', 'pipe', 'pipe']
});

// Tutup stdin segera agar Claude CLI tidak menunggu input terminal 3 detik
child.stdin.end();

let isFirstText = true;
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Simpan sisa baris yang belum selesai

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const data = JSON.parse(line);

      // A. Status / Tahap Sistem
      if (data.type === 'system') {
        if (data.subtype === 'status' && data.status === 'requesting') {
          console.log(`\n${colors.magenta}⏳ [Claude Berpikir / Mengirim Request ke Gateway...]${colors.reset}`);
        } else if (data.subtype === 'init') {
          console.log(`${colors.gray}[System] Sesi terhubung: ${data.session_id}${colors.reset}`);
        } else if (data.subtype === 'post_turn_summary') {
          console.log(`\n\n${colors.green}✔ [TURN SELESAI] Status: ${data.status_category || 'completed'}${colors.reset}`);
        }
      }

      // B. Claude Memanggil Tool Terminal (PowerShell / Bash / Read / Edit)
      if (data.event?.type === 'content_block_start' && data.event.content_block?.type === 'tool_use') {
        const tool = data.event.content_block;
        console.log(`\n${colors.yellow}⚡ [TOOL USE: ${tool.name}]${colors.reset}`);
      }

      // Seringkali argumen tool tiba di blok assistant
      if (data.type === 'assistant' && data.message?.content) {
        for (const item of data.message.content) {
          if (item.type === 'tool_use') {
            const inputStr = item.input ? JSON.stringify(item.input, null, 2) : '';
            console.log(`${colors.yellow}   Input Tool: ${colors.dim}${inputStr.split('\n').join('\n   ')}${colors.reset}`);
          }
        }
      }

      // C. Hasil Output Terminal Diterima (tool_result)
      if (data.type === 'user' && data.message?.content) {
        for (const item of data.message.content) {
          if (item.type === 'tool_result') {
            console.log(`\n${colors.blue}📋 [HASIL TOOL / OUTPUT TERMINAL]:${colors.reset}`);
            const resultText = item.content || '(Output kosong)';
            console.log(`${colors.dim}${resultText.trim()}${colors.reset}`);
          }
        }
      }

      // D. Teks Jawaban Final Mengalir (Streaming Text Delta)
      if (data.event?.delta?.type === 'text_delta') {
        if (isFirstText) {
          console.log(`\n${colors.green}${colors.bold}💬 [JAWABAN CLAUDE]:${colors.reset}`);
          isFirstText = false;
        }
        process.stdout.write(data.event.delta.text);
      }

      // E. Error API
      if (data.type === 'system' && data.subtype === 'api_error') {
        console.error(`\n${colors.red}❌ [API ERROR]: ${JSON.stringify(data.error)}${colors.reset}`);
      }

    } catch (_) {
      // Baris non-JSON (misal log internal)
      // console.log(`${colors.gray}[RAW] ${line}${colors.reset}`);
    }
  }
});

child.stderr.on('data', (errChunk) => {
  const errText = errChunk.toString();
  // Filter warning stdin yang biasa
  if (!errText.includes('Warning: no stdin data received')) {
    console.error(`${colors.red}[STDERR] ${errText.trim()}${colors.reset}`);
  }
});

child.on('exit', (code) => {
  console.log(`\n${colors.cyan}------------------------------------------------------------${colors.reset}`);
  console.log(`${colors.gray}Proses selesai dengan kode keluar: ${code}${colors.reset}\n`);
});
