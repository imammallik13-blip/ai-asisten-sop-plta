/**
 * generate_embeddings.js
 *
 * Script untuk generate embedding chunk SOP/IK PLTA Sipansihaporas
 * menggunakan Voyage AI (voyage-4-lite, 1024 dimensi), lalu update
 * hasilnya ke kolom `embedding` di tabel `chunks` pada Supabase.
 *
 * CARA PAKAI:
 * 1. npm install @supabase/supabase-js dotenv
 * 2. Buat file .env (lihat .env.example) berisi:
 *      VOYAGE_API_KEY=xxxxx
 *      SUPABASE_URL=https://xxxxx.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY=xxxxx
 * 3. node generate_embeddings.js
 *
 * PENTING: jangan commit file .env ke Git. Tambahkan .env ke .gitignore.
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

// Akun tanpa payment method dibatasi Voyage jadi 3 request/menit (429 kalau dilanggar).
// Jadi batch dikecilkan + dikasih jeda antar batch supaya tetap di bawah limit itu.
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 22000; // ~22 detik -> aman di bawah 3 request/menit

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(texts, retriesLeft = 3) {
  const res = await fetch(VOYAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: 'document', // penting: beda dengan embedding pertanyaan operator nanti ("query")
      output_dimension: 1024,
    }),
  });

  if (res.status === 429 && retriesLeft > 0) {
    console.log('Kena rate limit (429), tunggu 30 detik lalu coba lagi...');
    await sleep(30000);
    return embedBatch(texts, retriesLeft - 1);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  // data.data adalah array hasil embedding, urutannya sama dengan urutan input
  return data.data.map((item) => item.embedding);
}

async function main() {
  console.log('Mengambil chunk yang belum punya embedding...');
  const { data: chunks, error } = await supabase
    .from('chunks')
    .select('id, chunk_id, text')
    .is('embedding', null);

  if (error) {
    console.error('Gagal mengambil data chunks:', error.message);
    process.exit(1);
  }

  console.log(`Ditemukan ${chunks.length} chunk yang perlu di-embed.`);

  if (chunks.length === 0) {
    console.log('Semua chunk sudah punya embedding. Tidak ada yang perlu dikerjakan.');
    return;
  }

  let processed = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    console.log(`Memproses batch ${i / BATCH_SIZE + 1} (${batch.length} chunk)...`);

    let embeddings;
    try {
      embeddings = await embedBatch(texts);
    } catch (err) {
      console.error(`Gagal embed batch mulai dari index ${i}:`, err.message);
      await sleep(DELAY_BETWEEN_BATCHES_MS);
      continue; // lanjut ke batch berikutnya, jangan hentikan seluruh proses
    }

    // Update tiap chunk satu-satu (Supabase JS client tidak mendukung bulk update berbeda nilai per baris)
    for (let j = 0; j < batch.length; j++) {
      const { error: updateError } = await supabase
        .from('chunks')
        .update({ embedding: embeddings[j] })
        .eq('id', batch[j].id);

      if (updateError) {
        console.error(`Gagal update chunk ${batch[j].chunk_id}:`, updateError.message);
      } else {
        processed++;
      }
    }

    // Jeda sebelum batch berikutnya, supaya tidak melebihi limit 3 request/menit
    if (i + BATCH_SIZE < chunks.length) {
      console.log(`Menunggu ${DELAY_BETWEEN_BATCHES_MS / 1000} detik sebelum batch berikutnya...`);
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`Selesai. ${processed} dari ${chunks.length} chunk berhasil di-update dengan embedding.`);
}

main().catch((err) => {
  console.error('Terjadi error tak terduga:', err);
  process.exit(1);
});
