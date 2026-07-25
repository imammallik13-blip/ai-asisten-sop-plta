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

async function retrieveChunks(embedding, lokasi, unit, matchCount = 5) {
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_lokasi: lokasi,
    match_unit: unit,
    match_count: matchCount,
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

    // 2. Embed pertanyaan operator
    const embedding = await embedQuery(question);

    // 3. Retrieval chunk relevan
    const chunks = await retrieveChunks(embedding, lokasi, unit, 5);
    const retrievedChunkIds = chunks.map((c) => c.chunk_id);

    // 4. Susun context & generate jawaban
    const contextText = buildContextText(chunks);
    const answer = await generateAnswer(question, contextText);

    // 5. Simpan riwayat chat (operator + ai) untuk audit trail
    await supabase.from('chat_messages').insert([
      { session_id: sessionId, role: 'operator', content: question },
      { session_id: sessionId, role: 'ai', content: answer, retrieved_chunk_ids: retrievedChunkIds },
    ]);

    // 6. Balikan ke frontend
    res.json({
      session_id: sessionId,
      answer,
      sources: chunks.map((c) => ({
        nomor_ik: c.source_doc,
        judul: c.judul,
        label: c.label,
        similarity: c.similarity,
      })),
    });
  } catch (err) {
    console.error('Error di /chat:', err.message);
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
