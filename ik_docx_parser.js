/**
 * ik_docx_parser.js
 *
 * Port dari parse_sop.py + chunk_sop.py (dulu Python + python-docx, dijalankan terpisah
 * dari aplikasi web) ke JS murni, supaya proses "upload file .docx -> auto parsing ->
 * auto chunking" bisa dilakukan langsung dari server Express (admin_routes.js).
 *
 * SENGAJA TANPA DEPENDENSI NPM TAMBAHAN (tidak pakai mammoth/node-html-parser/dsb) --
 * cuma pakai built-in Node (`zlib`, `buffer`). Alasan: supaya tidak menambah risiko
 * "npm install gagal di Termux" (lihat catatan Termux di HANDOVER.md), dan supaya
 * hasil parsing sedekat mungkin dengan versi Python (baca XML docx langsung, bukan
 * lewat konversi HTML perantara yang bisa mengubah struktur).
 *
 * .docx sebenarnya adalah file ZIP berisi XML. Modul ini:
 * 1. Membaca ZIP secara manual (readZipEntry) untuk mengambil isi "word/document.xml".
 * 2. Menelusuri XML itu ala python-docx: elemen <w:p> (paragraf) dan <w:tbl> (tabel)
 *    yang jadi ANAK LANGSUNG <w:body>, sesuai urutan dokumen (getDirectChildren).
 * 3. Menjalankan heuristik section-matching & chunking yang SAMA PERSIS dengan
 *    parse_sop.py + chunk_sop.py.
 *
 * KETERBATASAN yang perlu diketahui (supaya hasil auto-chunk tetap harus direview manual
 * di halaman admin sebelum disimpan permanen, bukan langsung dipercaya 100%):
 * - Tabel bersarang (tabel di dalam tabel) tidak didukung -- jarang terjadi di dokumen IK.
 * - Formatting kompleks (footnote, text box, dsb) diabaikan, cuma teks isi paragraf/tabel biasa.
 * - Nomor style Word otomatis (auto-numbering "1.", "a)", dst yang di-generate Word, bukan
 *   diketik manual) tidak ikut terbaca sebagai teks -- sama seperti keterbatasan python-docx asli.
 *
 * Fungsi utama: parseDocxToChunks(buffer, fallbackName) -> { metadata, sections, chunks }
 * Murni proses teks lokal, TIDAK ada panggilan API (tidak ada embedding di sini) -- cepat,
 * selesai dalam hitungan detik walau dokumennya panjang.
 */

const zlib = require('zlib');

// ============================================================
// BAGIAN 1: BACA FILE ZIP (.docx) SECARA MANUAL
// ============================================================

function readZipEntry(buffer, entryName) {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  let eocdOffset = -1;
  const searchStart = Math.max(0, buffer.length - 22 - 65536);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) {
    throw new Error('File bukan .docx/ZIP yang valid (End Of Central Directory tidak ditemukan).');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16); // offset awal central directory

  for (let i = 0; i < totalEntries; i++) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== CD_SIG) throw new Error('Central directory .docx tidak valid/rusak.');

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength);

    if (fileName === entryName) {
      const lfhSig = buffer.readUInt32LE(localHeaderOffset);
      if (lfhSig !== LFH_SIG) throw new Error(`Local file header untuk "${entryName}" tidak valid.`);
      const lfhNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const lfhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      const rawData = buffer.slice(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) return rawData; // stored, tanpa kompresi
      if (compressionMethod === 8) return zlib.inflateRawSync(rawData); // deflate (paling umum)
      throw new Error(`Metode kompresi ZIP (${compressionMethod}) tidak didukung untuk "${entryName}".`);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`Bagian "${entryName}" tidak ditemukan di dalam file .docx ini (file mungkin rusak atau bukan .docx yang valid).`);
}

// ============================================================
// BAGIAN 2: TELUSURI XML (word/document.xml) ALA python-docx
// ============================================================

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

// Ambil daftar elemen yang jadi ANAK LANGSUNG dari fragment XML yang diberikan
// (tidak peduli nama tag-nya, cukup berdasar level nesting menggunakan stack).
function getDirectChildren(xml) {
  const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)([^>]*)>/g;
  const children = [];
  const stack = [];
  let m;

  while ((m = tagRe.exec(xml))) {
    const closing = m[1] === '/';
    const name = m[2];
    const attrPart = m[3] || '';
    const selfClosing = /\/\s*$/.test(attrPart);

    if (closing) {
      if (stack.length === 0) continue; // tag penutup nyasar, abaikan
      const frame = stack.pop();
      if (frame.topLevel) {
        children.push({ name: frame.name, content: xml.slice(frame.contentStart, m.index) });
      }
    } else if (selfClosing) {
      if (stack.length === 0) children.push({ name, content: '' });
      // kalau bersarang & self-closing, tidak mempengaruhi stack, diabaikan di sini
    } else {
      stack.push({
        name,
        contentStart: m.index + m[0].length,
        topLevel: stack.length === 0,
      });
    }
  }

  return children;
}

// Ambil semua teks <w:t> di dalam sebuah fragment (berapa pun kedalamannya) --
// menyamai perilaku `paragraph.text` / `cell.text` di python-docx.
function extractRunText(xmlFragment) {
  let text = '';
  // Perhatikan `<w:t(?:\s[^>]*)?>` (bukan `<w:t[^>]*>`) -- "w:t" adalah AWALAN dari banyak
  // tag lain di docx (w:tcW, w:tcPr, w:tblW, dst). Kalau pola regexnya cuma `<w:t[^>]*>`,
  // tag-tag itu ikut kepencet ketangkep seolah-olah pembuka <w:t>, dan isinya (termasuk XML
  // mentah di antaranya) ikut ke-scrape jadi teks. Versi ini mewajibkan setelah "w:t" langsung
  // '>' (tanpa atribut) atau spasi (baru diikuti atribut), jadi hanya <w:t> yang benar-benar cocok.
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/?>/g;
  let m;
  while ((m = re.exec(xmlFragment))) {
    if (m[1] !== undefined) text += decodeXmlEntities(m[1]);
    else if (m[0].indexOf('w:tab') !== -1) text += '\t';
    else text += '\n';
  }
  return text;
}

function tableToText(tblContent) {
  const rows = getDirectChildren(tblContent).filter((c) => c.name === 'w:tr');
  const rowsText = [];
  for (const row of rows) {
    const cells = getDirectChildren(row.content).filter((c) => c.name === 'w:tc');
    const cellTexts = cells.map((c) => extractRunText(c.content).replace(/\s+/g, ' ').trim());
    if (cellTexts.some((t) => t)) rowsText.push(cellTexts.join(' | '));
  }
  return rowsText.join('\n');
}

// Hasil: daftar block berurutan sesuai urutan dokumen, mirip iter_block_items() di parse_sop.py
// (yang membaca langsung dari <w:body>, jadi otomatis melewati header/footer docx yang
// tersimpan di bagian XML terpisah, bukan di word/document.xml).
function documentXmlToBlocks(xml) {
  const bodyMatch = xml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
  const bodyContent = bodyMatch ? bodyMatch[1] : xml;

  const topLevel = getDirectChildren(bodyContent).filter((c) => c.name === 'w:p' || c.name === 'w:tbl');
  const blocks = [];

  for (const el of topLevel) {
    if (el.name === 'w:p') {
      const raw = extractRunText(el.content).trim();
      if (raw) blocks.push({ type: 'p', text: raw });
    } else {
      const txt = tableToText(el.content);
      if (txt) blocks.push({ type: 'table', text: txt });
    }
  }

  return blocks;
}

// ============================================================
// BAGIAN 3: SECTION-MATCHING + CHUNKING (port persis dari parse_sop.py & chunk_sop.py)
// ============================================================

const SECTION_PATTERNS = [
  [/^\s*Tujuan\s*$/i, 'tujuan'],
  [/^\s*Ruang\s*Lingkup\s*$/i, 'ruang_lingkup'],
  [/^\s*Definisi\s*$/i, 'definisi'],
  [/^\s*A\.?\s*Dokumen\s*Terkait/i, 'dokumen_terkait'],
  [/^\s*B\.?\s*Sumber\s*Daya/i, 'sumber_daya'],
  [/^\s*C\.?\s*Identifikasi\s*Risiko/i, 'identifikasi_risiko'],
  [/^\s*D\.?\s*Durasi/i, 'durasi_parameter'],
  [/^\s*(E\.?\s*)?(Detail\s*Aktivitas|Deskripsi)\s*/i, 'aktivitas_header'],
  [/^\s*(E\.?\s*)?PERSIAPAN\s*$/i, 'persiapan'],
  [/^\s*F\.?\s*PELAKSANAAN\s*$/i, 'pelaksanaan'],
  [/^\s*PELAKSANAAN\s*$/i, 'pelaksanaan'],
  [/^\s*(G\.?\s*)?TINDAKAN\s*AKHIR\s*$/i, 'tindakan_akhir'],
  [/^\s*LAMPIRAN\s*$/i, 'lampiran'],
  [/^\s*G\.?\s*Formulir\s*$/i, 'lampiran'],
];

function matchSection(text) {
  for (const [pat, key] of SECTION_PATTERNS) {
    if (pat.test(text)) return key;
  }
  return null;
}

function cleanText(t) {
  return t.replace(/\s+/g, ' ').trim();
}

function parseBlocksToSections(blocks) {
  const sections = { preamble: [] };
  let currentKey = 'preamble';

  for (const block of blocks) {
    if (block.type === 'p') {
      const raw = block.text;
      const key = matchSection(raw);
      if (key) {
        if (key === 'pelaksanaan' && !['persiapan', 'aktivitas_header'].includes(currentKey)) {
          if (!sections.persiapan) {
            sections.preamble.push(raw);
            continue;
          }
        }
        currentKey = key;
        if (!sections[currentKey]) sections[currentKey] = [];
        continue;
      }
      if (!sections[currentKey]) sections[currentKey] = [];
      sections[currentKey].push(cleanText(raw));
    } else {
      if (!sections[currentKey]) sections[currentKey] = [];
      sections[currentKey].push('[TABEL]\n' + block.text);
    }
  }

  return sections;
}

function buildMetadata(sections, fallbackName) {
  const preamble = (sections.preamble || []).join('\n');
  const docNoMatch = preamble.match(/IKPD-\s*\d+-\s*\d+\.\d+\.\d+\.\d+\.[a-h]\.[a-h]-\s*\d+/i);
  const nomor_dokumen = docNoMatch ? docNoMatch[0].replace(/\s+/g, '') : null;

  let judul = null;
  for (const line of sections.preamble || []) {
    const upper = line.toUpperCase();
    if (
      (upper.includes('PELAKSANAAN') || upper.includes('PENGOPERASIAN') || upper.includes('CHARGING') || upper.includes('RUNNING TEST')) &&
      line.length < 120 &&
      !judul
    ) {
      judul = line;
    }
  }

  return { nomor_dokumen, judul: judul || fallbackName || null };
}

const SUBSTEP_RE = /^[a-z]\.\s+/;

function splitProcedure(lines) {
  const chunks = [];
  let buf = [];
  let header = null;

  function flush() {
    if (buf.length) {
      const label = header || buf[0].slice(0, 60);
      chunks.push({ label, text: buf.join('\n') });
    }
  }

  for (const line of lines) {
    const isSubstep = SUBSTEP_RE.test(line);
    const isHeaderLine = line.replace(/\s+$/, '').endsWith(':') && !isSubstep;

    if (isSubstep) {
      flush(); buf = [line]; header = line;
    } else if (isHeaderLine && buf.length) {
      flush(); buf = [line]; header = line;
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

// Sama dengan build_chunks() di chunk_sop.py, ditambah 1 penyesuaian: section "Lampiran"
// (kalau ada teksnya di dokumen asli, bukan cuma foto) ikut dijadikan 1 chunk juga --
// supaya konsisten dengan card "Lampiran" yang sudah ada di halaman admin (versi Python
// lama melewati section ini karena waktu itu belum ada fitur foto lampiran).
function buildChunks(sections) {
  const out = [];

  const ringkasan = [];
  for (const key of ['tujuan', 'ruang_lingkup', 'definisi']) {
    ringkasan.push(...(sections[key] || []));
  }
  if (ringkasan.length) {
    out.push({ section_type: 'ringkasan', label: 'Tujuan / Ruang Lingkup / Definisi', text: ringkasan.join('\n').trim() });
  }

  const refMap = {
    dokumen_terkait: 'Dokumen Terkait',
    sumber_daya: 'Sumber Daya (SDM & Alat)',
    identifikasi_risiko: 'Identifikasi & Mitigasi Risiko (K3)',
    durasi_parameter: 'Durasi & Parameter Keberhasilan',
  };
  for (const [key, label] of Object.entries(refMap)) {
    const items = sections[key] || [];
    if (items.length) out.push({ section_type: 'referensi', label, text: items.join('\n').trim() });
  }

  let procLines = [...(sections.persiapan || []), ...(sections.pelaksanaan || [])];
  procLines = procLines.filter((l) => !l.startsWith('[TABEL]'));
  for (const sub of splitProcedure(procLines)) {
    out.push({ section_type: 'prosedur', label: sub.label.slice(0, 80), text: sub.text.trim() });
  }

  if (sections.tindakan_akhir && sections.tindakan_akhir.length) {
    out.push({ section_type: 'tindakan_akhir', label: 'Tindakan Akhir', text: sections.tindakan_akhir.join('\n').trim() });
  }

  if (sections.lampiran && sections.lampiran.length) {
    const lampiranText = sections.lampiran.filter((l) => !l.startsWith('[TABEL]')).join('\n').trim();
    if (lampiranText) out.push({ section_type: 'referensi', label: 'Lampiran', text: lampiranText });
  }

  return out.filter((c) => c.text);
}

/**
 * Fungsi utama dipanggil dari admin_routes.js.
 * @param {Buffer} buffer isi file .docx
 * @param {string} fallbackName nama file asli (dipakai kalau judul tidak terdeteksi)
 * @returns {{metadata: object, sections: object, chunks: Array}}
 */
function parseDocxToChunks(buffer, fallbackName) {
  const xmlBuffer = readZipEntry(buffer, 'word/document.xml');
  const xml = xmlBuffer.toString('utf8');
  const blocks = documentXmlToBlocks(xml);
  const sections = parseBlocksToSections(blocks);
  const metadata = buildMetadata(sections, fallbackName);
  const chunks = buildChunks(sections);
  return { metadata, sections, chunks };
}

module.exports = { parseDocxToChunks, matchSection, splitProcedure, buildMetadata, buildChunks, documentXmlToBlocks };
