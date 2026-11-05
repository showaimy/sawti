// Small helpers shared by the page: text splitting and WAV encoding.

// Split long scripts on sentence ends (Arabic and Latin punctuation) and line breaks.
export function splitText(text, max = 220) {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?؟؛\n])\s+/u).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length <= max) { cur = (cur + ' ' + s).trim(); continue; }
    if (cur) chunks.push(cur);
    if (s.length <= max) { cur = s; continue; }
    // very long sentence: break on commas, then on spaces
    let rest = s;
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf('،', max), rest.lastIndexOf(',', max));
      if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    cur = rest;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function encodeWav(samples, sampleRate) {
  // normalise peak to avoid clipping
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 0 ? Math.min(1 / peak, 4) * 0.95 : 1;
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Older versions of the site stored model files in the browser (up to ~1.5 GB). Free that space.
export async function cleanupOldDownloads() {
  try {
    for (const name of ['transformers-cache', 'sawt-voices-v1', 'sawt-samples-v1', 'sawt-samples-v2']) await caches.delete(name);
  } catch { /* caches not available */ }
}
