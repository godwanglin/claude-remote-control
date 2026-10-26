# Implementation Plan: Architecture Overhaul - Project-Path Discord Categories, Unified Runtime Storage (~/.crc), Auto-Sync (1 Min), and Luxury Interactive TUI CLI

## Ringkasan Tujuan
Transformasi total arsitektur runtime, pengorganisasian Discord, dan antarmuka CLI Claude Remote Control (CRC):
1. **Interactive TUI CLI & Setup Wizard (@clack/prompts)**: Antarmuka terminal interaktif mewah dengan panah $\uparrow/\downarrow$, masking token, spinner animasi verifikasi Discord API, dan generator link invite bot instan.
2. **Kategori Discord Berbasis Path Proyek**: Mengelompokkan channel sesi di Discord berdasarkan folder fisik proyek di PC (`▼ 📁 C:\dev\RobloxDev`, `▼ 📁 C:\dev\claude-remote`, dst.) dan membersihkan kategori lama `📁 Claude Remote`.
3. **Struktur Runtime Terisolasi `~/.crc/`**: Membagi runtime menjadi 4 subfolder rapi (`config/`, `data/`, `logs/`, `cache/`) agar bebas semrawut (*ngebala*), dengan pembeda otomatis mode PROD vs DEV (`.crc-dev/`).
4. **State Cache `data/channels.json`**: Tracking lookup $O(1)$ pemetaan Channel Discord $\leftrightarrow$ Sesi Claude di disk lokal.
5. **Auto-Sync Berkala 1 Menit (60 Detik)**: Sinkronisasi otomatis dengan *diff-check* lokal (0 pemanggilan Discord API jika tidak ada perubahan sesi) dan safety lock saat Claude sedang aktif.

---

## 🏛️ Arsitektur Direktori Runtime

### 1. Struktur Folder Bersih `~/.crc/` (Mode PROD)
```text
~/.crc/
├── config/
│   ├── credentials.json         # Token Discord & Owner ID
│   └── settings.json            # Preferensi AI (Model, Effort, Timeout, Verbosity, Followup)
├── data/
│   ├── channels.json            # Mapping Category & Channel Discord <-> Sesi Claude PC
│   └── daemon.json              # State daemon (PID bot, PID tray, status service)
├── logs/
│   └── crc.log                  # File output log live
└── cache/
    └── attachments/             # File media sementara dari Discord
```

### 2. Mode DEV (Lokal Repo)
Saat dijalankan di folder source code git (`C:\dev\claude-remote`):
- Runtime dialihkan ke `.crc-dev/` (atau fallback `.env` / `settings.json` lokal) agar tidak mengganggu instalasi global production pengguna.

---

## 📄 Skema `data/channels.json`
```json
{
  "version": 1,
  "updatedAt": 1729945000000,
  "categories": {
    "C:\\dev\\RobloxDev": {
      "categoryId": "1564195517691338813",
      "categoryName": "📁 C:\\dev\\RobloxDev",
      "guildId": "1036530954178678844"
    }
  },
  "channels": {
    "1564197924760457226": {
      "sessionId": "945f70c9-ec30-4524-acdd-315def414491",
      "sessionTitle": "Layout dua panel QuestHistoryGui",
      "projectFolder": "C:\\dev\\RobloxDev",
      "channelName": "layout-dua-panel-questhistorygui-4491",
      "categoryId": "1564195517691338813",
      "guildId": "1036530954178678844",
      "createdAt": 1729940000000,
      "lastActiveAt": 1729945000000
    }
  }
}
```

---

## 📱 Visualisasi Kategori Discord Baru
```text
▼ 📁 C:\dev\RobloxDev
  # layout-dua-panel-questhistorygui-4491
  # analisis-ws-itemmodels-11c9
  # penyesuaian-ukuran-backdoor-d521

▼ 📁 C:\dev\claude-remote
  # tes-bot-discord-06a4
  # pembuatan-video-remotion-0172
```

---

## 🎨 Antarmuka CLI & TUI Interaktif Mewah

### 1. Dashboard Menu Interaktif (`crc` / `crc menu`)
```text
╭────────────────────────────────────────────────────────────╮
│  🤖 CLAUDE REMOTE CONTROL (CRC) v1.0.0                     │
│  Status: 🟢 AKTIF (Tray PID: 30460)  ·  Sesi: RobloxDev    │
╰────────────────────────────────────────────────────────────╯

  Gunakan panah ↑ / ↓ lalu tekan Enter:

  ❯ 🚀 Kontrol Service      (Start / Stop / Restart / Tray)
  ❯ 📁 Kelola Channel       (Sync Sesi ke Discord / Clear)
  ❯ 🔑 Setup Kredensial     (Token Bot, Owner ID, Invite Link)
  ❯ ⚙️ Setelan Sistem AI    (Model, Effort, Timeout, Follow-up)
  ❯ 💬 Chat Terminal        (Kirim prompt langsung di CLI)
  ❯ 📜 Pantau Live Logs     (Streaming realtime)
  ❯ 🚪 Keluar
```

### 2. Setup Wizard Interaktif (`crc setup` / `crc discord setup`)
```text
╭────────────────────────────────────────────────────────────╮
│  ✨ CLAUDE REMOTE CONTROL — SETUP WIZARD                   │
╰────────────────────────────────────────────────────────────╯

◇ Masukkan Discord Bot Token:
│  ••••••••••••••••••••••••••••••••••••••••••••••••••
⠋ Menghubungkan ke Discord API...
✔ Token Valid! Terhubung ke: God Wanglin#6033 (ID: 1545493402173579275)

◇ Masukkan User ID Owner:
│  1036530575948927018
✔ Owner Terdaftar: @godwanglin

◇ Pilihan Mode Eksekusi Awal:
│  ● Jalankan di System Tray (Taskbar Windows)  (Recommended)
│  ○ Jalankan di Terminal
│  ○ Selesai (Nanti saja)

✔ Setup Selesai!
🔗 Link Invite Bot ke Server:
https://discord.com/oauth2/authorize?client_id=1545493402173579275&permissions=8&scope=bot%20applications.commands
```

---

## 🔄 Mesin Auto-Sync 1 Menit (60 Detik)
1. **Loop Timer:** Dijalankan setiap 60 detik menggunakan sequential timer (`setTimeout` setelah sync selesai).
2. **Diff-Check Lokal Pertama:**
   - Membaca daftar sesi proyek di `.claude/projects/` via `getSidebarProjectGroups()`.
   - Membandingkan daftar sesi di disk dengan `channels.json`.
   - **Jika tidak ada sesi baru atau sesi yang dihapus:** Loop berhenti seketika (**0 panggilan Discord API**).
3. **Jika ada perubahan:**
   - Pastikan kategori `📁 <projectFolder>` ada untuk proyek tersebut.
   - Buat channel baru dengan throttle 3 channel/detik.
   - Bersihkan channel yang sesinya telah dihapus di disk.
   - Perbarui `channels.json`.
4. **Safety Lock:** Auto-sync otomatis ditunda jika ada runner Claude yang sedang aktif memproses prompt.

---

## 🛠️ Komponen File yang Akan Dibuat/Dimodifikasi

1. **`package.json` [MODIFY]**:
   - Tambahkan dependensi `@clack/prompts` untuk engine TUI modern.
2. **`src/runtime-paths.ts` [NEW]**:
   - Resolusi path cerdas Dev (`.crc-dev/`) vs Prod (`~/.crc/`).
   - Helper pembuatan struktur folder otomatis (`config/`, `data/`, `logs/`, `cache/`).
3. **`src/channels-store.ts` [NEW]**:
   - Manajemen `channels.json` (baca, tulis atomik, caching $O(1)$).
4. **`src/channel-manager.ts` [MODIFY]**:
   - Ubah sinkronisasi menjadi Kategori per-Path Proyek (`📁 C:\dev\...`).
   - Otomatis bersihkan kategori lama `📁 Claude Remote` saat pertama kali sinkronisasi.
   - Simpan mapping ke `channels-store.ts`.
5. **`src/config.ts` [MODIFY]**:
   - Membaca kredensial dari `config/credentials.json`, fallback ke `.env`.
   - Helper validasi token & fetch bot info via Discord REST API.
6. **`src/settings-manager.ts` [MODIFY]**:
   - Mengarahkan `settings.json` ke direktori `config/settings.json`.
7. **`src/daemon.ts` [MODIFY]**:
   - Mengarahkan file log dan daemon state ke `logs/crc.log` dan `data/daemon.json`.
8. **`src/tui-wizard.ts` [NEW]**:
   - Implementasi TUI Dashboard interaktif dan Setup Wizard menggunakan `@clack/prompts`.
9. **`src/bot.ts` [MODIFY]**:
   - Tambahkan auto-sync 60 detik dengan safety lock runner aktif.
   - Lookup channel menggunakan `channels-store.ts`.
10. **`bin/crc.js` [MODIFY]**:
    - Tampilkan TUI Dashboard interaktif saat dipanggil tanpa argumen (`crc`).
    - Tambahkan handler `crc setup`, `crc discord token`, `owner`, `status`, `invite`.
    - Token guard card jika dijalankan tanpa token.

---

## 🧪 Rencana Verifikasi

### 1. Verifikasi Kompilasi & Dependensi:
- Pasang `@clack/prompts`: `npm i @clack/prompts`.
- Kompilasi: `npm run build` sukses code 0.

### 2. Verifikasi TUI Interactive:
- Jalankan `node bin/crc.js setup` dan uji interaksi keyboard, masking input token, spinner validasi Discord API, dan hasil invite link.
- Jalankan `node bin/crc.js` (tanpa argumen) dan uji navigasi menu dashboard.

### 3. Verifikasi Sinkronisasi Kategori Discord:
- Jalankan `crc channel sync`:
  - Kategori lama `📁 Claude Remote` terhapus bersih.
  - Kategori baru muncul per path proyek: `▼ 📁 C:\dev\RobloxDev`, `▼ 📁 C:\dev\claude-remote`.
  - Channel sesi terkelompok rapi di bawah kategori proyek masing-masing.
  - File `~/.crc/data/channels.json` (atau `.crc-dev/`) terisi data akurat.

### 4. Verifikasi Auto-Sync 60 Detik & Multi-Threading Chat:
- Pantau log `crc logs -f` untuk memastikan auto-sync berjalan setiap 60 detik tanpa spamming Discord API.
- Kirim pesan di salah satu channel dan pastikan multi-threading Claude runner tetap merespons dengan cepat dan akurat.
