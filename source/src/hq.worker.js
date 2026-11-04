// High-quality engine: Chatterbox Multilingual (Resemble AI, MIT) via Transformers.js on WebGPU.
// Runs in a worker so the page stays responsive. Any voice can speak any of the 23 languages.
import { env, AutoProcessor, ChatterboxModel, Tensor } from '@huggingface/transformers';
import ortMjs from '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

const MODEL_ID = 'onnx-community/chatterbox-multilingual-ONNX';
const SR = 24000;

env.allowLocalModels = false;
env.useBrowserCache = true;
// Runtime files are served by this site, not a CDN.
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL(ortMjs, self.location.href).href,
  wasm: new URL(ortWasm, self.location.href).href,
};

// The multilingual repo ships the ONNX files and tokenizer but no config.json / preprocessor_config.json,
// which Transformers.js needs. Same Llama backbone as onnx-community/chatterbox-ONNX, so we supply them here.
const INJECTED = {
  'config.json': {
    model_type: 'chatterbox',
    eos_token_id: 6562,
    architectures: ['ChatterboxModel'],
    text_config: {
      model_type: 'llama', architectures: ['LlamaForCausalLM'],
      num_hidden_layers: 30, hidden_size: 1024, intermediate_size: 4096,
      num_attention_heads: 16, num_key_value_heads: 16, head_dim: 64,
      hidden_act: 'silu', rms_norm_eps: 1e-5, attention_bias: false, mlp_bias: false,
      max_position_embeddings: 131072, rope_theta: 500000,
      rope_scaling: { rope_type: 'llama3', factor: 8.0, original_max_position_embeddings: 8192, high_freq_factor: 4.0, low_freq_factor: 1.0 },
      bos_token_id: 1, eos_token_id: 6562, tie_word_embeddings: false, torch_dtype: 'float32',
    },
    'transformers.js_config': { use_external_data_format: true, kv_cache_dtype: { q4f16: 'float16', fp16: 'float16' } },
  },
  'generation_config.json': { bos_token_id: 1, eos_token_id: 6562, repetition_penalty: 1.2 },
  'preprocessor_config.json': { feature_extractor_type: 'ChatterboxFeatureExtractor', processor_class: 'ChatterboxProcessor', sampling_rate: 24000 },
};
const baseFetch = env.fetch;
env.fetch = (url, init) => {
  const u = String(url);
  if (u.includes(`/${MODEL_ID}/`)) {
    const name = u.split('?')[0].split('/').pop();
    if (INJECTED[name]) {
      return Promise.resolve(new Response(JSON.stringify(INJECTED[name]), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
  }
  return baseFetch(url, init);
};

let model = null;
let processor = null;
let loading = null;
const speakerCache = new Map(); // voiceKey -> speech encoder outputs

async function pickLmDtype() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter?.features?.has('shader-f16')) return 'q4f16';
  } catch { /* ignore */ }
  return 'q4';
}

// ---------- resumable download of the big model files ----------
// One 1.5 GB download in a single request fails easily ("network error"). We fetch each file in
// 24 MB ranges with retries, store it in the same cache Transformers.js reads from, then load.
const REPO_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/`;
const CHUNK = 24 * 1024 * 1024;
const MB = 1024 * 1024;
function bigFiles(lm) {
  return [
    ['onnx/embed_tokens.onnx', 0.02], ['onnx/embed_tokens.onnx_data', 68.4],
    [`onnx/language_model_${lm}.onnx`, 0.23], [`onnx/language_model_${lm}.onnx_data`, lm === 'q4f16' ? 305 : 354],
    ['onnx/conditional_decoder.onnx', 6.35], ['onnx/conditional_decoder.onnx_data', 534],
    ['onnx/speech_encoder.onnx', 1.18], ['onnx/speech_encoder.onnx_data', 591],
  ];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRange(url, start, end) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await baseFetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status === 416) return { data: new Uint8Array(0), whole: false };
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const err = new Error(`Could not locate file: ${url} (HTTP ${res.status})`); err.fatal = true; throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      return { data, whole: res.status === 200 };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      postMessage({ type: 'progress', stage: 'retry', attempt: attempt + 1 });
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
    }
  }
  throw new Error(`network error: ${lastErr?.message || lastErr}`);
}

async function prefetch(lm) {
  const cache = await caches.open(env.cacheKey);
  const files = bigFiles(lm);
  const total = files.reduce((n, [, mb]) => n + mb * MB, 0);
  let done = 0;
  for (const [path, mb] of files) {
    const url = REPO_URL + path;
    if (await cache.match(url)) { done += mb * MB; continue; }
    let blob = new Blob([]); // grows chunk by chunk; the browser can keep it on disk
    let offset = 0;
    for (;;) {
      const { data, whole } = await fetchRange(url, offset, offset + CHUNK - 1);
      blob = new Blob([blob, data], { type: 'application/octet-stream' });
      offset += data.length;
      postMessage({ type: 'progress', stage: 'download', loaded: done + offset, total });
      if (whole || data.length < CHUNK) break;
    }
    await cache.put(url, new Response(blob, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(blob.size) } }));
    done += mb * MB;
  }
}

async function load() {
  if (model) return;
  if (loading) return loading;
  loading = (async () => {
    const lm = await pickLmDtype();
    // drop a cached copy of the repo's generation_config.json (it ends speech on a normal speech code)
    try { const c = await caches.open(env.cacheKey); await c.delete(`${REPO_URL}generation_config.json`); } catch { /* ignore */ }
    await prefetch(lm);
    postMessage({ type: 'progress', stage: 'prepare' });
    processor = await AutoProcessor.from_pretrained(MODEL_ID);
    model = await ChatterboxModel.from_pretrained(MODEL_ID, {
      device: 'webgpu',
      dtype: { embed_tokens: 'fp32', speech_encoder: 'fp32', language_model: lm, conditional_decoder: 'fp32' },
    });
    postMessage({ type: 'progress', stage: 'prepare' });
  })();
  try { await loading; } catch (e) { loading = null; model = null; throw e; }
}

async function speakerFor(voiceKey, audio) {
  if (speakerCache.has(voiceKey)) return speakerCache.get(voiceKey);
  const audio_values = new Tensor('float32', audio, [1, audio.length]);
  const out = await model.encode_speech(audio_values);
  speakerCache.set(voiceKey, out);
  return out;
}

async function synth({ id, chunks, language, voiceKey, audio, exaggeration }) {
  await load();
  const speaker = await speakerFor(voiceKey, audio);
  const pcms = [];
  const gap = new Float32Array(Math.round(SR * 0.22));
  for (let i = 0; i < chunks.length; i++) {
    postMessage({ type: 'progress', id, stage: 'speak', index: i + 1, count: chunks.length });
    const inputs = await processor(`[${language}]${chunks[i]}`);
    const waveform = await model.generate({
      ...inputs,
      ...speaker,
      exaggeration,
      max_new_tokens: 1000,
      min_new_tokens: Math.min(40, Math.round(chunks[i].length * 0.6)),
      repetition_penalty: 1.2,
      eos_token_id: 6562,
      do_sample: false,
    });
    const pcm = new Float32Array(waveform.data);
    const secs = pcm.length / SR;
    if (secs < Math.max(0.6, chunks[i].length / 45)) {
      throw new Error(`SHORT_OUTPUT ${secs.toFixed(2)}s for ${chunks[i].length} chars`);
    }
    pcms.push(pcm);
    if (i < chunks.length - 1) pcms.push(gap);
  }
  const total = pcms.reduce((n, p) => n + p.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const p of pcms) { merged.set(p, off); off += p.length; }
  postMessage({ type: 'done', id, samples: merged, sampleRate: SR }, [merged.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'synth') await synth(msg);
    else if (msg.type === 'warmup') { await load(); postMessage({ type: 'ready', id: msg.id }); }
    else if (msg.type === 'forget') speakerCache.delete(msg.voiceKey);
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
