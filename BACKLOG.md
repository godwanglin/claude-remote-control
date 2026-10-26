# Claude Remote Control (CRC) - Project Backlog

Dokumen ini berisi daftar ide fitur, perbaikan arsitektur, dan rencana pengembangan di masa mendatang.

---

## 📌 Backlog 01: Universal Auth Resolver & Cross-Platform Runtime Detection

### Ringkasan Masalah & Tujuan
Saat ini `crc` memprioritaskan deteksi kredensial gateway Claude Desktop di Windows (`%LOCALAPPDATA%\Claude-3p`). Ke depannya, `crc` ditargetkan agar dapat mendeteksi runtime `~/.claude` di sistem operasi mana pun (Windows, Linux, macOS), mendukung login resmi Anthropic OAuth maupun Gateway, serta memberikan peringatan terminal yang ramah jika mesin belum terautentikasi.

---

### 1. Hierarki Deteksi Autentikasi (Priority Order)

Saat perintah `crc` dijalankan, sistem akan mengecek autentikasi dengan urutan berikut:

1. **Prioritas 1: Environment Variables**
   - Cek `ANTHROPIC_AUTH_TOKEN` atau `ANTHROPIC_API_KEY` di file `.env` atau `process.env`.
2. **Prioritas 2: Claude Desktop Gateway (`host-creds-*.json`)**
   - Windows: `%LOCALAPPDATA%\Claude-3p\host-creds-*.json`
   - macOS: `~/Library/Application Support/Claude-3p/host-creds-*.json`
   - Linux: `~/.config/Claude-3p/host-creds-*.json`
3. **Prioritas 3: Official Claude Code OAuth (`~/.claude`)**
   - Membaca session token resmi dari `~/.claude.json` atau `~/.claude/` di direktori home user (`os.homedir()`).

---

### 2. Standalone Binary (`bin/claude.exe`)

- **Prioritas Lokasi Binary:**
  1. Cek folder lokal proyek: `c:\dev\claude-remote\bin\claude.exe` (atau `bin/claude` di Linux/macOS).
  2. Jika ada, gunakan binary lokal tersebut agar sepenuhnya *standalone*.
  3. Jika tidak ada, gunakan binary bawaan sistem di Windows / PATH.
- **Opsi Isolasi Penuh (Portable Mode):**
  - Menyediakan opsi untuk mengarahkan `USERPROFILE` / `HOME` / `CLAUDE_CONFIG_DIR` child process ke dalam folder proyek jika ingin runtime chat benar-benar mandiri tanpa menyentuh `~/.claude` bawaan Windows.

---

### 3. Graceful Warning (Bila Autentikasi Tidak Ditemukan)

Jika tidak ditemukan kredensial dari ketiga sumber di atas, program **tidak boleh crash**, melainkan menampilkan kartu peringatan terminal yang edukatif:

```text
┌── PERINGATAN RUNTIME CLAUDE ───────────────────────────────┐
│                                                            │
│  Belum ditemukan sesi autentikasi Claude di komputer ini.  │
│                                                            │
│  Solusi:                                                   │
│  1. Buka aplikasi Claude Desktop dan pastikan sudah login  │
│  2. ATAU jalankan perintah: claude login                   │
│  3. ATAU masukkan ANTHROPIC_AUTH_TOKEN ke file .env        │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

*Status: **Planned / Backlog***  
*Dicatat pada: 26 Oktober 2026*

---

## 📌 Feature 02: Universal Attachments Pipeline (`.attachments()`)

### Ringkasan Fitur
Menambahkan method `.attachments()` pada `ClaudeHeadless` yang mampu menerima berbagai jenis lampiran (gambar, dokumen, source code, data log) baik berupa URL Discord, path file lokal, maupun Buffer.

### Spesifikasi:
1. **Penyimpanan Cache Lintas Platform**:
   - Disimpan di `path.join(os.homedir(), '.claude', 'cache', 'attachments')`.
   - Bekerja otomatis di Windows, macOS, dan Linux.
2. **Kompabilitas File**:
   - Gambar (`.png`, `.jpg`, `.webp`) dibaca melalui Vision model Claude.
   - File teks/kode/data (`.ts`, `.py`, `.json`, `.csv`, `.log`) dibaca melalui file reader tool Claude.
3. **Format Prompt Netral**:
   - Jika pengguna menyertakan teks: `[Lampiran: <path>]\n\n<pesan>`
   - Jika pengguna **tidak** menyertakan teks: hanya dikirim `[Lampiran: <path>]` murni tanpa tambahan teks otomatis agar Claude tidak terbebani waktu berpikir (*thinking time*).

*Status: **✔ Selesai (Completed)***  
*Diimplementasikan pada: 26 Oktober 2026*

---

## 📌 Feature 03: Automatic Media Delivery Pipeline (Claude -> Discord)

### Ringkasan Fitur
Mendeteksi dan secara otomatis mengirimkan file media (**gambar** dan **suara/audio**) yang dihasilkan atau direferensikan oleh Claude ke chat Discord, sambil secara ketat mengabaikan file biasa (kode, skrip, data, dokumen).

### Spesifikasi:
1. **Verifikasi Fisik di Disk (`media-detector.ts`)**:
   - Mendeteksi ekstensi Gambar: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.
   - Mendeteksi ekstensi Audio: `.mp3`, `.wav`, `.ogg`, `.m4a`.
   - Verifikasi ketat: `fs.existsSync(resolvedPath)` dan `fs.statSync(resolvedPath).isFile()`.
   - File yang tidak ada di disk (path fiktif / error skrip) otomatis diabaikan.
   - Ukuran dicek: `size > 0` dan `size <= 25MB` (Discord bot file upload limit).
2. **Eksklusi File Non-Media**:
   - File kode (`.ts`, `.py`, `.js`), teks/data (`.json`, `.txt`, `.csv`) tidak dikirim ke Discord, pengguna cukup melihatnya di disk atau Claude Desktop.
3. **Pengiriman Cerdas ke Discord**:
   - Dicoba dilampirkan langsung ke pesan balasan (`replyMessage.edit({ content, files, components: [] })`) agar gambar dan audio player tampil menyatu.
   - Fallback otomatis: jika edit pesan dengan lampiran ditolak Discord API, bot mengedit teks lalu mengirim attachment terpisah via `message.reply({ files })`.

*Status: **✔ Selesai (Completed)***  
*Diimplementasikan pada: 26 Oktober 2026*

---

## 📌 Feature 04: Follow-up Message Queue & Steering Handling

### Ringkasan Fitur
Menangani pesan baru saat Claude sedang aktif memproses task sebelumnya, dengan 3 mode (`default`, `queue`, `steer`), tombol batalkan/interupsi, dan persistensi di `settings.json`.

*Status: **✔ Selesai (Completed)***  
*Diimplementasikan pada: 26 Oktober 2026*

---

## 📌 Feature 05: Category & Channel Sync per Claude Session (Tabs in Discord)

### Ringkasan Pendekatan
Setiap text channel di Discord merepresentasikan satu tab / sesi Claude di PC. Pengguna cukup memilih channel untuk langsung berinteraksi dengan sesi tersebut tanpa perlu ganti sesi manual (`/session`).

### Spesifikasi Arsitektur:
1. **Kategori Khusus Discord:**
   - Bot otomatis membuat dan memantau Kategori Channel (misal `📁 Claude Remote`).
2. **Channel Mapping & Metadata Custom:**
   - Nama channel disanitasi dari judul sesi Claude (`Layout GUI` -> `#layout-gui`).
   - `channel.topic` menyimpan metadata identitas resmi: `SessionID: <uuid>`.
   - Bot menyimpan memory cache / JSON map lokal untuk lookup $O(1)$.
3. **Sinkronisasi 2-Arah (Diff Sync):**
   - **Startup & Manual (`/sync` / `crc sync-channel`):**
     - Sesi baru di PC: Dibuatkan channel baru dengan throttling halus (3 channel per 1 detik) agar bebas rate-limit Discord.
     - Sesi yang sudah dihapus di PC: Channel terkait di Discord otomatis dihapus (`channel.delete()`).
     - Sesi yang sudah ada: Diabaikan tanpa pemanggilan API berulang (startup instan).
   - **Safety Guards:**
     - Bot hanya menghapus channel di dalam kategori khusus yang memiliki metadata `SessionID`.
     - Jika pembacaan sesi Claude gagal / bernilai 0 sesi, proses pembersihan dibatalkan untuk mencegah salah hapus massal.
     - Penanganan batas 50 channel per kategori Discord.
4. **Isolasi Penuh (Channel Isolation):**
   - Bot hanya mendengarkan dan merespons prompt yang dikirim di dalam kategori channel tersebut.
   - Pesan di channel luar kategori diabaikan sepenuhnya agar server tetap bersih dan privat.

*Status: **✔ Selesai (Completed)***  
*Diimplementasikan pada: 26 Oktober 2026*

---

## 📌 Feature 06: Multi-Threading Engine (Session-Isolated Runners)

### Ringkasan Pendekatan
Mengubah arsitektur single-thread bot menjadi arsitektur multi-threaded / multi-process. Setiap sesi Claude berjalan di process OS (`claude.exe`) terpisah secara on-demand, sehingga beberapa channel Discord dapat mengeksekusi task Claude secara paralel tanpa saling memblokir.

### Spesifikasi Arsitektur:
1. **Per-Session Runner Map (`Map<string, ClaudeHeadless>`):**
   - Menggantikan variabel runner tunggal global dengan `activeRunners` berbasis `sessionId`.
   - Tiap sesi memiliki siklus hidup independen (PID Windows terpisah).
2. **Per-Session Queue & Follow-up Handlers:**
   - Antrean pesan diisolasi per-sesi: `sessionQueues.set(sessionId, [...])`.
   - Perintah di Channel A tidak akan memblokir atau mengantrekan perintah di Channel B.
   - Mengirim beberapa pesan di channel yang sama tetap aman dengan sistem antrean/interupsi.
3. **Session-Scoped Cancellation (`/stop` & Tombol Batalkan):**
   - Menekan tombol `[⏹️ Batalkan]` atau menjalankan `/stop` hanya membatalkan child process untuk sesi yang bersangkutan.
   - Sesi-sesi lain yang sedang aktif berjalan paralel tetap berjalan tanpa gangguan.

*Status: **✔ Selesai (Completed)***  
*Diimplementasikan pada: 26 Oktober 2026*

