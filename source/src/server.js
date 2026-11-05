// Client for the voice server on Modal. All voice generation happens there; nothing is downloaded to the device.
import { encodeWav } from './utils.js';

export const SERVER_URL = 'https://showaimy--sawti.us-east.modal.run';

export const LANGUAGES = [
  ['ar', 'العربية'], ['en', 'الإنجليزية'], ['fr', 'الفرنسية'], ['es', 'الإسبانية'], ['de', 'الألمانية'],
  ['it', 'الإيطالية'], ['pt', 'البرتغالية'], ['tr', 'التركية'], ['hi', 'الهندية'], ['ru', 'الروسية'],
  ['zh', 'الصينية'], ['ja', 'اليابانية'], ['ko', 'الكورية'], ['nl', 'الهولندية'], ['pl', 'البولندية'],
  ['sv', 'السويدية'], ['da', 'الدنماركية'], ['no', 'النرويجية'], ['fi', 'الفنلندية'], ['el', 'اليونانية'],
  ['he', 'العبرية'], ['ms', 'الماليزية'], ['sw', 'السواحيلية'],
];

export const DEFAULT_VOICE = { id: 'hq-default', name: 'الصوت الافتراضي', desc: 'صوت النموذج الأساسي' };

// Ready-made voices live on the server (built there from open Piper voices). Ids match server/app.py.
export const PRESETS = [
  { id: 'hq-p-kareem', name: 'كريم', desc: 'رجل · نبرة عربية' },
  { id: 'hq-p-hannah', name: 'هانا', desc: 'امرأة · نبرة أمريكية' },
  { id: 'hq-p-henry', name: 'هنري', desc: 'رجل · نبرة أمريكية' },
  { id: 'hq-p-lessac', name: 'لينا', desc: 'امرأة · نبرة هادئة' },
  { id: 'hq-p-ryan', name: 'رايان', desc: 'رجل · نبرة واضحة' },
  { id: 'hq-p-alba', name: 'ألبا', desc: 'امرأة · نبرة بريطانية' },
  { id: 'hq-p-alan', name: 'آلن', desc: 'رجل · نبرة بريطانية' },
];

// ---------- password ----------
const STORE = 'sawt.server';
let password = '';
try { password = JSON.parse(localStorage.getItem(STORE) || '{}').password || ''; } catch { /* ignore */ }
export const isConnected = () => !!password;
function savePassword(pw) {
  password = pw;
  try { localStorage.setItem(STORE, JSON.stringify({ password: pw })); } catch { /* ignore */ }
}
export function disconnect() { savePassword(''); }

// Any characters work in the password (Arabic too): headers only carry Latin-1, so it is URL-encoded.
const authHeader = (pw = password) => ({ Authorization: `Bearer ${encodeURIComponent(String(pw).trim())}` });

async function request(path, opts = {}, ms = 240000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  let res;
  try {
    res = await fetch(`${SERVER_URL}${path}`, { ...opts, headers: { ...authHeader(opts.password), ...(opts.headers || {}) }, signal: ctl.signal });
  } catch {
    throw new Error('SERVER_UNREACHABLE');
  } finally {
    clearTimeout(t);
  }
  if (res.status === 401) throw new Error('SERVER_BAD_PASSWORD');
  return res;
}

let serverInfo = null; // { presets: [...] } from /check

/** Checks the password and wakes the GPU up. Saves the password if it is right. */
export async function connect(pw = password) {
  const res = await request('/check', { password: pw }, 180000);
  if (!res.ok) throw new Error(`SERVER_ERROR ${res.status}`);
  try { serverInfo = await res.json(); } catch { serverInfo = { presets: [] }; }
  savePassword(String(pw).trim());
  return serverInfo;
}

// ---------- audio helpers ----------
function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}

// 16-bit PCM WAV -> Float32 samples
function parseWav(buf) {
  const v = new DataView(buf);
  let off = 12, rate = 24000, data = null;
  while (off + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') rate = v.getUint32(off + 12, true);
    if (id === 'data') { data = new Int16Array(buf.slice(off + 8, off + 8 + Math.min(size, v.byteLength - off - 8))); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error('SERVER_ERROR bad audio');
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / 32768;
  return { samples: out, rate };
}

// ---------- voices ----------
// A custom voice is uploaded once; the server keeps it and we remember its key.
const KEY_STORE = 'sawt.serverVoiceKeys';
function savedKeys() { try { return JSON.parse(localStorage.getItem(KEY_STORE) || '{}'); } catch { return {}; } }
function saveKey(id, key) {
  try { const k = savedKeys(); if (key) k[id] = key; else delete k[id]; localStorage.setItem(KEY_STORE, JSON.stringify(k)); } catch { /* ignore */ }
}
export function forgetVoice(id) { saveKey(id, null); }

async function uploadVoice(voice, onProgress) {
  if (!voice.samples?.length) throw new Error('ملف الصوت فاضي');
  onProgress?.({ stage: 'upload' });
  const wav = new Uint8Array(await encodeWav(voice.samples, 24000).arrayBuffer());
  const res = await request('/voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref_audio: toBase64(wav) }),
  }, 180000);
  if (!res.ok) throw new Error(`SERVER_ERROR ${res.status}`);
  const { voice_key: key } = await res.json();
  saveKey(voice.id, key);
  return key;
}

async function voiceKeyFor(voice, onProgress) {
  if (voice.id === DEFAULT_VOICE.id) return 'default';
  if (PRESETS.some((p) => p.id === voice.id)) return voice.id;
  return savedKeys()[voice.id] || uploadVoice(voice, onProgress);
}

/**
 * Generates speech on the server, one sentence group per request.
 * @param {{chunks:string[], language:string, voice:object, exaggeration:number}} o
 */
export async function synthesize({ chunks, language, voice, exaggeration }, onProgress) {
  if (!password) throw new Error('SERVER_NOT_CONNECTED');
  let key = await voiceKeyFor(voice, onProgress);
  const parts = [];
  let rate = 24000;
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ stage: 'speak', index: i + 1, count: chunks.length });
    const send = () => request('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunks[i], language, exaggeration, voice_key: key }),
    });
    let res = await send();
    if (res.status === 404) {
      if (!voice.samples) throw new Error('SERVER_VOICE_MISSING');
      // the server lost this custom voice: send it again once
      saveKey(voice.id, null);
      key = await uploadVoice(voice, onProgress);
      res = await send();
    }
    if (res.status === 413) throw new Error('SERVER_TOO_LONG');
    if (!res.ok) throw new Error(`SERVER_ERROR ${res.status}`);
    const wav = parseWav(await res.arrayBuffer());
    rate = wav.rate;
    parts.push(wav.samples);
    if (i < chunks.length - 1) parts.push(new Float32Array(Math.round(rate * 0.22)));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.length; }
  return { blob: encodeWav(merged, rate), seconds: total / rate };
}
