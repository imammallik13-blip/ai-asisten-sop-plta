/**
 * admin_routes.js
 *
 * Endpoint admin untuk CRUD dokumen IK & chunk (termasuk upload foto per langkah).
 * Dipasang di server.js sebagai router terpisah supaya server.js tidak terlalu penuh.
 *
 * Semua endpoint di sini butuh login (cookie sesi admin), kecuali /login sendiri.
 */

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { parseDocxToChunks } = require('./ik_docx_parser');

function createAdminRouter({ supabase, embedDocumentText, generateWithGemini, adminPassword }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // maks 5MB/foto
  const uploadDoc = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // maks 20MB/dokumen .docx

  // ---------- JOB STORE: proses simpan massal (upload -> auto-chunk -> banyak chunk sekaligus) ----------
  // Sama seperti validSessions di bawah: disimpan di memori server (bukan database), sederhana untuk MVP.
  // Konsekuensi: kalau server restart di tengah proses, progress job yang sedang berjalan hilang
  // (tapi chunk yang SUDAH sempat tersimpan sebelum restart tetap aman di database).
  const bulkJobs = new Map(); // jobId -> { status, total, done, current_label, errors: [], createdAt }
  const JOB_TTL_MS = 60 * 60 * 1000; // job lama dibuang otomatis setelah 1 jam supaya memori tidak terus bertambah

  function cleanOldJobs() {
    const now = Date.now();
    for (const [id, job] of bulkJobs) {
      if (now - job.createdAt > JOB_TTL_MS) bulkJobs.delete(id);
    }
  }

  // Voyage AI membatasi akun tanpa payment method jadi 3 request/menit -- proses simpan massal
  // sengaja dikasih jeda antar chunk (sama seperti generate_embeddings.js) supaya tidak terus-menerus
  // kena 429, dan supaya progress-nya bisa diperkirakan (jumlah chunk x ~22 detik).
  const BULK_DELAY_BETWEEN_CHUNKS_MS = 21000;
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Sesi login disimpan di memori server (bukan database) -> sederhana untuk MVP.
  // Konsekuensi: kalau server di-restart, semua orang yang login harus login ulang. Ini oke untuk skala saat ini.
  const validSessions = new Map(); // token -> waktu kedaluwarsa (ms)
  const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 jam

  function cleanExpiredSessions() {
    const now = Date.now();
    for (const [token, expiry] of validSessions) {
      if (expiry < now) validSessions.delete(token);
    }
  }

  function requireAdmin(req, res, next) {
    cleanExpiredSessions();
    const token = req.cookies?.admin_session;
    if (!token || !validSessions.has(token)) {
      return res.status(401).json({ error: 'Belum login atau sesi kedaluwarsa. Silakan login ulang.' });
    }
    next();
  }

  // ---------- AUTH ----------

  router.post('/login', (req, res) => {
    const { password } = req.body;
    if (!password || password !== adminPassword) {
      return res.status(401).json({ error: 'Password salah.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    validSessions.set(token, Date.now() + SESSION_DURATION_MS);
    res.cookie('admin_session', token, {
      httpOnly: true,
      maxAge: SESSION_DURATION_MS,
      sameSite: 'lax',
    });
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const token = req.cookies?.admin_session;
    if (token) validSessions.delete(token);
    res.clearCookie('admin_session');
    res.json({ ok: true });
  });

  router.get('/check', requireAdmin, (req, res) => res.json({ ok: true }));

  // ---------- UPLOAD FOTO ----------

  router.post('/upload-photo', requireAdmin, upload.single('photo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'File foto wajib diisi.' });

      const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const filename = `${crypto.randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('ik-photos')
        .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

      if (uploadError) throw new Error(uploadError.message);

      const { data } = supabase.storage.from('ik-photos').getPublicUrl(filename);
      res.json({ url: data.publicUrl });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- UPLOAD DOKUMEN IK/SOP (.docx) -> AUTO PARSING + AUTO CHUNKING ----------
  // Murni proses teks lokal (parsing docx + heuristik chunking), TIDAK memanggil Voyage/embedding
  // di sini -- makanya bisa langsung selesai dalam hitungan detik meski dokumennya panjang.
  // Hasilnya BELUM disimpan ke database sama sekali; admin_routes ini cuma "membaca & memecah",
  // penyimpanan sungguhan terjadi lewat endpoint chunk yang sudah ada (satu-satu) atau lewat
  // /documents/:id/chunks/bulk (banyak sekaligus) setelah admin meninjau hasilnya di halaman admin.
  router.post('/documents/parse-upload', requireAdmin, uploadDoc.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'File .docx wajib diisi.' });
      const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
      if (ext !== 'docx') {
        return res.status(400).json({ error: 'Format file belum didukung. Saat ini hanya .docx yang bisa diproses otomatis (file .doc lama perlu disimpan ulang sebagai .docx dulu).' });
      }

      const fallbackName = req.file.originalname.replace(/\.docx$/i, '');
      const result = await parseDocxToChunks(req.file.buffer, fallbackName);

      if (!result.chunks.length) {
        return res.status(422).json({ error: 'Tidak ada bagian yang berhasil dikenali dari file ini. Kemungkinan format dokumen berbeda dari template IK yang biasa dipakai -- coba isi manual saja untuk dokumen ini.' });
      }

      res.json({ metadata: result.metadata, chunks: result.chunks });
    } catch (err) {
      res.status(500).json({ error: 'Gagal memproses file: ' + err.message });
    }
  });

  // ---------- AI-ASSISTED DRAFT PARSING (Tahap 1: paste teks mentah, BUKAN upload PDF) ----------
  // Untuk dokumen non-IK yang strukturnya bebas (troubleshooting guide, manual referensi, dll)
  // -- beda dari /documents/parse-upload yang mengandalkan regex heading tetap khusus template IK.
  // Di sini Gemini yang menyusun draft (judul + chunk + translasi ID, istilah teknis/rumus
  // dipertahankan apa adanya). HASIL BELUM DISIMPAN -- admin WAJIB meninjau/mengedit dulu di UI,
  // baru pakai endpoint /documents (buat dokumen) + /documents/:id/chunks/bulk (simpan chunks)
  // yang SUDAH ADA untuk commit ke database. Prinsipnya sama seperti auto-chunk docx: AI cuma
  // menyusun draft, otoritas final tetap di admin.
  const AI_DRAFT_SYSTEM_PROMPT = `Kamu membantu tim teknis PLTA Sipansihaporas menyusun DRAFT dokumen pengetahuan (troubleshooting/manual/referensi) untuk knowledge base AI Asisten SOP. Draft ini akan DITINJAU MANUSIA sebelum disimpan -- tidak apa belum sempurna, TAPI JANGAN mengarang informasi yang tidak ada di teks sumber.

INPUT: teks mentah (bisa berbahasa Inggris/Indonesia/campuran) hasil salin dari dokumen manual/troubleshooting/referensi teknis.

TUGASMU:
1. Usulkan judul dokumen yang ringkas & deskriptif ("judul_usulan").
2. Pecah isi jadi beberapa chunk logis. Tiap chunk = 1 unit pemikiran utuh (misal: 1 gejala+penyebab+tindakan, atau 1 prosedur lengkap dengan semua langkah & rumusnya). JANGAN memisah rumus/perhitungan dari contoh-contohnya ke chunk berbeda.
3. Tentukan section_type paling sesuai untuk tiap chunk, dari daftar ini SAJA:
   - "diagnostik" = gejala -> kemungkinan penyebab (pola if/then, troubleshooting)
   - "prosedur" = langkah-langkah tindakan/prosedur berurutan
   - "referensi" = info pendukung (definisi, spesifikasi, sumber daya, dsb), bukan langkah maupun diagnosa
   - "ringkasan" = ringkasan/tujuan/ruang lingkup umum
   - "tindakan_akhir" = langkah penutup/setelah prosedur selesai
4. Terjemahkan isi tiap chunk (field "text") ke Bahasa Indonesia yang jelas & natural.
   JANGAN DITERJEMAHKAN, salin PERSIS apa adanya: nama/nomor model alat (mis. PDS500, Fluke), rumus/angka/satuan (mis. "mA = 1.6 * water level + 4", "4.64mA", "+4cm"), dan istilah teknis yang lazimnya dipakai dalam Bahasa Inggris di lapangan.
5. Isi juga "metadata.bahasa_asli" (kode bahasa sumber, mis. "en"/"id") dan "metadata.teks_asli" (potongan teks ASLI, sebelum diterjemahkan, yang berkorespondensi persis dengan chunk ini -- untuk audit).
6. JANGAN menambahkan informasi, asumsi, atau kesimpulan yang TIDAK ADA di teks sumber.

FORMAT OUTPUT -- WAJIB, balas HANYA dengan JSON valid, TANPA teks lain, TANPA markdown code fence:
{
  "judul_usulan": "string",
  "chunks": [
    {
      "section_type": "diagnostik|prosedur|referensi|ringkasan|tindakan_akhir",
      "label": "string singkat deskriptif chunk ini",
      "text": "isi chunk dalam Bahasa Indonesia (kecuali istilah teknis sesuai aturan di atas)",
      "metadata": { "bahasa_asli": "en atau id", "teks_asli": "potongan teks asli yang berkorespondensi" }
    }
  ]
}`;

  router.post('/ai-draft-parse', requireAdmin, async (req, res) => {
    try {
      const { raw_text, jenis_dokumen } = req.body;
      if (!raw_text || !raw_text.trim()) {
        return res.status(400).json({ error: 'Teks mentah wajib diisi.' });
      }
      if (typeof generateWithGemini !== 'function') {
        return res.status(500).json({ error: 'Fitur AI-draft belum terpasang di server (generateWithGemini belum di-inject).' });
      }

      const userPrompt = `JENIS DOKUMEN (konteks tambahan, opsional): ${jenis_dokumen || '(tidak disebutkan)'}\n\nTEKS MENTAH:\n${raw_text}`;
      const rawResponse = await generateWithGemini(AI_DRAFT_SYSTEM_PROMPT, userPrompt);

      // Jaga-jaga kalau Gemini tetap membungkus dengan code fence markdown meski sudah diminta tidak.
      const cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

      let draft;
      try {
        draft = JSON.parse(cleaned);
      } catch (parseErr) {
        return res.status(502).json({
          error: 'Gemini mengembalikan format yang tidak bisa dibaca sebagai JSON. Coba proses ulang, atau persingkat/rapikan teks input.',
          raw_preview: cleaned.slice(0, 500),
        });
      }

      if (!Array.isArray(draft.chunks) || draft.chunks.length === 0) {
        return res.status(502).json({ error: 'Draft dari AI tidak berisi chunk apa pun. Coba proses ulang dengan teks yang lebih jelas strukturnya.' });
      }

      res.json({ judul_usulan: draft.judul_usulan || '', chunks: draft.chunks });
    } catch (err) {
      res.status(500).json({ error: 'Gagal memproses draft AI: ' + err.message });
    }
  });

  // ---------- SIMPAN MASSAL (dipakai setelah review hasil auto-chunk, atau menyimpan banyak langkah sekaligus) ----------

  router.post('/documents/:id/chunks/bulk', requireAdmin, async (req, res) => {
    try {
      const { chunks } = req.body;
      if (!Array.isArray(chunks) || chunks.length === 0) {
        return res.status(400).json({ error: 'Tidak ada bagian yang dikirim untuk diproses.' });
      }

      const { data: doc, error: docErr } = await supabase
        .from('documents')
        .select('nomor_ik, judul')
        .eq('id', req.params.id)
        .single();
      if (docErr) throw new Error(docErr.message);

      cleanOldJobs();
      const jobId = crypto.randomUUID();
      const job = { status: 'processing', total: chunks.length, done: 0, current_label: null, errors: [], createdAt: Date.now() };
      bulkJobs.set(jobId, job);

      // Diproses di background (tidak di-await) -- endpoint langsung balas job_id supaya
      // halaman admin tidak perlu menunggu satu request HTTP yang bisa berlangsung bermenit-menit.
      (async () => {
        for (let i = 0; i < chunks.length; i++) {
          const item = chunks[i];
          job.current_label = item.label || `Bagian ${i + 1}`;
          try {
            if (!item.section_type || !item.label || !item.text) {
              throw new Error('section_type, label, dan text wajib diisi.');
            }
            const embedding = await embedDocumentText(item.text);
            const chunkId = `${doc.nomor_ik}-${crypto.randomUUID().slice(0, 8)}`;
            const { error: insertErr } = await supabase
              .from('chunks')
              .insert({
                chunk_id: chunkId,
                document_id: req.params.id,
                source_doc: doc.nomor_ik,
                judul: doc.judul,
                section_type: item.section_type,
                label: item.label,
                text: item.text,
                embedding,
                metadata: buildPhotoMetadata(item.photo_url, item.photo_urls, item.metadata),
              });
            if (insertErr) throw new Error(insertErr.message);
            job.done += 1;
          } catch (itemErr) {
            job.errors.push({ label: item.label || `Bagian ${i + 1}`, message: itemErr.message });
          }

          if (i < chunks.length - 1) await sleep(BULK_DELAY_BETWEEN_CHUNKS_MS);
        }
        job.current_label = null;
        job.status = 'completed';
      })().catch((err) => {
        job.status = 'completed';
        job.errors.push({ label: 'Proses keseluruhan', message: err.message });
      });

      res.json({ job_id: jobId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/documents/bulk-jobs/:jobId', requireAdmin, (req, res) => {
    const job = bulkJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job tidak ditemukan (mungkin sudah kedaluwarsa atau server sempat restart).' });
    res.json(job);
  });

  // ---------- DOCUMENTS ----------

  // Catatan: chunks di-select dengan (label, section_type) -- bukan cuma count -- supaya
  // frontend admin bisa hitung "progress chunking" per dokumen (berapa bagian wajib yang
  // sudah lengkap vs berapa langkah prosedur yang sudah tersimpan), tanpa perlu query terpisah
  // per dokumen. Masih aman untuk skala saat ini (jumlah dokumen & chunk kecil).
  router.get('/documents', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('documents')
        .select('id, nomor_ik, judul, unit, lokasi, status_dokumen, chunks(label, section_type)')
        .order('nomor_ik');
      if (error) throw new Error(error.message);
      res.json({ documents: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/documents/:id', requireAdmin, async (req, res) => {
    try {
      const { data: doc, error: docError } = await supabase
        .from('documents')
        .select('*')
        .eq('id', req.params.id)
        .single();
      if (docError) throw new Error(docError.message);

      const { data: chunks, error: chunksError } = await supabase
        .from('chunks')
        .select('id, chunk_id, section_type, label, text, metadata')
        .eq('document_id', req.params.id)
        .order('chunk_id');
      if (chunksError) throw new Error(chunksError.message);

      res.json({ document: doc, chunks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/documents', requireAdmin, async (req, res) => {
    try {
      const { nomor_ik, judul, unit, lokasi, status_dokumen, metadata } = req.body;
      if (!nomor_ik || !judul) {
        return res.status(400).json({ error: 'nomor_ik dan judul wajib diisi.' });
      }

      const { data, error } = await supabase
        .from('documents')
        .insert({
          nomor_ik,
          judul,
          unit: unit || '1',
          lokasi: lokasi || 'SPH',
          status_dokumen: status_dokumen || 'resmi',
          metadata: metadata && typeof metadata === 'object' ? metadata : {},
        })
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      res.json({ id: data.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/documents/:id', requireAdmin, async (req, res) => {
    try {
      const { nomor_ik, judul, unit, lokasi, status_dokumen } = req.body;
      const { error } = await supabase
        .from('documents')
        .update({ nomor_ik, judul, unit, lokasi, status_dokumen, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/documents/:id', requireAdmin, async (req, res) => {
    try {
      // chunks ikut terhapus otomatis (ON DELETE CASCADE di skema)
      const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- CHUNKS (section & langkah prosedur) ----------

  // Catatan foto: `photo_url` (string tunggal) dipakai oleh langkah prosedur (1 foto/langkah).
  // `photo_urls` (array) dipakai oleh section Lampiran (bisa banyak foto/scan sekaligus).
  // Keduanya disimpan di kolom metadata jsonb yang sama, cukup beda bentuk field -- tidak
  // perlu migrasi skema.
  // PENTING: gabung (bukan timpa) -- baseMetadata bisa berisi field lain di luar foto
  // (mis. bahasa_asli/teks_asli dari fitur AI-draft), jangan sampai hilang kalau dokumen
  // juga punya foto.
  function buildPhotoMetadata(photo_url, photo_urls, baseMetadata) {
    const meta = (baseMetadata && typeof baseMetadata === 'object') ? { ...baseMetadata } : {};
    if (Array.isArray(photo_urls)) meta.photo_urls = photo_urls;
    else if (photo_url) meta.photo_url = photo_url;
    return meta;
  }

  router.post('/documents/:id/chunks', requireAdmin, async (req, res) => {
    try {
      const { section_type, label, text, photo_url, photo_urls, metadata } = req.body;
      if (!section_type || !label || !text) {
        return res.status(400).json({ error: 'section_type, label, dan text wajib diisi.' });
      }

      const { data: doc, error: docErr } = await supabase
        .from('documents')
        .select('nomor_ik, judul')
        .eq('id', req.params.id)
        .single();
      if (docErr) throw new Error(docErr.message);

      const embedding = await embedDocumentText(text);
      const chunkId = `${doc.nomor_ik}-${crypto.randomUUID().slice(0, 8)}`;

      const { data, error } = await supabase
        .from('chunks')
        .insert({
          chunk_id: chunkId,
          document_id: req.params.id,
          source_doc: doc.nomor_ik,
          judul: doc.judul,
          section_type,
          label,
          text,
          embedding,
          metadata: buildPhotoMetadata(photo_url, photo_urls, metadata),
        })
        .select('id, chunk_id')
        .single();

      if (error) throw new Error(error.message);
      res.json({ id: data.id, chunk_id: data.chunk_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/chunks/:id', requireAdmin, async (req, res) => {
    try {
      const { label, text, section_type, photo_url, photo_urls, metadata } = req.body;
      if (!text) return res.status(400).json({ error: 'text wajib diisi.' });

      const embedding = await embedDocumentText(text);

      const { error } = await supabase
        .from('chunks')
        .update({
          label,
          text,
          section_type,
          embedding,
          metadata: buildPhotoMetadata(photo_url, photo_urls, metadata),
        })
        .eq('id', req.params.id);

      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/chunks/:id', requireAdmin, async (req, res) => {
    try {
      const { error } = await supabase.from('chunks').delete().eq('id', req.params.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
