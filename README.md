# Claude Remote Control (CRC)

> **Bridge Remote Control & Discord Bot untuk Anthropic Claude Desktop / Claude Code di Windows.**
> Menggunakan arsitektur **Headless Native Runner (Anti-Timeout)** yang tersinkronisasi 100% langsung dengan tab proyek Claude Desktop.

---

## 🌟 Fitur Utama

- **100% Headless Native Runner (Anti-Timeout)**: Mengeksekusi giliran Claude Code secara deterministik dengan streaming NDJSON, bebas dari masalah socket timeout atau interactive TUI hang.
- **Discord Tabs (Category & Channel Per-Session Sync)**: Otomatis membuat kategori **`📁 Claude Remote`** di mana setiap channel mewakili satu tab/sesi Claude di PC. Mengobrol di channel tertentu otomatis terhubung ke sesi tersebut tanpa perlu ganti sesi manual!
- **Multi-Threading Engine (Paralel Execution)**: Menjalankan child process OS Claude (`claude.exe`) terpisah untuk tiap sesi. Beberapa channel Discord dapat bekerja secara paralel dan streaming output bersamaan tanpa saling memblokir.
- **Total Channel Isolation**: Bot hanya merespons pesan yang dikirim di dalam kategori **`📁 Claude Remote`**, menjaga channel server lainnya (seperti `#general`, dll.) tetap bersih dan privat.
- **Follow-up Message Handling (Queue & Steer)**: Menangani pesan susulan saat Claude sedang sibuk dengan 3 mode: *Tanya Dulu* (tombol interaktif), *Otomatis Antre* (queue), atau *Kirim Sekarang* (interupsi langsung).
- **Windows System Tray**: Bisa berjalan diam-diam di background di taskbar Windows (`crc tray`) dengan menu kontrol klik kanan (Open Logs, Restart Bot, Exit).
- **Auto-Pipeline Pengiriman Media**: File gambar (`.png`, `.jpg`, `.webp`) atau audio (`.mp3`, `.wav`) yang dihasilkan Claude otomatis dideteksi dan dilampirkan langsung ke Discord.
- **Live Verbose Logging**: Pantau aktivitas realtime Discord bot, tool use, balasan teks Claude, dan pemakaian token via terminal (`crc logs -f --verbose`).
- **Owner Security Whitelist & Auto-Claim**: Bot terkunci khusus untuk akun Discord Owner, dengan fitur *Auto-Claim* otomatis pada pesan pertama jika Owner ID belum disetel.

---

## 🚀 Panduan Instalasi & Penggunaan

### Cara 1: Install Global via NPM (Direkomendasikan)
```bash
npm install -g @devnuby/crc
```
Setelah terpasang, perintah `crc` langsung dapat digunakan di terminal mana saja:
```bash
crc            # Buka Dashboard TUI interaktif & Setup Wizard
crc tray       # Jalankan di background System Tray Windows
crc -v         # Cek versi terpasang
```

---

### Cara 2: Kloning Repositori & Jalankan dari Source
```bash
git clone https://github.com/godwanglin/claude-remote-control.git
cd claude-remote-control
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
  npm run crc                # Buka Dashboard TUI interaktif
  npm run crc -- --verbose   # Jalankan dengan live verbose logs
  ```

* **Mode Background / System Tray (Taskbar Windows)**:
  ```bash
  node bin/crc.js tray   # Icon Claude akan muncul di taskbar kanan bawah
  ```

---

## ⌨️ Perintah CLI (`crc`)

| Perintah | Deskripsi |
| :--- | :--- |
| `crc` | Buka Dashboard TUI Interaktif (atau jalankan bot jika belum disetel) |
| `crc -v`, `crc --version` | Tampilkan versi CRC saat ini |
| `crc -h`, `crc --help` | Tampilkan panduan bantuan CLI terpusat |
| `crc service start [--verbose]` | Jalankan bot langsung di terminal (foreground) |
| `crc tray` | Jalankan bot di background dengan icon System Tray Windows |
| `crc stop` | Matikan bot background / system tray yang sedang berjalan |
| `crc restart` | Muat ulang background bot / system tray |
| `crc status` | Cek status daemon bot (PID, uptime) & kartu sesi Claude aktif |
| `crc logs -f` | Pantau log bot secara realtime (streaming) |
| `crc logs -f --verbose` | Pantau log bot realtime dengan live detail verbose (tool use, respon Claude) |
| `crc logs -c` | Bersihkan isi file log (`.daemon/crc.log`) |
| `crc logs --open` | Buka file log langsung di Notepad |
| `crc discord channel sync` | Sinkronisasi tab sesi Claude ke channel Discord (3 channel / detik) |
| `crc discord channel clear` | Hapus semua text channel di dalam kategori `📁 Claude Remote` |
| `crc chat "<prompt>"` | Kirim prompt ke Claude dan stream respons real-time langsung di terminal |
| `crc session list` | Tampilkan daftar sesi proyek aktif di terminal (tabel rapi) |
| `crc /teleport <id>` | Pindah kendali sesi aktif |
| `crc api [port]` | Jalankan server REST API lokal (default: port 3300) |

---

## 💬 Perintah Discord Bot

Dapat dipanggil via **Slash Command** (`/`) atau **Teks Biasa** (`!`/`/`):

* `/sync` (`!sync`) - Sinkronisasi kategori dan text channel Discord dengan sesi Claude di PC.
* `/stop` (`!stop`) - Hentikan paksa proses Claude yang sedang berjalan (mendukung stop sesi channel aktif atau stop semua).
* `/settings` (`!settings`) - Buka panel kontrol lengkap (Model, Izin, Verbosity, Effort Level, Timeout, Notifikasi, Mode Follow-up Pesan).
* `/sessions` (`!sessions`) - Tampilkan daftar sesi proyek Claude Desktop dengan dropdown menu interaktif untuk pindah sesi (*teleport*).
* `/teleport <no|id|auto>` - Pindah kendali bot ke nomor sesi atau ikuti tab desktop aktif secara otomatis.
* `/status` (`!status`) - Tampilkan kartu status sesi aktif, model AI, dan persentase penggunaan context window.
* `/model [1|2]` - Tampilkan atau ubah model AI sesi aktif (Opus 5.5 / Opus 4.6).
* `/compact [catatan]` - Ringkas riwayat obrolan sesi aktif untuk menghemat context tokens.
* `/clear` - Reset riwayat memori chat pada sesi aktif.
* `/permission [mode]` - Ubah izin Claude (`bypassPermissions`, `auto`, `plan`, `acceptEdits`, `manual`).
* `!ping` - Cek latency WebSocket bot Discord.

---

## 📄 Lisensi
ISC License.
