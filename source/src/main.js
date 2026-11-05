import { VOICES as FAST_VOICES, voiceById as fastById, synthesize as fastSynthesize, isDownloaded, removeVoice, splitText, encodeWav } from './engine.js';
import { HQ_LANGUAGES, DEFAULT_VOICE, PRESETS, hqSupport, hqSynthesize, hqForget, getServer, setServer, serverActive, serverCheck } from './hq.js';
import { decodeToMono, tidyClip, Recorder } from './audio.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const els = {
  selectedVoice: $('selectedVoice'), script: $('script'), charCount: $('charCount'), sampleBtn: $('sampleBtn'), arHint: $('arHint'),
  language: $('language'), exaggeration: $('exaggeration'), exaggerationOut: $('exaggerationOut'),
  speed: $('speed'), speedOut: $('speedOut'), pause: $('pause'), pauseOut: $('pauseOut'),
  generate: $('generateBtn'), progress: $('progress'), bar: $('progressBar'), progressText: $('progressText'),
  error: $('errorBox'), result: $('result'), player: $('player'), download: $('downloadLink'), resultMeta: $('resultMeta'),
  tabHq: $('tabHq'), tabFast: $('tabFast'), paneHq: $('paneHq'), paneFast: $('paneFast'),
  hqWarn: $('hqWarn'), hqList: $('hqList'), fastList: $('fastList'), addVoiceBtn: $('addVoiceBtn'),
  form: $('addVoiceForm'), voiceName: $('voiceName'), voiceFile: $('voiceFile'), recordBtn: $('recordBtn'), recordHint: $('recordHint'),
  voicePreview: $('voicePreview'), clipInfo: $('clipInfo'), consent: $('consent'), voiceError: $('voiceError'), cancelVoice: $('cancelVoiceBtn'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'), clearHistory: $('clearHistory'),
};

const SAMPLES = {
  ar: 'السَّلامُ عليكم. هذا صوتٌ تمَّ توليدُه بالكامل داخلَ المتصفّح، بدون سيرفر وبدون اشتراك.',
  en: 'Hello! This voice was generated entirely inside your browser, with no server and no subscription.',
  other: 'Hello! This voice was generated entirely inside your browser.',
};

// ---------- state ----------
const prefs = store.loadPrefs();
let tab = prefs.tab || 'hq';
let fastLang = prefs.fastLang || 'ar';
let selectedId = prefs.voiceId || PRESETS[0].id;
let hqLang = prefs.hqLang || 'ar';
let myVoices = [];
let support = { ok: true };
let busy = false;
let currentUrl = null;
const downloaded = new Set();
const savePrefs = () => store.savePrefs({ tab, fastLang, voiceId: selectedId, hqLang });

const isHqId = (id) => id === DEFAULT_VOICE.id || String(id).startsWith('my-') || String(id).startsWith('hq-p-');
const hqById = (id) => (id === DEFAULT_VOICE.id ? DEFAULT_VOICE : PRESETS.find((v) => v.id === id) || myVoices.find((v) => v.id === id));
const anyVoice = (id) => (isHqId(id) ? hqById(id) : fastById(id));
const langLabel = (code) => HQ_LANGUAGES.find(([c]) => c === code)?.[1] || code;

// ---------- languages ----------
for (const [code, label] of HQ_LANGUAGES) {
  const o = document.createElement('option');
  o.value = code; o.textContent = label;
  els.language.append(o);
}
els.language.value = hqLang;
els.language.addEventListener('change', () => { hqLang = els.language.value; savePrefs(); renderCompose(); });
// Samples play in the selected speaking language.

// ---------- where the high-quality engine runs ----------
const runEls = {
  btns: document.querySelectorAll('.seg-btn'), hint: document.getElementById('runHint'), form: document.getElementById('serverForm'),
  pass: document.getElementById('serverPass'), connect: document.getElementById('serverConnect'), status: document.getElementById('serverStatus'),
};
function renderRun() {
  const srv = getServer();
  const mode = srv.enabled ? 'server' : 'device';
  runEls.btns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.run === mode)));
  runEls.form.hidden = mode !== 'server';
  runEls.hint.textContent = mode === 'server'
    ? 'السيرفر: يشتغل على أي جهاز حتى الجوال. أول طلب بعد فترة توقف ياخذ حتى دقيقة.'
    : 'جهازي: يحتاج كمبيوتر فيه كرت شاشة، وأول مرة ينزّل 1.5 جيجا.';
  if (mode === 'server' && srv.password && !runEls.status.textContent) {
    runEls.status.textContent = '✓ متصل'; runEls.status.className = 'small ok';
  }
}
function setStatus(text, kind) { runEls.status.textContent = text; runEls.status.className = `small ${kind || ''}`; }
runEls.btns.forEach((b) => b.addEventListener('click', async () => {
  if (busy) return;
  if (b.dataset.run === 'device') { setServer({ enabled: false }); setStatus(''); }
  else { setServer({ enabled: true }); if (!getServer().password) { setStatus(''); runEls.pass.focus(); } }
  support = await hqSupport();
  renderRun(); renderAll();
}));
runEls.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = runEls.pass.value.trim() || getServer().password;
  if (!pw) { setStatus('اكتب كلمة المرور.', 'bad'); return; }
  runEls.connect.disabled = true;
  setStatus('أتصل بالسيرفر وأشغّله... ممكن ياخذ حتى دقيقة أول مرة.', '');
  try {
    await serverCheck(pw);
    setServer({ enabled: true, password: pw });
    runEls.pass.value = '';
    setStatus('✓ متصل. السيرفر جاهز.', 'ok');
    if (!isHqId(selectedId)) { selectedId = PRESETS[0].id; savePrefs(); }
  } catch (err) {
    setServer({ password: '' });
    setStatus(friendlyError(err), 'bad');
  } finally {
    runEls.connect.disabled = false;
    support = await hqSupport();
    renderAll();
  }
});

// ---------- tabs ----------
function setTab(t) {
  tab = t;
  els.tabHq.setAttribute('aria-selected', String(t === 'hq'));
  els.tabFast.setAttribute('aria-selected', String(t === 'fast'));
  els.paneHq.hidden = t !== 'hq';
  els.paneFast.hidden = t !== 'fast';
  savePrefs();
}
els.tabHq.addEventListener('click', () => setTab('hq'));
els.tabFast.addEventListener('click', () => setTab('fast'));

// ---------- voice lists ----------
function voiceButton({ id, name, desc, state, stateReady, onDelete, onPreview }) {
  const li = document.createElement('li');
  li.className = 'voice-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice';
  btn.setAttribute('role', 'radio');
  btn.setAttribute('aria-checked', String(id === selectedId));
  btn.innerHTML = `<span class="avatar" aria-hidden="true"></span><span class="info"><span class="name"></span><span class="desc"></span></span>${state ? `<span class="state ${stateReady ? 'ready' : ''}"></span>` : ''}`;
  btn.querySelector('.avatar').textContent = name.trim().charAt(0);
  btn.querySelector('.name').textContent = name;
  btn.querySelector('.desc').textContent = desc;
  if (state) btn.querySelector('.state').textContent = state;
  btn.addEventListener('click', () => selectVoice(id));
  li.append(btn);
  const tools = document.createElement('div');
  tools.className = 'voice-tools';
  {
    const p = document.createElement('button');
    p.type = 'button'; p.className = 'icon-btn listen'; p.textContent = '▶ اسمع';
    p.setAttribute('aria-label', `اسمع عيّنة من صوت ${name}`);
    p.addEventListener('click', () => (onPreview ? onPreview(p) : previewVoice(id, p)));
    tools.append(p);
  }
  if (onDelete) {
    const d = document.createElement('button');
    d.type = 'button'; d.className = 'icon-btn danger'; d.textContent = 'حذف';
    d.setAttribute('aria-label', `حذف ${name}`);
    d.addEventListener('click', onDelete);
    tools.append(d);
  }
  if (tools.childElementCount) li.append(tools);
  return li;
}

// One shared element. iPhone Safari only lets audio play from a tap, so it is "unlocked" during
// the tap and reused when the sample arrives later. If playing still fails, the sample is shown
// in the result player instead, where a tap plays it.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const previewAudio = new Audio();
previewAudio.preload = 'auto';
let previewUrl = null;
function unlockPreview() {
  try { previewAudio.src = SILENCE; const p = previewAudio.play(); p?.catch?.(() => {}); } catch { /* ignore */ }
}
function playBlob(blob, label) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  previewAudio.pause();
  previewAudio.src = previewUrl;
  const p = previewAudio.play();
  if (p?.catch) p.catch(() => showSampleInPlayer(blob, label));
}
function showSampleInPlayer(blob, label) {
  showResult(blob, `عيّنة: ${label || ''}`, 0);
  els.resultMeta.textContent = `عيّنة: ${label || ''} · اضغط ▶`;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- voice samples ("اسمع") ----------
const SAMPLE_LINES = {
  ar: 'أهلاً وسهلاً، هذا صوتي. أقدر أقرأ لك أي نص تبيه بوضوح وهدوء.',
  en: 'Hi there, this is my voice. I can read any text you like, clearly and calmly.',
  other: 'Hello, this is my voice. I can read any text you like.',
};
async function sampleCache() { try { return await caches.open('sawt-samples-v1'); } catch { return null; } }
const sampleKey = (id, lang) => `https://sawt.local/sample/${encodeURIComponent(id)}/${lang}${isHqId(id) && serverActive() ? '/srv' : ''}`;

async function previewVoice(id, btn) {
  if (busy) return;
  unlockPreview(); // must run inside the tap, before any await (iPhone)
  const hq = isHqId(id);
  const voice = anyVoice(id);
  const lang = hq ? hqLang : voice.lang;
  const cache = await sampleCache();
  const key = sampleKey(id, lang);
  const hit = cache && await cache.match(key);
  if (hit) { playBlob(await hit.blob(), voice.name); return; }
  if (hq && !support.ok) { showError(support.reason); return; }
  const label = btn.textContent;
  btn.textContent = '...';
  showError('');
  setBusy(true, 'تجهيز عيّنة الصوت...');
  try {
    const text = SAMPLE_LINES[lang] || SAMPLE_LINES.other;
    const out = hq
      ? await hqSynthesize({ chunks: [text], language: lang, voice, exaggeration: 0.5 }, showProgress)
      : await fastSynthesize({ text, voiceId: id, speed: 1, pauseMs: 250 }, showProgress);
    if (!hq) { downloaded.add(id); }
    if (cache) { try { await cache.put(key, new Response(out.blob, { headers: { 'content-type': 'audio/wav' } })); } catch { /* storage full */ } }
    playBlob(out.blob, voice.name);
  } catch (e) {
    console.error(e);
    showError(friendlyError(e));
  } finally {
    btn.textContent = label;
    setBusy(false);
    renderFastList();
  }
}
async function forgetSamples(id) {
  const cache = await sampleCache();
  if (!cache) return;
  for (const k of await cache.keys()) if (k.url.includes(`/sample/${encodeURIComponent(id)}/`)) await cache.delete(k);
}

function renderHqList() {
  els.hqList.innerHTML = '';
  const head = (t) => { const li = document.createElement('li'); li.className = 'group'; li.textContent = t; return li; };
  els.hqList.append(head('أصوات جاهزة · كلها تتكلم أي لغة'));
  for (const p of PRESETS) els.hqList.append(voiceButton({ id: p.id, name: p.name, desc: p.desc }));
  els.hqList.append(voiceButton({ ...DEFAULT_VOICE, desc: 'صوت النموذج الأساسي' }));
  if (myVoices.length) els.hqList.append(head('أصواتي'));
  for (const v of myVoices) {
    els.hqList.append(voiceButton({
      id: v.id, name: v.name, desc: `صوتك · ${(v.samples.length / 24000).toFixed(0)} ثانية`,
      onDelete: async () => {
        await store.deleteVoice(v.id); hqForget(v.id); forgetSamples(v.id);
        myVoices = myVoices.filter((x) => x.id !== v.id);
        if (selectedId === v.id) selectedId = DEFAULT_VOICE.id;
        savePrefs(); renderAll();
      },
    }));
  }
  els.hqWarn.hidden = support.ok;
  els.hqWarn.textContent = support.ok ? '' : support.reason;
}

function renderFastList() {
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.lang === fastLang)));
  els.fastList.innerHTML = '';
  for (const v of FAST_VOICES.filter((x) => x.lang === fastLang)) {
    const ready = downloaded.has(v.id);
    els.fastList.append(voiceButton({
      id: v.id, name: v.name, desc: `${v.gender} · ${v.langLabel}`,
      state: ready ? 'محفوظ' : `${v.sizeMb} ميجا`, stateReady: ready,
      onDelete: ready ? async () => { await removeVoice(v); downloaded.delete(v.id); renderFastList(); } : null,
    }));
  }
}
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => { fastLang = chip.dataset.lang; savePrefs(); renderFastList(); }));

function selectVoice(id) {
  selectedId = id;
  savePrefs();
  renderAll();
}

function renderCompose() {
  const hq = isHqId(selectedId);
  const v = anyVoice(selectedId);
  document.querySelectorAll('[data-engine]').forEach((el) => { el.hidden = el.dataset.engine !== (hq ? 'hq' : 'fast'); });
  const speaking = hq ? langLabel(hqLang) : v.langLabel;
  els.selectedVoice.innerHTML = '<span class="sv-label">الصوت:</span> <strong></strong> <span class="muted"></span>';
  els.selectedVoice.querySelector('strong').textContent = v.name;
  els.selectedVoice.querySelector('.muted').textContent = hq ? `· عالي الجودة · يتكلم ${speaking}` : `· سريع · ${speaking}`;
  const lang = hq ? hqLang : v.lang;
  els.arHint.hidden = lang !== 'ar';
  els.generate.disabled = busy || (hq && !support.ok);
}

function renderTop() {
  const onServer = serverActive();
  const badge = document.getElementById('runBadge');
  badge.textContent = onServer && isHqId(selectedId) ? 'يعمل على السيرفر' : 'يعمل على جهازك';
  const hint = document.getElementById('srvHint');
  hint.hidden = onServer || support.ok || !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}
document.getElementById('srvHint').addEventListener('click', () => {
  setTab('hq');
  els.paneHq.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
function renderAll() { renderHqList(); renderFastList(); renderCompose(); renderTop(); }

// ---------- compose ----------
function updateCount() {
  els.charCount.textContent = `${els.script.value.trim().length.toLocaleString('ar')} حرف`;
  store.saveDraft(els.script.value);
}
els.script.addEventListener('input', updateCount);
els.sampleBtn.addEventListener('click', () => {
  const lang = isHqId(selectedId) ? hqLang : fastById(selectedId).lang;
  els.script.value = SAMPLES[lang] || SAMPLES.other; updateCount(); els.script.focus();
});
const exaggerationLabel = (x) => (x < 0.4 ? 'هادئ' : x <= 0.65 ? 'متوسط' : x <= 1 ? 'معبّر' : 'معبّر جداً');
els.exaggeration.addEventListener('input', () => { els.exaggerationOut.textContent = exaggerationLabel(Number(els.exaggeration.value)); });
els.speed.addEventListener('input', () => { els.speedOut.textContent = `${Number(els.speed.value).toFixed(1)}×`; });
els.pause.addEventListener('input', () => { els.pauseOut.textContent = `${els.pause.value} ملي ثانية`; });

function setBusy(on, text) {
  busy = on;
  els.generate.querySelector('.btn-label').textContent = on ? 'جاري التوليد...' : 'ولّد الصوت';
  els.progress.hidden = !on;
  if (on && text) els.progressText.textContent = text;
  if (!on) els.bar.style.width = '0';
  renderCompose();
}

const mb = (n) => (n / 1048576).toFixed(0);
function showProgress(p) {
  if (p.stage === 'download') {
    const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
    els.bar.style.width = `${pct}%`;
    els.progressText.textContent = `تنزيل المحرك لأول مرة... ${pct}% (${mb(p.loaded)} من ${mb(p.total)} ميجا). المرات الجاية ما يحتاج تنزيل.`;
  } else if (p.stage === 'server') {
    const n = p.count || 1, i = p.index || 1;
    els.bar.style.width = `${Math.max(5, Math.round(((i - 1) / n) * 100))}%`;
    const part = n > 1 ? ` جزء ${i} من ${n}` : '';
    els.progressText.textContent = i === 1
      ? `السيرفر يولّد الصوت...${part} (إذا كان طافي، يشتغل خلال دقيقة تقريباً)`
      : `السيرفر يولّد الصوت...${part}`;
  } else if (p.stage === 'server-voice') {
    els.progressText.textContent = 'أرفع الصوت للسيرفر (مرة وحدة بس)...';
  } else if (p.stage === 'retry') {
    els.progressText.textContent = `انقطع الاتصال، أعيد المحاولة (${p.attempt})... التنزيل يكمل من نفس النقطة.`;
  } else if (p.stage === 'voice-download') {
    const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
    els.bar.style.width = `${pct}%`;
    els.progressText.textContent = `تجهيز الصوت المختار لأول مرة... ${pct}%`;
  } else if (p.stage === 'voice') {
    els.progressText.textContent = 'تجهيز الصوت المختار...';
  } else if (p.stage === 'prepare') {
    els.bar.style.width = '100%';
    els.progressText.textContent = 'تجهيز المحرك...';
  } else if (p.stage === 'speak') {
    els.bar.style.width = `${Math.round(((p.index - 1) / p.count) * 100)}%`;
    els.progressText.textContent = p.count > 1 ? `توليد الصوت... جزء ${p.index} من ${p.count}` : 'توليد الصوت...';
  }
}

function showError(msg) { els.error.textContent = msg; els.error.hidden = !msg; }
function friendlyError(e) {
  const m = String(e?.message || e);
  if (/Failed to fetch|NetworkError|network error|تعذّر تنزيل|Could not locate file/i.test(m)) return 'انقطع التنزيل. اضغط «ولّد الصوت» مرة ثانية، والملفات اللي تنزّلت ما تتنزّل من جديد.';
  if (/QuotaExceeded|quota/i.test(m)) return 'مساحة المتصفح ممتلئة. احذف أصوات ما تستخدمها.';
  if (/webgpu|GPU|adapter/i.test(m)) return 'تعذّر تشغيل كرت الشاشة. جرّب Chrome أو Edge، أو استخدم الأصوات السريعة.';
  if (/SERVER_BAD_PASSWORD/.test(m)) return 'كلمة مرور السيرفر غلط. اكتبها مثل ما حطيتها في SAWTI_PASSWORD بالضبط.';
  if (/SERVER_UNREACHABLE/.test(m)) return 'ما قدرت أوصل للسيرفر. تأكد إنه انرفع على Modal، وإن عندك إنترنت، وجرّب مرة ثانية.';
  if (/SERVER_TOO_LONG/.test(m)) return 'النص طويل على السيرفر. قسّمه لأجزاء أقصر من 6,000 حرف.';
  if (/SERVER_ERROR/.test(m)) return 'صار خطأ في السيرفر (' + m.replace('SERVER_ERROR ', '') + '). جرّب مرة ثانية بعد شوي.';
  if (/SHORT_OUTPUT/.test(m)) return 'المحرك طلع صوت ناقص. جرّب مرة ثانية، أو جرّب صوت ثاني، وإذا تكرر صوّر لي الرسالة: ' + m;
  if (/memory|OOM|allocation/i.test(m)) return 'ذاكرة الجهاز ما كفت. سكّر التبويبات الثانية وجرّب، أو قسّم النص.';
  return m;
}

const formatSeconds = (s) => (s < 60 ? `${s.toFixed(1)} ث` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} د`);
function showResult(blob, name, seconds) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  els.player.src = currentUrl;
  els.download.href = currentUrl;
  const d = new Date();
  els.download.download = `sawti-${d.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.wav`;
  els.resultMeta.textContent = `${name} · ${formatSeconds(seconds)}`;
  els.result.hidden = false;
}

els.generate.addEventListener('click', async () => {
  if (busy) return;
  const text = els.script.value.trim();
  showError('');
  if (!text) { showError('اكتب نصاً أولاً.'); els.script.focus(); return; }
  if (text.length > 20000) { showError('النص طويل جداً. قسّمه لأجزاء أقصر من 20,000 حرف.'); return; }
  const hq = isHqId(selectedId);
  const voice = anyVoice(selectedId);
  setBusy(true);
  try {
    let out, settings;
    if (hq) {
      settings = { engine: 'hq', language: hqLang, exaggeration: Number(els.exaggeration.value) };
      out = await hqSynthesize({ chunks: splitText(text, 220), language: hqLang, voice, exaggeration: settings.exaggeration }, showProgress);
    } else {
      settings = { engine: 'fast', speed: Number(els.speed.value), pauseMs: Number(els.pause.value) };
      out = await fastSynthesize({ text, voiceId: voice.id, speed: settings.speed, pauseMs: settings.pauseMs }, showProgress);
      downloaded.add(voice.id); renderFastList();
    }
    showResult(out.blob, voice.name, out.seconds);
    els.player.play().catch(() => {});
    await store.addHistory({ text, voiceId: voice.id, voiceName: voice.name, ...settings, seconds: out.seconds, blob: out.blob, createdAt: Date.now() });
    renderHistory();
  } catch (e) {
    console.error(e);
    showError(friendlyError(e));
  } finally {
    setBusy(false);
  }
});

// ---------- add a voice ----------
let clip = null; // Float32Array @24k
let recorder = null;
let recTimer = null;

function resetForm() {
  clip = null;
  els.voiceName.value = '';
  els.voiceFile.value = '';
  els.consent.checked = false;
  els.voicePreview.hidden = true;
  els.voicePreview.removeAttribute('src');
  els.clipInfo.textContent = '';
  els.recordHint.hidden = true;
  els.voiceError.hidden = true;
}
els.addVoiceBtn.addEventListener('click', () => { resetForm(); els.form.hidden = false; els.addVoiceBtn.hidden = true; els.voiceName.focus(); });
els.cancelVoice.addEventListener('click', async () => {
  if (recorder) { await recorder.stop().catch(() => {}); recorder = null; clearInterval(recTimer); els.recordBtn.textContent = 'تسجيل من المايك'; }
  els.form.hidden = true; els.addVoiceBtn.hidden = false;
});

function voiceErr(msg) { els.voiceError.textContent = msg; els.voiceError.hidden = !msg; }

async function useBlob(blob) {
  voiceErr('');
  try {
    const raw = await decodeToMono(await blob.arrayBuffer());
    const t = tidyClip(raw);
    const secs = t.length / 24000;
    if (secs < 5) { clip = null; voiceErr('المقطع قصير. نحتاج 5 ثواني كلام على الأقل، والأفضل من 10 إلى 30 ثانية.'); return; }
    clip = t;
    els.voicePreview.src = URL.createObjectURL(encodeWav(t, 24000));
    els.voicePreview.hidden = false;
    els.clipInfo.textContent = `مدة المقطع: ${secs.toFixed(0)} ثانية${raw.length / 24000 > 30.5 ? ' (أخذنا أول 30 ثانية)' : ''}`;
  } catch {
    clip = null;
    voiceErr('ما قدرت أقرأ الملف. جرّب ملف MP3 أو WAV أو M4A.');
  }
}

els.voiceFile.addEventListener('change', () => { const f = els.voiceFile.files?.[0]; if (f) useBlob(f); });

els.recordBtn.addEventListener('click', async () => {
  if (!recorder) {
    voiceErr('');
    try {
      recorder = new Recorder();
      await recorder.start();
    } catch {
      recorder = null;
      voiceErr('ما قدرت أفتح المايك. اسمح للموقع يستخدمه من إعدادات المتصفح، أو ارفع ملف بدلاً منه.');
      return;
    }
    els.recordHint.hidden = false;
    els.recordBtn.classList.add('recording');
    recTimer = setInterval(() => {
      const s = Math.floor(recorder.seconds);
      els.recordBtn.textContent = `إيقاف التسجيل (${s} ث)`;
      if (s >= 30) els.recordBtn.click();
    }, 250);
    els.recordBtn.textContent = 'إيقاف التسجيل (0 ث)';
  } else {
    clearInterval(recTimer);
    const blob = await recorder.stop();
    recorder = null;
    els.recordBtn.classList.remove('recording');
    els.recordBtn.textContent = 'سجّل من جديد';
    await useBlob(blob);
  }
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.voiceName.value.trim();
  if (!name) { voiceErr('اكتب اسم للصوت.'); els.voiceName.focus(); return; }
  if (!clip) { voiceErr('ارفع مقطع أو سجّل صوتك أولاً.'); return; }
  if (!els.consent.checked) { voiceErr('أكّد إن الصوت صوتك أو عندك إذن صاحبه.'); return; }
  const v = { id: `my-${Date.now().toString(36)}`, name, samples: clip, createdAt: Date.now() };
  await store.saveVoice(v);
  myVoices.push(v);
  els.form.hidden = true; els.addVoiceBtn.hidden = false;
  selectVoice(v.id);
});

// ---------- history ----------
const historyUrls = [];
async function renderHistory() {
  historyUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const items = await store.listHistory();
  els.historyList.innerHTML = '';
  els.historyEmpty.hidden = items.length > 0;
  els.clearHistory.hidden = items.length === 0;
  for (const it of items) {
    const name = it.voiceName || anyVoice(it.voiceId)?.name || it.voiceId;
    const url = URL.createObjectURL(it.blob);
    historyUrls.push(url);
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `<p class="text" dir="auto"></p><audio controls preload="none"></audio>
      <div class="actions">
        <a class="secondary dl">تنزيل</a>
        <button type="button" class="secondary reuse">استخدم النص</button>
        <button type="button" class="link del">حذف</button>
        <span class="when"></span>
      </div>`;
    li.querySelector('.text').textContent = it.text;
    li.querySelector('audio').src = url;
    const a = li.querySelector('.dl');
    a.href = url; a.download = `sawti-${it.id}.wav`;
    const extra = it.engine === 'hq' ? ` · ${langLabel(it.language)}` : '';
    li.querySelector('.when').textContent = `${name}${extra} · ${formatSeconds(it.seconds)} · ${new Date(it.createdAt).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' })}`;
    li.querySelector('.reuse').addEventListener('click', () => {
      els.script.value = it.text; updateCount();
      if (anyVoice(it.voiceId)) {
        selectedId = it.voiceId;
        if (it.engine === 'hq') { hqLang = it.language; els.language.value = hqLang; setTab('hq'); els.exaggeration.value = it.exaggeration; els.exaggeration.dispatchEvent(new Event('input')); }
        else { fastLang = fastById(it.voiceId).lang; setTab('fast'); els.speed.value = it.speed; els.speed.dispatchEvent(new Event('input')); els.pause.value = it.pauseMs; els.pause.dispatchEvent(new Event('input')); }
        savePrefs(); renderAll();
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    li.querySelector('.del').addEventListener('click', async () => { await store.deleteHistory(it.id); renderHistory(); });
    els.historyList.append(li);
  }
}
els.clearHistory.addEventListener('click', async () => {
  if (els.clearHistory.dataset.confirm !== '1') {
    els.clearHistory.dataset.confirm = '1';
    els.clearHistory.textContent = 'متأكد؟ اضغط مرة ثانية';
    setTimeout(() => { els.clearHistory.dataset.confirm = ''; els.clearHistory.textContent = 'مسح الكل'; }, 4000);
    return;
  }
  els.clearHistory.dataset.confirm = '';
  els.clearHistory.textContent = 'مسح الكل';
  await store.clearHistory();
  renderHistory();
});

// ---------- start ----------
async function start() {
  els.script.value = store.loadDraft();
  updateCount();
  myVoices = await store.listVoices();
  if (!anyVoice(selectedId)) selectedId = DEFAULT_VOICE.id;
  renderRun();
  support = await hqSupport();
  // On devices without WebGPU, default to the fast engine.
  if (!support.ok && isHqId(selectedId) && !prefs.voiceId) { selectedId = FAST_VOICES[0].id; tab = 'fast'; }
  setTab(tab);
  renderAll();
  for (const v of FAST_VOICES) if (await isDownloaded(v)) downloaded.add(v.id);
  renderFastList();
  renderHistory();
}
start();
