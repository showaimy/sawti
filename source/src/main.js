import { splitText, encodeWav, cleanupOldDownloads } from './utils.js';
import { LANGUAGES, STYLES, canUseHabibi, DEFAULT_VOICE, PRESETS, isConnected, connect, disconnect, synthesize, forgetVoice } from './server.js';
import { decodeToMono, tidyClip, Recorder } from './audio.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const els = {
  badge: $('runBadge'), connectForm: $('connectForm'), pass: $('serverPass'), connectBtn: $('connectBtn'), connectStatus: $('connectStatus'),
  connectedBar: $('connectedBar'), changePass: $('changePass'),
  selectedVoice: $('selectedVoice'), script: $('script'), charCount: $('charCount'), sampleBtn: $('sampleBtn'), arHint: $('arHint'),
  language: $('language'), exaggeration: $('exaggeration'), exaggerationOut: $('exaggerationOut'),
  dialect: $('dialect'), dialectControl: $('dialectControl'), style: $('style'),
  engine: $('engine'), engineControl: $('engineControl'), exaggerationControl: $('exaggerationControl'), habibiHint: $('habibiHint'),
  generate: $('generateBtn'), progress: $('progress'), bar: $('progressBar'), progressText: $('progressText'),
  error: $('errorBox'), result: $('result'), player: $('player'), download: $('downloadLink'), resultMeta: $('resultMeta'),
  voiceList: $('voiceList'), addVoiceBtn: $('addVoiceBtn'),
  form: $('addVoiceForm'), voiceName: $('voiceName'), voiceFile: $('voiceFile'), recordBtn: $('recordBtn'), recordHint: $('recordHint'),
  voicePreview: $('voicePreview'), clipInfo: $('clipInfo'), consent: $('consent'), voiceError: $('voiceError'), cancelVoice: $('cancelVoiceBtn'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'), clearHistory: $('clearHistory'),
};

const SAMPLES = {
  saudi: 'يا هلا والله! هذا صوت سعودي مولّد بالذكاء الاصطناعي، تكتب أي نص وأقرأه لك بأسلوب طبيعي. وعندنا خصم 25% لين نهاية الشهر، لا يفوتك!',
  ar: 'السَّلامُ عليكم. هذا صوتٌ تمَّ توليدُه بالذكاءِ الاصطناعي، ويقدرُ يقرأ أيَّ نصٍّ تكتبه.',
  en: 'Hello! This voice was generated with AI, and it can read any text you write.',
  other: 'Hello! This voice was generated with AI.',
};
const SAMPLE_LINES = {
  saudi: 'هلا والله، هذا صوتي. أقدر أقرأ لك أي نص تبيه، بوضوح وبإحساس.',
  ar: 'أهلاً وسهلاً، هذا صوتي. أقدر أقرأ لك أي نص تبيه بوضوح وهدوء.',
  en: 'Hi there, this is my voice. I can read any text you like, clearly and calmly.',
  other: 'Hello, this is my voice. I can read any text you like.',
};

// ---------- state ----------
const prefs = store.loadPrefs();
let selectedId = prefs.voiceId || PRESETS[0].id;
let lang = prefs.hqLang || 'ar';
let dialect = prefs.dialect === 'msa' ? 'msa' : 'saudi';
let styleId = STYLES.some((x) => x.id === prefs.style) ? prefs.style : STYLES[0].id;
let engine = prefs.engine === 'habibi' ? 'habibi' : 'chatterbox';
const usingHabibi = () => lang === 'ar' && engine === 'habibi';
let myVoices = [];
let busy = false;
let currentUrl = null;
const savePrefs = () => store.savePrefs({ voiceId: selectedId, hqLang: lang, dialect, style: styleId, engine });
const styleById = (id) => STYLES.find((x) => x.id === id) || STYLES[0];
// text key for samples: Saudi Arabic has its own lines
const textKey = () => (lang === 'ar' && dialect === 'saudi' ? 'saudi' : lang);
const sampleTag = () => textKey() + (usingHabibi() ? '-habibi' : '');

const voiceById = (id) => (id === DEFAULT_VOICE.id ? DEFAULT_VOICE : PRESETS.find((v) => v.id === id) || myVoices.find((v) => v.id === id));
const langLabel = (code) => LANGUAGES.find(([c]) => c === code)?.[1] || code;

// ---------- connection ----------
function renderConnection() {
  const on = isConnected();
  els.connectForm.hidden = on;
  els.connectedBar.hidden = !on;
  els.badge.textContent = on ? 'متصل بالسيرفر' : 'غير متصل';
  els.badge.classList.toggle('off', !on);
  els.generate.disabled = busy || !on;
}
function setConnectStatus(text, kind) { els.connectStatus.textContent = text; els.connectStatus.className = `small ${kind || ''}`; }

els.connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = els.pass.value.trim();
  if (!pw) { setConnectStatus('اكتب كلمة المرور.', 'bad'); els.pass.focus(); return; }
  els.connectBtn.disabled = true;
  setConnectStatus('أتصل بالسيرفر وأشغّله... أول مرة بعد فترة توقف تاخذ حتى دقيقة.', '');
  try {
    await connect(pw);
    els.pass.value = '';
    setConnectStatus('');
    showError('');
  } catch (err) {
    setConnectStatus(friendlyError(err), 'bad');
  } finally {
    els.connectBtn.disabled = false;
    renderConnection();
  }
});
els.changePass.addEventListener('click', () => {
  disconnect();
  renderConnection();
  els.pass.focus();
});

// ---------- languages ----------
for (const [code, label] of LANGUAGES) {
  const o = document.createElement('option');
  o.value = code; o.textContent = label;
  els.language.append(o);
}
els.language.value = lang;
els.language.addEventListener('change', () => { lang = els.language.value; savePrefs(); renderCompose(); });

// ---------- dialect + speaking style ----------
els.dialect.value = dialect;
els.dialect.addEventListener('change', () => { dialect = els.dialect.value === 'msa' ? 'msa' : 'saudi'; savePrefs(); renderCompose(); });
for (const st of STYLES) {
  const o = document.createElement('option');
  o.value = st.id; o.textContent = st.name;
  els.style.append(o);
}
els.style.value = styleId;
function applyStyle() {
  els.exaggeration.value = styleById(styleId).exaggeration;
  els.exaggeration.dispatchEvent(new Event('input'));
}
els.style.addEventListener('change', () => { styleId = els.style.value; savePrefs(); applyStyle(); });
els.engine.value = engine;
els.engine.addEventListener('change', () => { engine = els.engine.value === 'habibi' ? 'habibi' : 'chatterbox'; savePrefs(); renderAll(); });

// ---------- voice list ----------
function voiceRow({ id, name, desc, onDelete }) {
  const li = document.createElement('li');
  li.className = 'voice-wrap';
  if (usingHabibi() && !canUseHabibi(voiceById(id))) { li.classList.add('dim'); desc += ' · ما يشتغل مع Habibi'; }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice';
  btn.setAttribute('role', 'radio');
  btn.setAttribute('aria-checked', String(id === selectedId));
  btn.innerHTML = '<span class="avatar" aria-hidden="true"></span><span class="info"><span class="name"></span><span class="desc"></span></span>';
  btn.querySelector('.avatar').textContent = name.trim().charAt(0);
  btn.querySelector('.name').textContent = name;
  btn.querySelector('.desc').textContent = desc;
  btn.addEventListener('click', () => { selectedId = id; savePrefs(); renderAll(); });
  li.append(btn);
  const tools = document.createElement('div');
  tools.className = 'voice-tools';
  const listen = document.createElement('button');
  listen.type = 'button'; listen.className = 'icon-btn listen'; listen.textContent = '▶ اسمع';
  listen.setAttribute('aria-label', `اسمع عيّنة من صوت ${name}`);
  listen.addEventListener('click', () => previewVoice(id, listen));
  tools.append(listen);
  if (onDelete) {
    const d = document.createElement('button');
    d.type = 'button'; d.className = 'icon-btn danger'; d.textContent = 'حذف';
    d.setAttribute('aria-label', `حذف ${name}`);
    d.addEventListener('click', onDelete);
    tools.append(d);
  }
  li.append(tools);
  return li;
}

function renderVoices() {
  els.voiceList.innerHTML = '';
  const head = (t) => { const li = document.createElement('li'); li.className = 'group'; li.textContent = t; return li; };
  els.voiceList.append(head('أصوات جاهزة'));
  for (const p of PRESETS) els.voiceList.append(voiceRow(p));
  els.voiceList.append(voiceRow(DEFAULT_VOICE));
  if (myVoices.length) els.voiceList.append(head('أصواتي'));
  for (const v of myVoices) {
    els.voiceList.append(voiceRow({
      id: v.id, name: v.name, desc: `صوتك · ${(v.samples.length / 24000).toFixed(0)} ثانية`,
      onDelete: async () => {
        await store.deleteVoice(v.id); forgetVoice(v.id); forgetSamples(v.id);
        myVoices = myVoices.filter((x) => x.id !== v.id);
        if (selectedId === v.id) selectedId = PRESETS[0].id;
        savePrefs(); renderAll();
      },
    }));
  }
}

function renderCompose() {
  const v = voiceById(selectedId) || PRESETS[0];
  els.selectedVoice.innerHTML = '<span class="sv-label">الصوت:</span> <strong></strong> <span class="muted"></span>';
  els.selectedVoice.querySelector('strong').textContent = v.name;
  els.selectedVoice.querySelector('.muted').textContent = `· يتكلم ${lang === 'ar' ? (dialect === 'saudi' ? 'باللهجة السعودية' : 'بالفصحى') : langLabel(lang)}`;
  els.arHint.hidden = lang !== 'ar';
  els.dialectControl.hidden = lang !== 'ar';
  els.engineControl.hidden = lang !== 'ar';
  els.exaggerationControl.hidden = usingHabibi();
  els.habibiHint.hidden = !usingHabibi();
}

function renderAll() { renderVoices(); renderCompose(); renderConnection(); }

// ---------- compose ----------
function updateCount() {
  els.charCount.textContent = `${els.script.value.trim().length.toLocaleString('ar')} حرف`;
  store.saveDraft(els.script.value);
}
els.script.addEventListener('input', updateCount);
els.sampleBtn.addEventListener('click', () => { els.script.value = SAMPLES[textKey()] || SAMPLES.other; updateCount(); els.script.focus(); });
const exaggerationLabel = (x) => (x < 0.4 ? 'هادئ' : x <= 0.65 ? 'متوسط' : x <= 1 ? 'معبّر' : 'معبّر جداً');
els.exaggeration.addEventListener('input', () => { els.exaggerationOut.textContent = exaggerationLabel(Number(els.exaggeration.value)); });

function setBusy(on, text) {
  busy = on;
  els.generate.querySelector('.btn-label').textContent = on ? 'جاري التوليد...' : 'ولّد الصوت';
  els.progress.hidden = !on;
  if (on && text) els.progressText.textContent = text;
  if (!on) els.bar.style.width = '0';
  renderConnection();
}

function showProgress(p) {
  if (p.stage === 'upload') {
    els.bar.style.width = '5%';
    els.progressText.textContent = 'أرفع صوتك للسيرفر (مرة وحدة بس)...';
  } else if (p.stage === 'speak') {
    const n = p.count || 1, i = p.index || 1;
    els.bar.style.width = `${Math.max(5, Math.round(((i - 1) / n) * 100))}%`;
    const part = n > 1 ? ` جزء ${i} من ${n}` : '';
    els.progressText.textContent = i === 1
      ? `السيرفر يولّد الصوت...${part} (إذا كان طافي، يشتغل خلال دقيقة تقريباً)`
      : `السيرفر يولّد الصوت...${part}`;
  }
}

function showError(msg) { els.error.textContent = msg; els.error.hidden = !msg; }
function friendlyError(e) {
  const m = String(e?.message || e);
  if (/SERVER_BAD_PASSWORD/.test(m)) return 'كلمة المرور غلط. اكتبها مثل ما حطيتها في SAWTI_PASSWORD بالضبط.';
  if (/SERVER_NOT_CONNECTED/.test(m)) return 'اتصل بالسيرفر أول: اكتب كلمة المرور فوق واضغط «اتصال».';
  if (/SERVER_UNREACHABLE/.test(m)) return 'ما قدرت أوصل للسيرفر. تأكد من الإنترنت وجرّب مرة ثانية. إذا تكرر، ممكن رصيد Modal خلص لهذا الشهر.';
  if (/SERVER_HABIBI_VOICE/.test(m)) return 'Habibi يحتاج صوت يتكلم عربي: اختر «كريم» أو أضف صوتك أنت من «إضافة صوت».';
  if (/SERVER_HABIBI_MISSING/.test(m)) return 'محرك Habibi مو جاهز على السيرفر حالياً. استخدم NAMAA لين ينحل.';
  if (/SERVER_TOO_LONG/.test(m)) return 'جزء من النص طويل جداً. حط نقاط أو فواصل بين الجمل.';
  if (/SERVER_VOICE_MISSING/.test(m)) return 'هذا الصوت مو موجود على السيرفر حالياً. جرّب صوت ثاني.';
  if (/SERVER_ERROR/.test(m)) return `صار خطأ في السيرفر (${m.replace('SERVER_ERROR ', '')}). جرّب مرة ثانية بعد شوي.`;
  if (/QuotaExceeded|quota/i.test(m)) return 'مساحة المتصفح ممتلئة. امسح شي من السجل.';
  return m;
}

const formatSeconds = (s) => (s < 60 ? `${s.toFixed(1)} ث` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} د`);
function showResult(blob, label) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  els.player.src = currentUrl;
  els.download.href = currentUrl;
  els.download.download = `sawti-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.wav`;
  els.resultMeta.textContent = label;
  els.result.hidden = false;
}

els.generate.addEventListener('click', async () => {
  if (busy) return;
  const text = els.script.value.trim();
  showError('');
  if (!isConnected()) { showError(friendlyError('SERVER_NOT_CONNECTED')); els.pass.focus(); return; }
  if (!text) { showError('اكتب نصاً أولاً.'); els.script.focus(); return; }
  if (text.length > 20000) { showError('النص طويل جداً. قسّمه لأجزاء أقصر من 20,000 حرف.'); return; }
  const voice = voiceById(selectedId) || PRESETS[0];
  const exaggeration = Number(els.exaggeration.value);
  const st = styleById(styleId);
  setBusy(true, 'أجهّز الطلب...');
  try {
    const out = await synthesize({
      chunks: splitText(text, 220), language: lang, voice, exaggeration,
      cfgWeight: st.cfgWeight, temperature: st.temperature, dialect,
      engine: usingHabibi() ? 'habibi' : 'chatterbox', speed: st.speed,
    }, showProgress);
    showResult(out.blob, `${voice.name} · ${formatSeconds(out.seconds)}`);
    els.player.play().catch(() => {});
    await store.addHistory({ text, voiceId: voice.id, voiceName: voice.name, engine: usingHabibi() ? 'habibi' : 'hq', language: lang, dialect, style: styleId, exaggeration, seconds: out.seconds, blob: out.blob, createdAt: Date.now() });
    renderHistory();
  } catch (e) {
    console.error(e);
    showError(friendlyError(e));
    if (/SERVER_BAD_PASSWORD/.test(String(e?.message))) { disconnect(); renderConnection(); }
  } finally {
    setBusy(false);
  }
});

// ---------- voice samples ("اسمع") ----------
// One shared element. iPhone Safari only lets audio play from a tap, so it is unlocked during the
// tap and reused when the sample arrives. If playing still fails, the sample shows in the result player.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const previewAudio = new Audio();
previewAudio.preload = 'auto';
let previewUrl = null;
function unlockPreview() {
  try { previewAudio.src = SILENCE; const p = previewAudio.play(); p?.catch?.(() => {}); } catch { /* ignore */ }
}
function playSample(blob, name) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  previewAudio.pause();
  previewAudio.src = previewUrl;
  const p = previewAudio.play();
  if (p?.catch) p.catch(() => {
    showResult(blob, `عيّنة: ${name} · اضغط ▶`);
    els.result.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
async function sampleCache() { try { return await caches.open('sawt-samples-v3'); } catch { return null; } }
const sampleKey = (id, l) => `https://sawt.local/sample/${encodeURIComponent(id)}/${l}`;

async function previewVoice(id, btn) {
  if (busy) return;
  unlockPreview(); // inside the tap, before any await (iPhone)
  const voice = voiceById(id);
  const cache = await sampleCache();
  const key = sampleKey(id, sampleTag());
  const hit = cache && await cache.match(key);
  if (hit) { playSample(await hit.blob(), voice.name); return; }
  if (!isConnected()) { showError(friendlyError('SERVER_NOT_CONNECTED')); els.pass.focus(); return; }
  const label = btn.textContent;
  btn.textContent = '...';
  showError('');
  setBusy(true, 'أجهّز عيّنة الصوت...');
  try {
    const out = await synthesize({ chunks: [SAMPLE_LINES[textKey()] || SAMPLE_LINES.other], language: lang, voice, exaggeration: 0.5, dialect, engine: usingHabibi() ? 'habibi' : 'chatterbox' }, showProgress);
    if (cache) { try { await cache.put(key, new Response(out.blob, { headers: { 'content-type': 'audio/wav' } })); } catch { /* storage full */ } }
    playSample(out.blob, voice.name);
  } catch (e) {
    console.error(e);
    showError(friendlyError(e));
  } finally {
    btn.textContent = label;
    setBusy(false);
  }
}
async function forgetSamples(id) {
  const cache = await sampleCache();
  if (!cache) return;
  for (const k of await cache.keys()) if (k.url.includes(`/sample/${encodeURIComponent(id)}/`)) await cache.delete(k);
}

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
  selectedId = v.id; savePrefs(); renderAll();
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
    const name = it.voiceName || voiceById(it.voiceId)?.name || it.voiceId;
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
    const extra = (it.language ? ` · ${it.language === 'ar' && it.dialect ? (it.dialect === 'saudi' ? 'سعودي' : 'فصحى') : langLabel(it.language)}` : '') + (it.engine === 'habibi' ? ' · Habibi' : '');
    li.querySelector('.when').textContent = `${name}${extra} · ${formatSeconds(it.seconds)} · ${new Date(it.createdAt).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' })}`;
    li.querySelector('.reuse').addEventListener('click', () => {
      els.script.value = it.text; updateCount();
      if (voiceById(it.voiceId)) selectedId = it.voiceId;
      if (it.language) { lang = it.language; els.language.value = lang; }
      if (it.dialect) { dialect = it.dialect; els.dialect.value = dialect; }
      if (it.engine === 'habibi' || it.engine === 'hq') { engine = it.engine === 'habibi' ? 'habibi' : 'chatterbox'; els.engine.value = engine; }
      if (it.style && STYLES.some((x) => x.id === it.style)) { styleId = it.style; els.style.value = styleId; }
      if (it.exaggeration) { els.exaggeration.value = it.exaggeration; els.exaggeration.dispatchEvent(new Event('input')); }
      savePrefs(); renderAll();
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
  cleanupOldDownloads();
  els.script.value = store.loadDraft();
  updateCount();
  myVoices = await store.listVoices();
  if (!voiceById(selectedId)) selectedId = PRESETS[0].id;
  applyStyle();
  renderAll();
  renderHistory();
}
start();
