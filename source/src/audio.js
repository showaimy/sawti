// Audio helpers: decode + resample to mono, record from the microphone.

export async function decodeToMono(arrayBuffer, targetRate = 24000) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try { decoded = await ctx.decodeAudioData(arrayBuffer.slice(0)); } finally { ctx.close?.(); }
  const frames = Math.ceil(decoded.duration * targetRate);
  const off = new OfflineAudioContext(1, frames, targetRate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}

// Trim leading/trailing silence and cap the length.
export function tidyClip(samples, rate = 24000, maxSeconds = 30) {
  const thr = 0.01;
  let a = 0, b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < thr) a++;
  while (b > a && Math.abs(samples[b]) < thr) b--;
  a = Math.max(0, a - Math.round(rate * 0.1));
  b = Math.min(samples.length, b + Math.round(rate * 0.1));
  return samples.slice(a, Math.min(b, a + maxSeconds * rate));
}

export class Recorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
    this.startedAt = Date.now();
  }
  stop() {
    return new Promise((resolve) => {
      this.rec.onstop = async () => {
        this.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' }));
      };
      this.rec.stop();
    });
  }
  get seconds() { return (Date.now() - this.startedAt) / 1000; }
}
