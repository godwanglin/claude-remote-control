

📋 Ringkasan Rencana Sistem Baru

📁 Kategori Discord Berbasis Path Proyek

1 Folder Proyek di PC = 1 Kategori Discord.
Format: ▼ 📁 C:\dev\RobloxDev 
→
→ berisi tab channel sesi proyek tersebut.

🗂️ Struktur Bersih ~/.crc/ (Bebas Semrawut)

config/ : Token bot & Owner ID (credentials.json), setelan AI (settings.json).
data/ : Mapping channel 
↔
↔ sesi (channels.json), status PID (daemon.json).
logs/ : File output bot (crc.log).
cache/ : File sementara lampiran gambar & audio.

🔄 Mode Dev vs Prod

Dev (Lokal Repo): Menggunakan folder lokal proyek (C:/dev/claude-remote/.crc-dev).
Prod (Global npm): Menggunakan direktori ~/.crc/.

⚡ CLI Onboarding (crc discord)

Token Kosong: Muncul kartu panduan ramah (anti-crash).
crc discord token <token> : Simpan token & validasi ke Discord API.
crc discord owner <id> : Kunci hak akses owner bot.
crc discord status : Cek kesehatan koneksi bot & izin server.
crc discord invite : Buatkan link invite bot sekali klik.


~/.crc/
├── config/                      # ⚙️ Semua Konfigurasi Pengguna (Aman & Gampang Dibackup)
│   ├── credentials.json         # Token Discord & Owner ID (Bisa terkunci/privat)
│   └── settings.json            # Preferensi AI (Model, Effort, Timeout, Followup, Verbosity)
│
├── data/ (atau state/)          # 💾 Data Runtime & Mapping Dinamis
│   ├── channels.json            # Mapping Channel Discord <-> Sesi Claude PC
│   └── daemon.json              # Status proses background (PID bot, PID tray, uptime)
│
├── logs/                        # 📜 File Pencatatan & Debugging
│   ├── crc.log                  # Log live bot
│   └── (arsip log lama)         # Otomatis rapi di satu tempat
│
└── cache/                       # 🗄️ File Sementara (Bisa Dihapus Kapan Saja)
    └── attachments/             # Download file gambar & audio dari Discord


## 📱 Visualisasi Tampilannya di Discord Nanti:

▼ 📁 C:\dev\RobloxDev
  # layout-dua-panel-questhistorygui-4491
  # analisis-ws-itemmodels-11c9
  # penyesuaian-ukuran-backdoor-d521

▼ 📁 C:\dev\claude-remote
  # tes-bot-discord-06a4
  # pembuatan-video-remotion-0172