# Claude Remote Control (CRC)

> **Bridge Remote Control & Discord Bot untuk Anthropic Claude Desktop / Claude Code di Windows.**
> Menggunakan arsitektur **Headless Native Runner (Anti-Timeout)** yang tersinkronisasi 100% langsung dengan tab proyek Claude Desktop.

---

## 🌟 Fitur Utama

- **100% Headless Native Runner (Anti-Timeout)**: Mengeksekusi giliran Claude Code secara deterministik dengan streaming NDJSON, bebas dari masalah socket timeout atau interactive TUI hang.
- **Sinkronisasi 2-Arah Claude Desktop**: Sesi yang dijalankan lewat Discord atau CLI otomatis terupdate di sidebar Claude Desktop karena berbagi file riwayat sesi (`.jsonl`) yang sama.
- **Windows System Tray**: Bisa berjalan diam-diam di background di taskbar Windows (`crc tray`) dengan menu kontrol klik kanan (Open Logs, Restart Bot, Exit).
- **Auto-Pipeline Pengiriman Media**: File gambar (`.png`, `.jpg`, `.webp`) atau audio (`.mp3`, `.wav`) yang dihasilkan Claude otomatis dideteksi dan dilampirkan langsung ke Discord.
- **Multi-Session Teleportation**: Ganti kendali aktif ke sesi proyek mana saja secara instan lewat perintah `/teleport` atau dropdown `/sessions`.
- **Live Verbose Logging**: Pantau aktivitas realtime Discord bot, tool use, balasan teks Claude, dan pemakaian token via terminal (`crc logs -f -v`).
- **Owner Security Whitelist & Auto-Claim**: Bot terkunci khusus untuk akun Discord Owner, dengan fitur *Auto-Claim* otomatis pada pesan pertama jika Owner ID belum disetel.

---

## 🚀 Panduan Instalasi & Penggunaan

### 1. Kloning Repositori
```bash
git clone https://github.com/godwanglin/claude-remote-control.git
cd claude-remote-control
```

### 2. Pasang Dependensi & Build
```bash
npm install
npm run build
```

### 3. Konfigurasi Lingkungan (`.env`)
Salin file `.env.example` ke `.env`:
```bash
copy .env.example .env
```
Isi konfigurasi berikut:
```env
DISCORD_TOKEN=token_bot_discord_kamu
OWNER_ID=id_akun_discord_kamu   # (Opsional, otomatis di-claim saat pertama kali chat jika kosong)
```

### 4. Menjalankan Bot

* **Mode Terminal Interaktif (Foreground)**:
  ```bash
  npm run crc            # atau npx crc
  npm run crc -- -v      # jalankan dengan live verbose logs
  ```

* **Mode Background / System Tray (Taskbar Windows)**:
  ```bash
  node bin/crc.js tray   # Icon Claude akan muncul di taskbar kanan bawah
  ```

---

## ⌨️ Perintah CLI (`crc`)

| Perintah | Deskripsi |
| :--- | :--- |
| `crc` | Jalankan bot langsung di terminal (interaktif) |
| `crc -v` | Jalankan bot di terminal dengan live detail log (pesan masuk, tool use) |
| `crc tray` | Jalankan bot di background dengan icon System Tray Windows |
| `crc stop` | Matikan bot background / system tray yang sedang berjalan |
| `crc restart` | Muat ulang background bot / system tray |
| `crc status` | Cek status daemon bot (PID, uptime) & kartu sesi Claude aktif |
| `crc logs -f` | Pantau log bot secara realtime (streaming) |
| `crc logs -f -v` | Pantau log bot realtime dengan live detail verbose (tool use, respon Claude) |
| `crc logs -c` | Bersihkan isi file log (`.daemon/crc.log`) |
| `crc logs --open` | Buka file log langsung di Notepad |
| `crc chat "<prompt>"` | Kirim prompt ke Claude dan stream respons real-time langsung di terminal |
| `crc /sessions` | Tampilkan daftar sesi proyek aktif di terminal |
| `crc /teleport <id>` | Pindah kendali sesi aktif |

---

## 💬 Perintah Discord Bot

Dapat dipanggil via **Slash Command** (`/`) atau **Teks Biasa** (`!`/`/`):

* `/sessions` - Tampilkan daftar sesi proyek Claude Desktop dengan dropdown menu interaktif untuk pindah sesi (*teleport*).
* `/teleport <no|id|auto>` - Pindah kendali bot ke nomor sesi atau ikuti tab desktop aktif secara otomatis.
* `/status` - Tampilkan kartu status sesi aktif, model AI, dan persentase penggunaan context window.
* `/model [1|2]` - Tampilkan atau ubah model AI sesi aktif (Opus 5.5 / Opus 4.6).
* `/compact [catatan]` - Ringkas riwayat obrolan sesi aktif untuk menghemat context tokens.
* `/clear` - Reset riwayat memori chat pada sesi aktif.
* `/permission [mode]` - Ubah izin Claude (`bypassPermissions`, `auto`, `plan`, `acceptEdits`, `manual`).
* `!ping` - Cek latency bot Discord.

---

## 📄 Lisensi
ISC License.
