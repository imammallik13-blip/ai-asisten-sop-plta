/**
 * server.js
 *
 * Backend endpoint AI Asisten SOP PLTA Sipansihaporas.
 * Alur: pertanyaan operator -> embed (Voyage) -> retrieval (Supabase match_chunks)
 *       -> susun prompt + context -> generate jawaban (Google Gemini)
 *       -> simpan riwayat ke chat_messages -> kembalikan jawaban + rujukan sumber.
 *
 * CARA JALANKAN:
 *   npm install
 *   node server.js
 * Server akan jalan di http://localhost:3000
 *
 * TEST CEPAT (dari terminal lain / curl):
 *   curl -X POST http://localhost:3000/chat \
 *     -H "Content-Type: application/json" \
 *     -d '{"question":"apa langkah sebelum PLTA beroperasi?"}'
 */

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const { SYSTEM_PROMPT } = require('./system_prompt');
const { createAdminRouter } = require('./admin_routes');

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!VOYAGE_API_KEY || !GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_PASSWORD) {
  console.error('ERROR: pastikan VOYAGE_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD sudah diisi di .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const VOYAGE_MODEL = 'voyage-4-lite';
const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname + '/public'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Embed teks untuk keperluan INDEXING (dipakai admin saat simpan section/langkah IK).
// Beda dengan embedQuery (dipakai saat operator bertanya) karena input_type berbeda.
// Ada retry otomatis kalau kena rate limit 429 (akun Voyage tanpa payment method dibatasi 3 request/menit).
async function embedDocumentText(text, retriesLeft = 3) {
  const res = await fetch(VOYAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: 'document',
      output_dimension: 1024,
    }),
  });

  if (res.status === 429 && retriesLeft > 0) {
    await sleep(25000);
    return embedDocumentText(text, retriesLeft - 1);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

app.use('/admin/api', createAdminRouter({ supabase, embedDocumentText, adminPassword: ADMIN_PASSWORD }));

app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

async function embedQuery(text) {
  const res = await fetch(VOYAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: 'query',
      output_dimension: 1024,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

const SIMILARITY_THRESHOLD = 0.45; // buang chunk yang similarity-nya di bawah ini (kurang relevan)
const MAX_CONTEXT_CHUNKS = 3; // maksimal chunk yang dikirim ke AI, meski kandidat awal lebih banyak

// ============================================================
// DOCUMENT-SCOPED RETRIEVAL
// Direkonstruksi ulang berdasarkan Progress_AI_Asisten_SOP_PLTA_Sipansihaporas-3.md
// (kode asli hilang saat server.js live tertimpa -- lihat catatan di HANDOVER/progress).
// PENTING: ini rekonstruksi dari spesifikasi tertulis, BUKAN kode asli yang di-restore
// byte-demi-byte. Perilakunya dibuat cocok dengan deskripsi di catatan progress, tapi
// tolong uji ulang dengan beberapa pertanyaan nyata sebelum sepenuhnya dipercaya --
// terutama threshold MIN_SCORE/MIN_MARGIN di bawah (sesuai catatan, ini juga belum
// pernah divalidasi dengan data sungguhan meski di versi aslinya).
//
// Cara kerja: kalau pertanyaan operator jelas merujuk 1 IK tertentu (skor overlap kata
// kunci jauh lebih tinggi dari kandidat lain), retrieval dipersempit ke dokumen itu saja
// -- mengurangi risiko AI mencampur konteks antar-IK yang topiknya mirip. Kalau tidak
// yakin/ambigu, kembalikan null -- retrieval tetap broad seperti biasa (aman).
// ============================================================

const STOPWORDS = new Set([
  // Kata umum Bahasa Indonesia -- tidak membedakan 1 dokumen dari dokumen lain
  'yang', 'untuk', 'pada', 'dengan', 'dari', 'dan', 'atau', 'di', 'ke', 'dalam',
  'adalah', 'ini', 'itu', 'akan', 'dapat', 'bisa', 'apa', 'apakah', 'bagaimana',
  'kapan', 'kalau', 'jika', 'saat', 'ada', 'tidak', 'saya', 'kita', 'kami',
  'operator', 'prosedur', 'langkah', 'cara', 'sebelum', 'sesudah', 'setelah',
  // Kata yang konstan muncul di hampir semua judul IK -- diverifikasi dari daftar
  // judul dokumen aktual di database (Agustus 2026)
  'pelaksanaan', 'ulplta', 'sipansihaporas', 'unit', 'pengoperasian',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s#]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length > 2 && !STOPWORDS.has(tok));
}

const MIN_SCORE = 2;   // minimal 2 kata kunci match supaya dianggap "eksplisit"
const MIN_MARGIN = 1;  // skor teratas harus unggul >=1 dari skor kedua tertinggi
const DOCUMENT_LIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit, sesuai catatan progress

let documentListCache = { key: null, data: null, expiresAt: 0 };

// Daftar dokumen (nomor_ik, judul) untuk lokasi+unit tertentu, termasuk dokumen
// unit='general' (relevan lintas unit) -- di-cache di memori 5 menit supaya tidak
// query Supabase di setiap pertanyaan operator.
async function getDocumentList(lokasi, unit) {
  const now = Date.now();
  const cacheKey = `${lokasi}|${unit}`;
  if (documentListCache.key === cacheKey && documentListCache.data && now < documentListCache.expiresAt) {
    return documentListCache.data;
  }

  const { data, error } = await supabase
    .from('documents')
    .select('nomor_ik, judul')
    .eq('lokasi', lokasi)
    .or(`unit.eq.${unit},unit.eq.general`);

  if (error) throw new Error(`Gagal ambil daftar dokumen untuk document-scoping: ${error.message}`);

  documentListCache = { key: cacheKey, data: data || [], expiresAt: now + DOCUMENT_LIST_CACHE_TTL_MS };
  return documentListCache.data;
}

async function detectExplicitDocument(question, lokasi, unit) {
  const documents = await getDocumentList(lokasi, unit);
  if (documents.length === 0) return null;

  const questionTokens = new Set(tokenize(question));
  if (questionTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  let secondBestScore = 0;

  for (const doc of documents) {
    const titleTokens = new Set(tokenize(doc.judul));
    let score = 0;
    for (const tok of titleTokens) {
      if (questionTokens.has(tok)) score += 1;
    }

    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      best = doc;
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  if (!best) return null;
  if (bestScore < MIN_SCORE) return null;
  if (bestScore - secondBestScore < MIN_MARGIN) return null;

  return best.nomor_ik;
}

async function retrieveChunks(embedding, lokasi, unit, matchCount = 5, sourceDoc = null) {
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_lokasi: lokasi,
    match_unit: unit,
    match_count: matchCount,
    match_source_doc: sourceDoc,
  });

  if (error) throw new Error(`Supabase match_chunks error: ${error.message}`);

  const candidates = data || [];

  // Buang kandidat yang similarity-nya terlalu rendah (kurang relevan),
  // lalu batasi jumlah yang benar-benar dikirim ke AI supaya konteks tidak "nyasar".
  const filtered = candidates.filter((c) => c.similarity >= SIMILARITY_THRESHOLD);
  return filtered.slice(0, MAX_CONTEXT_CHUNKS);
}

function buildContextText(chunks) {
  if (chunks.length === 0) return '(Tidak ada context yang cukup relevan ditemukan di database untuk pertanyaan ini.)';

  return chunks
    .map((c, idx) => (
      `[Context ${idx + 1}]\n` +
      `Sumber: ${c.source_doc} - ${c.judul}\n` +
      `Section: ${c.section_type} / ${c.label}\n` +
      `Isi: ${c.text}`
    ))
    .join('\n\n');
}

// Kumpulkan URL foto (kalau ada) dari metadata chunk -- dipakai untuk ditampilkan sebagai
// thumbnail di bawah jawaban AI di halaman chat operator. `photo_url` dipakai langkah
// prosedur (1 foto), `photo_urls` dipakai section Lampiran (banyak foto).
function extractPhotoUrls(chunk) {
  const meta = chunk.metadata || {};
  if (Array.isArray(meta.photo_urls)) return meta.photo_urls.filter(Boolean);
  if (meta.photo_url) return [meta.photo_url];
  return [];
}

async function generateAnswer(question, contextText) {
  const userPrompt = `PERTANYAAN OPERATOR:\n${question}\n\nCONTEXT DARI DATABASE IK/SOP:\n${contextText}\n\nSusun jawaban sesuai aturan di atas.`;

  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!answer) throw new Error('Gemini tidak mengembalikan jawaban (kemungkinan diblok safety filter atau response kosong).');
  return answer;
}

// Pisahkan pengingat safety-critical (tag <PENTING>...</PENTING>, lihat aturan 5 di
// system_prompt.js) dari isi jawaban utama, supaya frontend bisa tampilkan sebagai
// kotak highlight terpisah. Teks mentah (dengan tag) tetap disimpan apa adanya ke
// riwayat chat untuk audit trail -- fungsi ini hanya dipakai untuk response ke frontend.
function extractSafetyNote(answer) {
  const match = answer.match(/<PENTING>([\s\S]*?)<\/PENTING>/i);
  if (!match) return { mainAnswer: answer, safetyNote: null };
  const safetyNote = match[1].trim();
  const mainAnswer = answer.replace(match[0], '').trim();
  return { mainAnswer, safetyNote };
}

app.post('/chat', async (req, res) => {
  try {
    const { question, unit = '1', lokasi = 'SPH', session_id } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Field "question" wajib diisi.' });
    }

    // 1. Pastikan ada session (buat baru kalau belum ada)
    let sessionId = session_id;
    if (!sessionId) {
      const { data: sessionData, error: sessionError } = await supabase
        .from('chat_sessions')
        .insert({ unit, lokasi })
        .select('id')
        .single();

      if (sessionError) throw new Error(`Gagal membuat sesi: ${sessionError.message}`);
      sessionId = sessionData.id;
    }

    // 2. Embed pertanyaan operator + deteksi apakah pertanyaan merujuk 1 IK spesifik
    //    (dijalankan bersamaan karena keduanya independen -- tidak nambah latency)
    const [embedding, sourceDoc] = await Promise.all([
      embedQuery(question),
      detectExplicitDocument(question, lokasi, unit),
    ]);

    // 3. Retrieval chunk relevan (dipersempit ke sourceDoc kalau terdeteksi eksplisit)
    const chunks = await retrieveChunks(embedding, lokasi, unit, 5, sourceDoc);
    const retrievedChunkIds = chunks.map((c) => c.chunk_id);

    // 4. Susun context & generate jawaban
    const contextText = buildContextText(chunks);
    const answer = await generateAnswer(question, contextText);
    const { mainAnswer, safetyNote } = extractSafetyNote(answer);

    // 5. Simpan riwayat chat (operator + ai) untuk audit trail.
    // Insert dipisah (bukan array sekaligus) supaya kita bisa ambil `id` baris AI-nya --
    // dipakai frontend untuk mengaitkan feedback (👍/👎) ke jawaban yang spesifik.
    // Catatan: `answer` (teks mentah, termasuk tag <PENTING> kalau ada) disimpan apa adanya,
    // BUKAN mainAnswer, supaya riwayat audit lengkap sesuai yang benar-benar dihasilkan Gemini.
    await supabase.from('chat_messages').insert({ session_id: sessionId, role: 'operator', content: question });

    const { data: aiMessageRow, error: aiInsertError } = await supabase
      .from('chat_messages')
      .insert({ session_id: sessionId, role: 'ai', content: answer, retrieved_chunk_ids: retrievedChunkIds })
      .select('id')
      .single();

    if (aiInsertError) throw new Error(`Gagal simpan pesan AI: ${aiInsertError.message}`);

    // 6. Balikan ke frontend (photo_urls disertakan supaya operator bisa lihat foto langkah terkait)
    res.json({
      session_id: sessionId,
      message_id: aiMessageRow.id,
      answer: mainAnswer,
      safety_note: safetyNote,
      sources: chunks.map((c) => ({
        nomor_ik: c.source_doc,
        judul: c.judul,
        label: c.label,
        similarity: c.similarity,
        photo_urls: extractPhotoUrls(c),
      })),
    });
  } catch (err) {
    console.error('Error di /chat:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Feedback operator (👍/👎 + komentar opsional) untuk jawaban AI tertentu.
// Upsert berdasarkan message_id -- kalau operator kirim ulang (mis. ganti pikiran
// dari 👍 ke 👎), baris lama di-update, bukan dobel.
app.post('/feedback', async (req, res) => {
  try {
    const { message_id, rating, comment } = req.body;

    if (!message_id || typeof message_id !== 'string') {
      return res.status(400).json({ error: 'Field "message_id" wajib diisi.' });
    }
    if (rating !== 'up' && rating !== 'down') {
      return res.status(400).json({ error: 'Field "rating" harus "up" atau "down".' });
    }

    const { error } = await supabase
      .from('chat_feedback')
      .upsert(
        { message_id, rating, comment: comment ? String(comment).slice(0, 1000) : null },
        { onConflict: 'message_id' }
      );

    if (error) throw new Error(error.message);

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error di /feedback:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Daftar unit yang benar-benar ada dokumennya di database -- dipakai untuk isi
// dropdown unit di chat operator secara dinamis. Unit baru (mis. Unit 3 dst) otomatis
// muncul begitu admin upload dokumen pertamanya, tanpa perlu edit kode/deploy ulang.
// unit='general' sengaja tidak dimasukkan -- itu bukan pilihan unit, tapi disertakan
// otomatis ke retrieval unit manapun (lihat match_chunks di Supabase).
app.get('/units', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('unit, lokasi')
      .neq('unit', 'general');

    if (error) throw new Error(error.message);

    const seen = new Set();
    const units = [];
    for (const row of data || []) {
      const key = `${row.unit}|${row.lokasi}`;
      if (!seen.has(key)) {
        seen.add(key);
        units.push({ unit: row.unit, lokasi: row.lokasi });
      }
    }
    units.sort((a, b) => a.unit.localeCompare(b.unit, undefined, { numeric: true }));

    res.json({ units });
  } catch (err) {
    console.error('Error di /units:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server AI Asisten SOP PLTA berjalan di http://localhost:${PORT}`);
});
