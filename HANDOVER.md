# Hand-On Guide: AI Asisten SOP PLTA Sipansihaporas

Dokumen ini adalah panduan teknis supaya kamu bisa melanjutkan kerja di proyek ini dari device apa pun — HP (Termux), laptop, atau komputer kantor — tanpa perlu tanya ulang dari nol.

Untuk **konteks keputusan & histori proyek** (kenapa pilih Voyage, kenapa Gemini, hasil uji retrieval, dst), baca `Progress_AI_Asisten_SOP_PLTA_Sipansihaporas-2.md` di project knowledge. Dokumen ini fokus ke **cara kerja teknis**, bukan histori keputusan.

---

## 1. GAMBARAN ARSITEKTUR

```
Operator bertanya (browser)
        |
        v
  Frontend chat (public/index.html)
        |
        v  POST /chat
  Backend Express (server.js)
        |
        |--> Voyage AI (embed pertanyaan)
        |--> Supabase (match_chunks -> retrieval)
        |--> Google Gemini (generate jawaban)
        |--> Supabase (simpan riwayat chat)
        |
        v
  Jawaban + rujukan sumber -> tampil di frontend


Admin kelola data (browser)
        |
        v
  Frontend admin (public/admin.html)
        |
        v  /admin/api/*
  Backend Express (admin_routes.js)
        |
        |--> Voyage AI (embed teks IK baru)
        |--> Supabase (CRUD documents & chunks)
        |--> Supabase Storage (upload foto langkah)
```

**Satu backend Express (`server.js`) melayani semuanya** — chat operator, admin, dan static frontend — jalan di 1 proses, 1 port (`3000`).

---

## 2. TECH STACK

| Bagian | Teknologi | Kenapa |
|---|---|---|
| Database | Supabase (PostgreSQL + pgvector) | Gratis, sudah termasuk Storage untuk foto |
| Embedding | Voyage AI (`voyage-4-lite`, 1024 dim) | 200 juta token gratis permanen, tanpa kartu kredit |
| Generation (jawaban AI) | Google Gemini (`gemini-3.5-flash-lite`) | Free tier permanen, tanpa kartu kredit |
| Backend | Node.js + Express | Ringan, jalan lancar di Termux (HP) maupun laptop |
| Frontend | HTML + CSS + JS polos (tanpa framework) | Tidak butuh tooling build, gampang dijalankan di device manapun |

---

## 3. SEMUA FILE PROYEK

```
sop-plta/
├── server.js                # Backend utama: endpoint /chat + serve frontend
├── admin_routes.js          # Endpoint admin: CRUD dokumen/chunk + upload foto
├── system_prompt.js         # Instruksi AI (dipakai server.js)
├── system_prompt.txt        # Versi dokumentasi system prompt (untuk dibaca manusia)
├── generate_embeddings.js   # Script one-off: generate embedding utk chunk lama (sudah tidak perlu dipakai lagi kecuali re-index massal)
├── test_retrieval.js        # Script uji akurasi retrieval
├── supabase_schema.sql      # Skema database (referensi, sudah diterapkan ke Supabase)
├── package.json             # Daftar dependency Node.js
├── .env                     # RAHASIA — API key & password (JANGAN pernah di-share/commit)
├── .env.example             # Template .env (aman di-share, tidak ada key asli)
└── public/
    ├── index.html            # Frontend chat operator
    └── admin.html             # Frontend admin (CRUD IK)
```

---

## 4. KREDENSIAL (di file `.env`)

| Variable | Untuk apa | Cara dapat kalau perlu buat baru |
|---|---|---|
| `VOYAGE_API_KEY` | Embedding | dashboard.voyageai.com → API Keys |
| `GEMINI_API_KEY` | Generate jawaban AI | aistudio.google.com → Get API key |
| `SUPABASE_URL` | Koneksi database | Sudah tetap: `https://tjnwgoxcoqdsnllcnhgh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Koneksi database (akses penuh) | Dashboard Supabase project → Settings → API → `service_role` key |
| `ADMIN_PASSWORD` | Login halaman `/admin` | Kamu tentukan sendiri |

**PENTING:** file `.env` **tidak boleh diunggah ke chat, GitHub (public repo), atau dibagikan ke siapa pun.** Simpan isinya (copy-paste manual) di tempat aman seperti catatan terenkripsi/password manager, supaya kalau ganti device kamu tinggal paste ulang, bukan generate key baru terus-menerus.

---

## 5. CARA JALANKAN DI DEVICE BARU (device apapun, bukan cuma Termux)

### A. Prasyarat: Node.js harus terinstall
- **Termux (HP):** `pkg install nodejs`
- **Laptop/PC (Windows/Mac/Linux):** download dari nodejs.org, atau pakai package manager (`brew install node`, dsb)

Cek dengan: `node -v` dan `npm -v`

### B. Dapatkan kode proyek
Idealnya pakai Git (lihat bagian 6 di bawah). Kalau belum sempat setup Git, cara manual: pindahkan semua file lewat cara apa pun (USB, cloud storage, dsb) ke folder kerja.

### C. Setup environment
```
cd nama-folder-project
npm install
```
Buat file `.env` (copy dari `.env.example`, isi dengan kredensial asli — lihat bagian 4).

### D. Jalankan
```
node server.js
```
Buka browser ke `http://localhost:3000` (chat operator) atau `http://localhost:3000/admin` (admin).

**Khusus Termux:** jalankan di background supaya terminal tetap bisa dipakai:
```
nohup node server.js > server.log 2>&1 &
```
Matikan dengan: `pkill -f "node server.js"`. Cek log: `cat server.log`.

**⚠️ Khusus Termux — JANGAN taruh folder project di `/storage/emulated/0/...` (external storage).** Filesystem itu tidak mendukung symlink, `npm install` akan gagal (`EACCES symlink`). Selalu kerja di folder internal Termux, misal `~/sop-plta`.

---

## 6. REKOMENDASI: PAKAI GIT + GITHUB UNTUK PINDAH DEVICE

Sejauh ini kode dipindah manual (download → cp dari folder Download). Ini akan makin merepotkan seiring proyek membesar. Solusi standar industri: simpan kode di **GitHub** (gratis untuk repo privat), lalu tiap device tinggal `git pull`/`git clone`.

**Setup sekali di device manapun (Termux termasuk bisa):**
```
pkg install git        # (di Termux; di device lain biasanya sudah ada)
cd ~/sop-plta
git init
```

Buat file `.gitignore` (supaya `.env` dan `node_modules` tidak ikut ter-upload):
```
node_modules/
.env
server.log
```

Buat repo baru di **github.com** (gratis, bisa private), lalu:
```
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git add .
git commit -m "Initial commit"
git branch -M main
git push -u origin main
```

**Di device lain nanti, tinggal:**
```
git clone https://github.com/USERNAME/NAMA-REPO.git
cd NAMA-REPO
npm install
# buat .env manual (isi dari catatan aman kamu, karena .env sengaja tidak ikut ter-upload)
node server.js
```

Ini menyelesaikan masalah "ganti-ganti device" secara permanen — kode selalu sinkron di GitHub, cuma `.env` yang perlu kamu isi ulang manual di device baru (memang sengaja begitu, demi keamanan).

Kalau kamu mau, saya bisa bantu jalankan setup Git ini langkah-demi-langkah kapan saja.

---

## 7. PERINTAH-PERINTAH PENTING (CHEAT SHEET)

| Kebutuhan | Command |
|---|---|
| Install semua dependency | `npm install` |
| Jalankan server (biasa) | `node server.js` |
| Jalankan server (background, Termux) | `nohup node server.js > server.log 2>&1 &` |
| Matikan server (Termux) | `pkill -f "node server.js"` |
| Lihat log server | `cat server.log` |
| Uji retrieval manual | `node test_retrieval.js "pertanyaan kamu"` |
| Re-generate semua embedding (jarang perlu) | `node generate_embeddings.js` |
| Test endpoint chat lewat terminal | `curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"question":"..."}'` |

---

## 8. MASALAH YANG PERNAH MUNCUL & SOLUSINYA (supaya tidak berulang)

| Gejala | Penyebab | Solusi |
|---|---|---|
| `npm install` gagal `EACCES symlink` | Project ada di external storage Termux | Pindah ke folder internal (`~/`) |
| Voyage API error 429 | Akun belum ada payment method (dibatasi 3 request/menit) | Sudah ditangani otomatis di kode (retry + delay), tapi proses jadi lambat — ini normal |
| Gemini API error "model no longer available" | Google sering ganti nama model | Cek model stabil terbaru di ai.google.dev, update `GEMINI_MODEL` di `server.js` |
| Jawaban AI menyebut dokumen yang kurang relevan | Retrieval similarity threshold terlalu longgar | Sudah diperbaiki (filter similarity ≥0.45, maks 3 context) — kalau muncul lagi, nilai ini bisa disesuaikan lebih lanjut |
| Server berhenti begitu terminal Termux ditutup | Proses tidak di-background | Selalu pakai `nohup ... &` |

---

## 9. STATUS PROYEK SAAT INI (ringkas — detail lengkap di file progress)

- Database + 5 IK + 53 chunk + embedding: **selesai, live di Supabase**
- Backend chat (`/chat`): **selesai, teruji**
- Frontend chat operator: **selesai, teruji di browser HP**
- Backend admin (CRUD + upload foto): **baru selesai dibangun, belum diuji end-to-end**
- Frontend admin: **baru selesai dibangun, belum diuji end-to-end**
- Migrasi Supabase ke project terpisah (saat ini masih campur dgn proyek lain): **ditunda, bukan prioritas**
- Git/GitHub setup: **belum dimulai** (rekomendasi di bagian 6)

**Langkah selanjutnya yang paling masuk akal:** uji halaman admin end-to-end (buat 1 IK baru lengkap dengan foto, pastikan muncul benar saat operator bertanya lewat chat).
