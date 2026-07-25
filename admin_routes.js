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

function createAdminRouter({ supabase, embedDocumentText, adminPassword }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // maks 5MB/foto

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

  // ---------- DOCUMENTS ----------

  router.get('/documents', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('documents')
        .select('id, nomor_ik, judul, unit, lokasi, status_dokumen, chunks(count)')
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
      const { nomor_ik, judul, unit, lokasi, status_dokumen } = req.body;
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

  router.post('/documents/:id/chunks', requireAdmin, async (req, res) => {
    try {
      const { section_type, label, text, photo_url } = req.body;
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
          metadata: photo_url ? { photo_url } : {},
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
      const { label, text, section_type, photo_url } = req.body;
      if (!text) return res.status(400).json({ error: 'text wajib diisi.' });

      const embedding = await embedDocumentText(text);

      const { error } = await supabase
        .from('chunks')
        .update({
          label,
          text,
          section_type,
          embedding,
          metadata: photo_url ? { photo_url } : {},
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
