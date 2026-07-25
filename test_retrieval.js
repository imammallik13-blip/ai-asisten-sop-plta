/**
 * test_retrieval.js
 *
 * Script untuk menguji akurasi retrieval (match_chunks) di Supabase.
 * Mengambil pertanyaan, embed pakai Voyage (input_type: "query"),
 * lalu panggil function match_chunks() dan tampilkan hasil top-N.
 *
 * CARA PAKAI:
 * - Uji beberapa pertanyaan contoh bawaan:
 *     node test_retrieval.js
 * - Uji pertanyaan custom:
 *     node test_retrieval.js "apa langkah sebelum PLTA beroperasi?"
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!VOYAGE_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: pastikan VOYAGE_API_KEY, SUPABASE_URL, dan SUPABASE_SERVICE_ROLE_KEY sudah diisi di .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const VOYAGE_MODEL = 'voyage-4-lite';
const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

// Pertanyaan contoh mewakili beberapa jenis IK yang berbeda,
// supaya kita bisa lihat apakah retrieval-nya "nyasar" ke dokumen yang salah atau tidak.
const DEFAULT_QUESTIONS = [
  'Apa langkah-langkah yang perlu disiapkan sebelum PLTA beroperasi?',
  'Bagaimana cara melakukan manual synchronizing?',
  'Berapa lama durasi proses line charging?',
  'Apa yang harus dilakukan saat quick stop?',
  'Bagaimana cara mengaktifkan mode free governor?',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      input_type: 'query', // beda dengan 'document' yang dipakai saat indexing chunk
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

async function testQuestion(question) {
  console.log('\n' + '='.repeat(70));
  console.log(`PERTANYAAN: ${question}`);
  console.log('='.repeat(70));

  const embedding = await embedQuery(question);

  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_lokasi: 'SPH',
    match_unit: '1',
    match_count: 3,
  });

  if (error) {
    console.error('Gagal memanggil match_chunks:', error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log('(Tidak ada hasil yang ditemukan)');
    return;
  }

  data.forEach((row, idx) => {
    console.log(`\n[${idx + 1}] Similarity: ${row.similarity.toFixed(4)}`);
    console.log(`    Sumber   : ${row.source_doc} - ${row.judul}`);
    console.log(`    Section  : ${row.section_type} / ${row.label}`);
    console.log(`    Cuplikan : ${row.text.slice(0, 150).replace(/\n/g, ' ')}...`);
  });
}

async function main() {
  const customQuestion = process.argv[2];
  const questions = customQuestion ? [customQuestion] : DEFAULT_QUESTIONS;

  for (const q of questions) {
    try {
      await testQuestion(q);
    } catch (err) {
      console.error(`Gagal memproses pertanyaan "${q}":`, err.message);
    }
    // Jeda supaya tidak kena rate limit 3 request/menit (akun belum ada payment method)
    if (questions.length > 1) {
      await sleep(22000);
    }
  }

  console.log('\nSelesai menguji retrieval.');
}

main().catch((err) => {
  console.error('Terjadi error tak terduga:', err);
  process.exit(1);
});
