-- ============================================================
-- SKEMA DATABASE: AI Asisten SOP/IK PLTA Sipansihaporas
-- Supabase (PostgreSQL) + pgvector
-- ============================================================
-- Cara pakai: copy-paste seluruh isi file ini ke Supabase SQL Editor,
-- lalu jalankan (Run).
-- ============================================================

-- Aktifkan extension vector (untuk embedding) dan uuid
create extension if not exists vector;
create extension if not exists "uuid-ossp";

-- ============================================================
-- 1. TABEL DOCUMENTS
-- Metadata level dokumen (1 baris = 1 IK/SOP)
-- ============================================================
create table documents (
  id uuid primary key default uuid_generate_v4(),
  nomor_ik text not null unique,          -- misal: IKPD-306-14.2.1.4.a.h-005
  judul text not null,                    -- misal: Pengoperasian Free Governor
  unit text not null default '1',         -- '1' atau '2' (MVP: hanya unit 1)
  lokasi text not null default 'SPH',     -- kode lokasi, siap untuk PLTA lain di masa depan
  status_dokumen text not null default 'resmi'
    check (status_dokumen in ('resmi', 'percobaan_fixed')),
    -- 'resmi'          = dokumen resmi kantor, belum direvisi
    -- 'percobaan_fixed'= versi hasil perbaikan typo/error untuk keperluan proyek percobaan,
    --                    BELUM menggantikan dokumen resmi kantor
  revisi text,                            -- nomor revisi dari dokumen asli, kalau ada
  tanggal_revisi date,                    -- nullable, kalau tidak tercantum di dokumen
  file_asli_link text,                    -- opsional, referensi ke file asal (drive/sharepoint dll)
  metadata jsonb default '{}'::jsonb,     -- cadangan untuk field masa depan tanpa migrasi skema
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table documents is 'Metadata tiap dokumen IK/SOP sumber knowledge base';
comment on column documents.status_dokumen is 'Pembeda dokumen resmi kantor vs versi perbaikan untuk keperluan proyek percobaan';

-- ============================================================
-- 2. TABEL CHUNKS
-- Potongan teks siap-embed, 1 dokumen bisa punya banyak chunk
-- ============================================================
create table chunks (
  id uuid primary key default uuid_generate_v4(),
  chunk_id text not null unique,           -- misal: IKPD-306-14.2.1.4.b.f-002-003
  document_id uuid not null references documents(id) on delete cascade,
  source_doc text not null,                -- nomor_ik, disimpan juga di sini untuk kemudahan query/debug
  judul text not null,                     -- judul dokumen (redundant tapi memudahkan tampilan hasil retrieval)
  section_type text not null default 'prosedur'
    check (section_type in ('referensi', 'prosedur')),
    -- MVP: simpel dulu. Kalau nanti mau lebih detail
    -- (persiapan/pelaksanaan/tindakan_akhir/risiko/dst),
    -- tinggal tambah value baru di sini + isi kolom metadata di bawah,
    -- TIDAK perlu migrasi skema.
  label text not null,                     -- nama section, misal "Sumber Daya (SDM & Alat)"
  text text not null,                      -- isi teks chunk (yang akan di-embed & ditampilkan sbg konteks)
  embedding vector(1024),                  -- dimensi untuk Voyage voyage-4-lite (default 1024, Matryoshka s.d 2048)
                                            -- SESUAIKAN dimensi ini kalau ganti model embedding
  metadata jsonb default '{}'::jsonb,      -- cadangan: sub-section detail, tag tambahan, dst (scalability)
  created_at timestamptz not null default now()
);

comment on table chunks is 'Potongan teks IK/SOP siap-embed untuk retrieval RAG';
comment on column chunks.metadata is 'Cadangan untuk detail section_type granular di masa depan (persiapan/pelaksanaan/dst) tanpa migrasi skema';

-- Index untuk filter cepat per dokumen & lokasi/unit (via join)
create index idx_chunks_document_id on chunks(document_id);
create index idx_chunks_section_type on chunks(section_type);

-- Index vector similarity search
-- Catatan: index ivfflat baru efektif kalau data sudah > ~100 baris.
-- Untuk 53 chunk saat ini, index ini boleh dibuat tapi belum banyak berpengaruh ke performa.
create index idx_chunks_embedding on chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ============================================================
-- 3. TABEL CHAT_SESSIONS
-- 1 baris = 1 sesi tanya-jawab operator
-- ============================================================
create table chat_sessions (
  id uuid primary key default uuid_generate_v4(),
  operator_name text,                      -- opsional, bisa diisi manual atau dari auth nanti
  unit text not null default '1',          -- unit yang dipilih manual di awal sesi
  lokasi text not null default 'SPH',      -- lokasi yang dipilih manual di awal sesi
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

comment on table chat_sessions is 'Sesi chat operator dengan AI, mencatat pilihan unit/lokasi manual di awal sesi';

-- ============================================================
-- 4. TABEL CHAT_MESSAGES
-- Riwayat chat per sesi, termasuk jejak audit trail chunk yang diambil
-- ============================================================
create table chat_messages (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('operator', 'ai')),
  content text not null,
  retrieved_chunk_ids text[],              -- array chunk_id yang diambil untuk jawaban ini (audit trail)
  created_at timestamptz not null default now()
);

comment on table chat_messages is 'Riwayat percakapan, retrieved_chunk_ids untuk audit trail & konteks lanjutan troubleshooting';

create index idx_chat_messages_session_id on chat_messages(session_id);

-- ============================================================
-- 5. FUNCTION match_chunks()
-- Pencarian similarity vector, difilter per lokasi & unit
-- ============================================================
create or replace function match_chunks(
  query_embedding vector(1024),
  match_lokasi text,
  match_unit text,
  match_count int default 5
)
returns table (
  chunk_id text,
  source_doc text,
  judul text,
  section_type text,
  label text,
  text text,
  similarity float
)
language sql stable
as $$
  select
    c.chunk_id,
    c.source_doc,
    c.judul,
    c.section_type,
    c.label,
    c.text,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where d.lokasi = match_lokasi
    and d.unit = match_unit
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

comment on function match_chunks is 'Similarity search chunk, difilter per lokasi & unit yang dipilih operator secara manual';

-- ============================================================
-- CATATAN PENTING
-- ============================================================
-- 1. Dimensi vector(1024) harus SAMA dengan dimensi output model embedding
--    yang dipakai (saat ini: Voyage voyage-4-lite). Kalau ganti model,
--    sesuaikan dimensi di kolom `embedding` (tabel chunks) DAN
--    parameter `query_embedding` di function match_chunks().
--
-- 2. Index ivfflat butuh data representatif untuk "lists" yang dipilih.
--    Dengan hanya 53 chunk (5 dokumen), index ini belum terlalu berguna,
--    tapi tidak masalah dibuat dari awal karena struktur sudah scalable
--    untuk saat data bertambah (unit 2, dokumen lain, dll).
--
-- 3. status_dokumen = 'percobaan_fixed' dipakai khusus untuk dokumen yang
--    sudah diperbaiki (misal 005 - Free Governor) tapi BELUM menggantikan
--    dokumen resmi kantor. Ini penting untuk transparansi kalau proyek
--    ini suatu saat masuk ke jalur resmi/produksi.
-- ============================================================
