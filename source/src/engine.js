// Text-to-speech engine that runs entirely in the browser.
// Piper voices (MIT) + espeak-ng phonemizer (WASM) + ONNX Runtime Web.
import * as ort from 'onnxruntime-web/wasm';
import { createPiperPhonemize } from './vendor/piper_phonemize.js';

const BASE = import.meta.env.BASE_URL;
const WASM_DIR = new URL(`${BASE}wasm/`, document.baseURI).href;
const VOICE_HOST = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const CACHE_NAME = 'sawt-voices-v1';

ort.env.wasm.numThreads = 1; // works on any static host (no special headers needed)
ort.env.wasm.wasmPaths = WASM_DIR;

export const VOICES = [
  { id: 'ar_JO-kareem-medium', name: 'كريم', lang: 'ar', langLabel: 'عربي', gender: 'رجل', quality: 'جودة أعلى', sizeMb: 60, path: 'ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx' },
  { id: 'en_US-hfc_female-medium', name: 'Hannah', lang: 'en', langLabel: 'إنجليزي أمريكي', gender: 'امرأة', quality: 'جودة أعلى', sizeMb: 60, path: 'en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx' },
  { id: 'en_US-hfc_male-medium', name: 'Henry', lang: 'en', langLabel: 'إنجليزي أمريكي', gender: 'رجل', quality: 'جودة أعلى', sizeMb: 60, path: 'en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx' },
  { id: 'en_US-lessac-medium', name: 'Lessac', lang: 'en', langLabel: 'إنجليزي أمريكي', gender: 'امرأة', quality: 'جودة أعلى', sizeMb: 60, path: 'en/en_US/lessac/medium/en_US-lessac-medium.onnx' },
  { id: 'en_US-ryan-medium', name: 'Ryan', lang: 'en', langLabel: 'إنجليزي أمريكي', gender: 'رجل', quality: 'جودة أعلى', sizeMb: 60, path: 'en/en_US/ryan/medium/en_US-ryan-medium.onnx' },
  { id: 'en_GB-alba-medium', name: 'Alba', lang: 'en', langLabel: 'إنجليزي بريطاني', gender: 'امرأة', quality: 'جودة أعلى', sizeMb: 60, path: 'en/en_GB/alba/medium/en_GB-alba-medium.onnx' },
  { id: 'en_GB-alan-medium', name: 'Alan', lang: 'en', langLabel: 'إنجليزي بريطاني', gender: 'رجل', quality: 'جودة أعلى', sizeMb: 60, path: 'en/en_GB/alan/medium/en_GB-alan-medium.onnx' },
];

export const voiceById = (id) => VOICES.find((v) => v.id === id);

// ---------- model download + cache ----------
async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`تعذّر تنزيل ملف الصوت (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return new Response(await res.arrayBuffer(), { headers: res.headers });
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  return new Response(new Blob(parts), { headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream' } });
}

async function getFile(url, onProgress) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit;
  }
  const res = await fetchWithProgress(url, onProgress);
  if (cache) { try { await cache.put(url, res.clone()); } catch { /* storage full or blocked */ } }
  return res;
}

export async function isDownloaded(voice) {
  const cache = await openCache();
  if (!cache) return false;
  return !!(await cache.match(`${VOICE_HOST}/${voice.path}`));
}

export async function removeVoice(voice) {
  const cache = await openCache();
  if (!cache) return;
  await cache.delete(`${VOICE_HOST}/${voice.path}`);
  await cache.delete(`${VOICE_HOST}/${voice.path}.json`);
  if (loaded?.id === voice.id) loaded = null;
}

// ---------- session ----------
let loaded = null; // { id, config, session }

async function loadVoice(voice, onProgress) {
  if (loaded?.id === voice.id) return loaded;
  const cfgRes = await getFile(`${VOICE_HOST}/${voice.path}.json`);
  const config = await cfgRes.json();
  const modelRes = await getFile(`${VOICE_HOST}/${voice.path}`, (l, t) => onProgress?.({ stage: 'download', loaded: l, total: t }));
  onProgress?.({ stage: 'prepare' });
  const session = await ort.InferenceSession.create(await modelRes.arrayBuffer(), { executionProviders: ['wasm'] });
  loaded = { id: voice.id, config, session };
  return loaded;
}

// ---------- text -> phoneme ids ----------
function phonemize(text, espeakVoice) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify([{ text }]);
    createPiperPhonemize({
      print: (data) => { try { resolve(JSON.parse(data).phoneme_ids); } catch (e) { reject(e); } },
      printErr: (msg) => reject(new Error(msg)),
      locateFile: (file) => (file.endsWith('.wasm') ? `${WASM_DIR}piper_phonemize.wasm` : file.endsWith('.data') ? `${WASM_DIR}piper_phonemize.data` : file),
    }).then((mod) => {
      mod.callMain(['-l', espeakVoice, '--input', input, '--espeak_data', '/espeak-ng-data']);
    }).catch(reject);
  });
}

// Split long scripts on sentence ends (Arabic and Latin punctuation) and line breaks.
export function splitText(text, max = 350) {
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

// ---------- synthesis ----------
/**
 * @param {{text:string, voiceId:string, speed:number, pauseMs:number}} opts
 * @param {(p:{stage:string, loaded?:number, total?:number, index?:number, count?:number})=>void} onProgress
 * @returns {Promise<{blob:Blob, seconds:number}>}
 */
export async function synthesize({ text, voiceId, speed = 1, pauseMs = 250 }, onProgress) {
  const voice = voiceById(voiceId);
  if (!voice) throw new Error('الصوت غير موجود');
  const chunks = splitText(text);
  if (!chunks.length) throw new Error('اكتب نصاً أولاً');
  const { config, session } = await loadVoice(voice, onProgress);
  const sr = config.audio.sample_rate;
  const inf = config.inference;
  const lengthScale = inf.length_scale / Math.min(Math.max(speed, 0.5), 2);
  const gap = new Float32Array(Math.round((sr * pauseMs) / 1000));
  const pcms = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ stage: 'speak', index: i + 1, count: chunks.length });
    const ids = await phonemize(chunks[i], config.espeak.voice);
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale, lengthScale, inf.noise_w]), [3]),
    };
    if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const out = await session.run(feeds);
    pcms.push(out.output.data);
    if (i < chunks.length - 1) pcms.push(gap);
  }
  const total = pcms.reduce((n, p) => n + p.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const p of pcms) { merged.set(p, off); off += p.length; }
  return { blob: encodeWav(merged, sr), seconds: total / sr, samples: merged, sampleRate: sr };
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

// Exposed for self-test: confirms the phonemizer works offline for a language.
export const _phonemize = phonemize;

export function resample(samples, from, to) {
  if (from === to) return samples;
  const out = new Float32Array(Math.round(samples.length * to / from));
  const r = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * r, j = Math.floor(x), f = x - j;
    out[i] = (samples[j] || 0) * (1 - f) + (samples[j + 1] || 0) * f;
  }
  return out;
}
