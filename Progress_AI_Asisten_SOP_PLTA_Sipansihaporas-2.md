# Progress: AI Asisten Operasi & Troubleshooting PLTA Sipansihaporas (RAG)

**Update per: 25 Juli 2026.** Ini melanjutkan progress sebelumnya (`Progress_AI_Asisten_SOP_PLTA_Sipansihaporas.md` dan `-1.md`). Dokumen itu mencatat tahap perencanaan & pipeline lokal (parsing, chunking, simulasi TF-IDF). Dokumen ini mencatat **tahap implementasi sungguhan**: database live, embedding, backend, dan frontend MVP sudah berjalan.

**Konteks kerja:** Malik mengerjakan ini dari HP (tanpa laptop), menggunakan **Termux** sebagai environment coding (Node.js). Semua pengambilan keputusan dilakukan lewat diskusi bertahap dengan AI, bukan langsung dieksekusi sepihak.

---

## 1. STATUS SAAT INI: MVP BERJALAN END-TO-END

Alur lengkap sudah berfungsi: operator bertanya → pertanyaan di-embed → retrieval dari Supabase → AI menyusun jawaban dengan rujukan sumber → tampil di frontend chat sederhana.

---

## 2. STRUKTUR DATABASE (Supabase, project ref: `tjnwgoxcoqdsnllcnhgh`)

Skema sudah diterapkan langsung ke Supabase (bukan cuma file `.sql`, sudah live). File referensi: `supabase_schema.sql`.

**Tabel `documents`** — metadata per IK:
- `nomor_ik`, `judul`, `unit` (default `'1'`), `lokasi` (kode `'SPH'`), `status_dokumen` (`resmi` / `percobaan_fixed`), `revisi`, `tanggal_revisi`, `metadata` (jsonb cadangan untuk field masa depan).
- 5 IK sudah ter-insert: IK-001 (Start-Up), IK-002/b.f-002 (Stop), IK-003 (Line Charging), IK-004 (Running Test Turbin), IK-005 (Free Governor, status `percobaan_fixed` — catatan: file FIXED terpisah belum tentu jadi sumber aktual, perlu dicek ulang isi kontennya sebelum go-live resmi).

**Tabel `chunks`** — potongan teks siap-embed:
- 53 chunk dari 5 dokumen (field: `chunk_id`, `document_id` FK, `source_doc`, `judul`, `section_type`, `label`, `text`, `embedding vector(1024)`, `metadata` jsonb).
- `section_type` PAKAI 4 NILAI NYATA (bukan 2 seperti draft awal): `ringkasan`, `referensi`, `prosedur`, `tindakan_akhir`. Constraint sudah disesuaikan.
- **Semua 53 chunk sudah punya embedding** (Voyage `voyage-4-lite`, 1024 dimensi, `input_type: document`).

**Tabel `chat_sessions`** dan **`chat_messages`** — sudah dibuat, dipakai backend untuk audit trail (`retrieved_chunk_ids` per jawaban AI). Belum ada fitur "AI membaca riwayat sesi sebelumnya" — baru sekadar disimpan.

**Function `match_chunks(query_embedding, match_lokasi, match_unit, match_count)`** — similarity search cosine, sudah dites akurat (lihat bagian 5).

---

## 3. MODEL AI YANG DIPAKAI & ALASANNYA

**Embedding: Voyage AI `voyage-4-lite`** (1024 dimensi, bukan OpenAI `text-embedding-3-small`/1536 seperti draft awal).
- Alasan pindah dari OpenAI: Malik tidak punya kartu kredit untuk isi billing OpenAI.
- Voyage dipilih karena ada 200 juta token gratis permanen tanpa kartu.
- Catatan teknis: akun tanpa payment method dibatasi **3 request/menit** oleh Voyage — script embedding & test retrieval sudah disesuaikan pakai batch kecil + delay ~22 detik antar batch + retry otomatis kalau kena 429.

**Generation (penyusun jawaban): Google Gemini `gemini-3.5-flash-lite`**
- Alasan: sama-sama menghindari masalah kartu kredit — Gemini API py free tier permanen tanpa kartu (beda dengan Anthropic/OpenAI API yang mensyaratkan billing).
- CATATAN PENTING: nama model Gemini sering berubah/deprecated (sempat pakai `gemini-2.5-flash`, ternyata sudah pensiun untuk user baru per Juli 2026). Kalau muncul error "model no longer available" di masa depan, cek nama model stabil terbaru di `ai.google.dev`, lalu update konstanta `GEMINI_MODEL` di `server.js`.

---

## 4. SYSTEM PROMPT (file: `system_prompt.js` / `system_prompt.txt`)

Prinsip yang disepakati (tidak berubah dari rencana awal):
1. Jawab HANYA dari context yang di-retrieve, tidak boleh mengarang.
2. Selalu sebut rujukan sumber (nomor IK + judul).
3. Jujur kalau tidak ada data relevan.
4. **Bahasa non-imperatif** — sudah diperkuat dengan aturan praktis + contoh salah/benar (jangan buka kalimat dengan kata kerja perintah seperti "Pastikan/Lakukan/Klik"; gunakan framing deskriptif seperti "sesuai IK..."). Ini berlaku untuk SEMUA jawaban, bukan cuma troubleshooting.
5. Untuk kondisi safety-critical/emergency, tetap arahkan ke prosedur emergency resmi/supervisor.
6. Dokumen berstatus `percobaan_fixed` tidak perlu disebutkan statusnya ke operator (transparansi internal saja).

Sudah diuji dengan beberapa pertanyaan nyata dan hasilnya baik: rujukan akurat, sintesis dari multi-dokumen berjalan baik (termasuk kasus ambigu antara IK-001 vs IK-003 untuk pertanyaan generik "sebelum PLTA beroperasi" — AI berhasil memisahkan jadi "langkah umum" vs "persiapan khusus line charging").

---

## 5. HASIL UJI RETRIEVAL (sebelum backend dibangun)

Diuji pakai `test_retrieval.js` dengan 5 pertanyaan contoh mewakili tiap IK. Hasil: 4/5 tepat sasaran langsung di top-1 (manual synchronizing, durasi line charging, quick stop, free governor). 1 pertanyaan generik ("sebelum PLTA beroperasi") sedikit ambigu di ranking similarity (IK-003 vs IK-001 berdekatan), tapi ini teratasi di lapisan AI generation (lihat bagian 4) karena AI menerima top-5 context sekaligus, bukan cuma top-1.

---

## 6. BACKEND (Node.js + Express)

File: `server.js`, `system_prompt.js`, `generate_embeddings.js`, `test_retrieval.js`, `package.json`.

**Endpoint utama: `POST /chat`**
- Body: `{ question, unit (default '1'), lokasi (default 'SPH'), session_id (opsional) }`
- Alur: embed pertanyaan (Voyage, `input_type: query`) → `match_chunks` (top-5) → susun prompt + context → Gemini generate → simpan ke `chat_messages` → response `{ session_id, answer, sources[] }`.

**Environment variables** (di `.env`, TIDAK di-commit/dikirim ke mana pun):
`VOYAGE_API_KEY`, `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

**Cara jalankan:** `node server.js` (biasanya dijalankan background di Termux: `nohup node server.js > server.log 2>&1 &`, lihat catatan Termux di bagian 8).

---

## 7. FRONTEND (MVP)

File: `public/index.html` — HTML+CSS+JS polos (tanpa framework/build tool), di-serve langsung oleh Express (`express.static`). Diakses lewat browser HP ke `http://localhost:3000`.

Desain: nuansa panel kontrol/HMI industrial (bukan chat bubble generik) — dark theme, aksen amber (mirip lampu indikator panel), rujukan sumber ditampilkan sebagai chip kecil di bawah tiap jawaban AI. Sengaja dipisah total dari backend supaya nanti mudah di-upgrade ke framework lain (React/Vue) tanpa mengubah `server.js`/endpoint sama sekali — ini keputusan sadar untuk scalability jangka panjang, terutama karena proyek ini berpotensi jadi karya inovasi PLN yang bisa dikembangkan lebih jauh kalau dapat dukungan resmi.

Fitur: chat teks, pemilih unit/lokasi manual (dropdown, saat ini cuma opsi Unit 1), tampilan rujukan sumber per jawaban.

---

## 8. CATATAN TEKNIS PENTING SEPUTAR TERMUX (supaya tidak mengulang troubleshooting yang sama)

- **Jangan taruh/jalankan project Node.js di folder external storage** (`/storage/emulated/0/...`) — filesystem-nya tidak mendukung symlink, bikin `npm install` gagal (`EACCES symlink`). **Kerja folder project HARUS di internal Termux**, misal `~/sop-plta`.
- File hasil download dari chat masuk ke `/storage/emulated/0/Download`, diakses dari Termux lewat `~/storage/downloads/` (setelah `termux-setup-storage` dijalankan & izin di-allow). Pindahkan pakai `cp` ke `~/sop-plta/`.
- Karena Termux hanya 1 sesi visual yang mudah diakses (fitur "New session" tidak selalu kelihatan di semua device/tema), server dijalankan di **background** pakai `nohup node server.js > server.log 2>&1 &`, supaya terminal yang sama tetap bisa dipakai kirim `curl` atau command lain. Cek log dengan `cat server.log`. Matikan dengan `pkill -f "node server.js"`.

---

## 9. FILE-FILE PROYEK SAAT INI

- `supabase_schema.sql` — skema database (sudah diterapkan ke Supabase project `tjnwgoxcoqdsnllcnhgh`)
- `generate_embeddings.js` — generate embedding 53 chunk via Voyage, update ke Supabase (idempotent, aman dijalankan ulang)
- `test_retrieval.js` — uji akurasi `match_chunks()` dengan pertanyaan contoh
- `system_prompt.js` — instruksi inti AI (dipakai `server.js`)
- `system_prompt.txt` — versi dokumentasi/plain text dari system prompt (untuk review manusia)
- `server.js` — backend Express, endpoint `/chat`, serve frontend statis
- `public/index.html` — frontend chat MVP
- `package.json` — dependencies (`@supabase/supabase-js`, `dotenv`, `express`)
- `.env` (TIDAK diunggah/dibagikan — isi API key & Supabase service role key, hanya ada di HP Malik)

---

## 10. YANG BELUM DIKERJAKAN / LANGKAH BERIKUTNYA

1. Uji frontend lewat browser HP langsung (bukan cuma curl) — sedang berjalan, hasil terakhir belum dikonfirmasi.
2. Verifikasi ulang konten dokumen 005 (Free Governor, status `percobaan_fixed`) — pastikan isi chunk yang ter-insert benar-benar versi yang sudah diperbaiki typo-nya, bukan versi asli.
3. Voice (STT/TTS) — tahap lanjutan, belum mulai.
4. Evaluasi kebutuhan reranking / peningkatan akurasi retrieval kalau nanti dokumen bertambah banyak (saat ini 53 chunk masih kecil, TF-IDF/embedding sederhana sudah cukup).
5. Kalau proyek dapat dukungan resmi PLN: pertimbangkan upgrade model generation (Claude/GPT kelas lebih tinggi), fitur riwayat percakapan untuk troubleshooting berkelanjutan, multi-unit (Unit 2) & multi-lokasi PLTA lain — struktur database sudah siap menerima ini tanpa migrasi besar.

---

## 11. PRINSIP DESAIN YANG TETAP DIPEGANG (tidak berubah dari rencana awal)

- Scalable tapi simpel: kolom-kolom cadangan (`metadata` jsonb) disiapkan dari awal supaya penambahan detail di masa depan tidak perlu migrasi skema.
- Setiap keputusan teknis (model, skema, dsb) diambil lewat diskusi eksplisit, bukan sepihak oleh AI.
- AI asisten tidak menggantikan otoritas keputusan operator/tim — sifatnya bahan pertimbangan berbasis SOP resmi.
