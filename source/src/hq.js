// Main-thread client for the high-quality (Chatterbox) worker.
import { encodeWav, synthesize as fastSynthesize, resample } from './engine.js';
import { decodeToMono, tidyClip } from './audio.js';

export const HQ_LANGUAGES = [
  ['ar', 'العربية'], ['en', 'الإنجليزية'], ['fr', 'الفرنسية'], ['es', 'الإسبانية'], ['de', 'الألمانية'],
  ['it', 'الإيطالية'], ['pt', 'البرتغالية'], ['tr', 'التركية'], ['hi', 'الهندية'], ['ru', 'الروسية'],
  ['zh', 'الصينية'], ['ja', 'اليابانية'], ['ko', 'الكورية'], ['nl', 'الهولندية'], ['pl', 'البولندية'],
  ['sv', 'السويدية'], ['da', 'الدنماركية'], ['no', 'النرويجية'], ['fi', 'الفنلندية'], ['el', 'اليونانية'],
  ['he', 'العبرية'], ['ms', 'الماليزية'], ['sw', 'السواحيلية'],
];

const DEFAULT_VOICE_URL = 'https://huggingface.co/onnx-community/chatterbox-multilingual-ONNX/resolve/main/default_voice.wav';
export const DEFAULT_VOICE = { id: 'hq-default', name: 'الصوت الافتراضي', desc: 'صوت النموذج الأساسي', builtin: true };

// Ready-made voices. Each one takes its sound from an open Piper voice (MIT): the browser reads a short
// passage with it once, and Chatterbox then speaks any of the 23 languages in that voice.
const REF_AR = 'السلامُ عليكم ورحمةُ الله. أهلاً وسهلاً بكم. اليومَ نتحدّثُ عن أهميةِ التخطيطِ الجيّد، وكيف يساعدُنا على إنجازِ أعمالِنا بهدوءٍ ووضوح. خذوا وقتَكم، واستمتعوا بالرحلة.';
const REF_EN = 'Hello, and welcome. Today we are talking about the value of good planning, and how it helps us finish our work calmly and clearly. Take your time, breathe, and enjoy the journey ahead of you.';
export const PRESETS = [
  { id: 'hq-p-kareem', name: 'كريم', desc: 'رجل · نبرة عربية', piper: 'ar_JO-kareem-medium', ref: REF_AR },
  { id: 'hq-p-hannah', name: 'هانا', desc: 'امرأة · نبرة أمريكية', piper: 'en_US-hfc_female-medium', ref: REF_EN },
  { id: 'hq-p-henry', name: 'هنري', desc: 'رجل · نبرة أمريكية', piper: 'en_US-hfc_male-medium', ref: REF_EN },
  { id: 'hq-p-lessac', name: 'لينا', desc: 'امرأة · نبرة هادئة', piper: 'en_US-lessac-medium', ref: REF_EN },
  { id: 'hq-p-ryan', name: 'رايان', desc: 'رجل · نبرة واضحة', piper: 'en_US-ryan-medium', ref: REF_EN },
  { id: 'hq-p-alba', name: 'ألبا', desc: 'امرأة · نبرة بريطانية', piper: 'en_GB-alba-medium', ref: REF_EN },
  { id: 'hq-p-alan', name: 'آلن', desc: 'رجل · نبرة بريطانية', piper: 'en_GB-alan-medium', ref: REF_EN },
];
const presetAudio = new Map();
async function loadPresetAudio(p, onProgress) {
  if (presetAudio.has(p.id)) return presetAudio.get(p.id);
  onProgress?.({ stage: 'voice' });
  const { samples, sampleRate } = await fastSynthesize({ text: p.ref, voiceId: p.piper, speed: 1, pauseMs: 300 }, (x) => {
    if (x.stage === 'download') onProgress?.({ ...x, stage: 'voice-download' });
  });
  const clip = tidyClip(resample(samples, sampleRate, 24000));
  presetAudio.set(p.id, clip);
  return clip;
}

// ---------- remote server (Modal) ----------
export const SERVER_URL = 'https://showaimy--sawti.us-east.modal.run';
const server = { enabled: false, password: '' };
try { Object.assign(server, JSON.parse(localStorage.getItem('sawt.server') || '{}')); } catch { /* ignore */ }
export function getServer() { return { ...server }; }
export function setServer(patch) {
  Object.assign(server, patch);
  try { localStorage.setItem('sawt.server', JSON.stringify(server)); } catch { /* ignore */ }
}
export const serverActive = () => server.enabled && !!server.password;

async function fetchWithTimeout(url, opts = {}, ms = 240000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

/** Checks the password; also wakes the GPU up. */
export async function serverCheck(password = server.password) {
  let res;
  try {
    res = await fetchWithTimeout(`${SERVER_URL}/check`, { headers: { Authorization: `Bearer ${password}` } }, 180000);
  } catch {
    throw new Error('SERVER_UNREACHABLE');
  }
  if (res.status === 401) throw new Error('SERVER_BAD_PASSWORD');
  if (!res.ok) throw new Error(`SERVER_ERROR ${res.status}`);
  return true;
}

function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}

async function serverSynthesize({ chunks, language, voice, exaggeration }, onProgress) {
  const preset = PRESETS.find((p) => p.id === voice.id);
  let ref = null;
  if (voice.id !== DEFAULT_VOICE.id) {
    const samples = preset ? await loadPresetAudio(preset, onProgress) : voice.samples;
    const wav = await encodeWav(samples, 24000).arrayBuffer();
    ref = toBase64(new Uint8Array(wav));
  }
  onProgress?.({ stage: 'server', count: chunks.length });
  let res;
  try {
    res = await fetchWithTimeout(`${SERVER_URL}/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.password}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunks, language, exaggeration, ref_audio: ref }),
    }, 600000);
  } catch {
    throw new Error('SERVER_UNREACHABLE');
  }
  if (res.status === 401) throw new Error('SERVER_BAD_PASSWORD');
  if (res.status === 413) throw new Error('SERVER_TOO_LONG');
  if (!res.ok) throw new Error(`SERVER_ERROR ${res.status}`);
  const blob = await res.blob();
  const seconds = Number(res.headers.get('X-Audio-Seconds')) || 0;
  return { blob: new Blob([blob], { type: 'audio/wav' }), seconds };
}

let worker = null;
let seq = 0;
const pending = new Map();
let defaultAudio = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./hq.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id) || [...pending.values()][0];
    if (!p) return;
    if (m.type === 'progress') p.onProgress?.(m);
    else if (m.type === 'done') { pending.delete(m.id); p.resolve(m); }
    else if (m.type === 'ready') { pending.delete(m.id); p.resolve(m); }
    else if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.message)); }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'تعطّل المحرك'));
    pending.clear();
    worker = null;
  };
  return worker;
}

export async function hqSupport() {
  if (serverActive()) return { ok: true, server: true };
  if (!('gpu' in navigator)) return { ok: false, reason: 'متصفحك ما يدعم WebGPU. استخدم Chrome أو Edge على كمبيوتر.' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'ما لقيت كرت شاشة يدعم WebGPU على هذا الجهاز.' };
  } catch { return { ok: false, reason: 'تعذّر تشغيل WebGPU على هذا الجهاز.' }; }
  if (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) return { ok: false, reason: 'المحرك عالي الجودة يحتاج كمبيوتر. على الجوال استخدم الأصوات السريعة.' };
  return { ok: true };
}

async function loadDefaultAudio() {
  if (defaultAudio) return defaultAudio;
  let res;
  try {
    const cache = await caches.open('sawt-voices-v1');
    res = await cache.match(DEFAULT_VOICE_URL);
    if (!res) { res = await fetch(DEFAULT_VOICE_URL); if (res.ok) await cache.put(DEFAULT_VOICE_URL, res.clone()); }
  } catch { res = await fetch(DEFAULT_VOICE_URL); }
  if (!res.ok) throw new Error('تعذّر تنزيل الصوت الافتراضي');
  defaultAudio = tidyClip(await decodeToMono(await res.arrayBuffer()));
  return defaultAudio;
}

function call(msg, transfer, onProgress) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

/**
 * @param {{chunks:string[], language:string, voice:{id:string, samples?:Float32Array}, exaggeration:number}} o
 */
export async function hqSynthesize({ chunks, language, voice, exaggeration }, onProgress) {
  if (serverActive()) return serverSynthesize({ chunks, language, voice, exaggeration }, onProgress);
  const preset = PRESETS.find((p) => p.id === voice.id);
  const audio = voice.id === DEFAULT_VOICE.id ? await loadDefaultAudio() : preset ? await loadPresetAudio(preset, onProgress) : voice.samples;
  if (!audio?.length) throw new Error('ملف الصوت فاضي');
  const copy = audio.slice();
  const { samples, sampleRate } = await call(
    { type: 'synth', chunks, language, voiceKey: voice.id, audio: copy, exaggeration },
    [copy.buffer],
    onProgress,
  );
  return { blob: encodeWav(samples, sampleRate), seconds: samples.length / sampleRate };
}

export function hqForget(voiceId) { worker?.postMessage({ type: 'forget', voiceKey: voiceId }); }
