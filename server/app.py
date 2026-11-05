"""
صوتي — سيرفر تحويل النص إلى صوت على Modal.

Runs Chatterbox Multilingual (Resemble AI, MIT) on a GPU that starts on demand and
shuts down when idle, so it only spends credits while generating.

Auth: every endpoint except /health needs  Authorization: Bearer <encodeURIComponent(SAWTI_PASSWORD)>

  GET  /health   -> {"ok": true}
  GET  /check    -> {"ok": true, "languages": [...], "presets": [...]}
  POST /voice    -> {"voice_key": "u-..."}      body: {"ref_audio": "<base64 wav/mp3/m4a>"}
                    Stores a custom voice once (kept across restarts), so later requests send only the key.
  POST /tts      -> audio/wav                    body: {"text": "...", "language": "ar",
                    "voice_key": "default" | "<preset id>" | "u-...", "exaggeration": 0.5, "cfg_weight": 0.5}
                    One sentence group per request keeps each call well under the web timeout.
                    404 {"detail": "unknown voice"} means: upload the voice again with /voice.

Deploy:  modal deploy server/app.py   (GitHub Actions does this on every push to server/)
URL:     https://<workspace>--sawti.<region>.modal.run  (shown by modal deploy)
"""

import modal

APP_NAME = "sawti-tts"
MODEL_DIR = "/models"
REF_DIR = "/refs"
ALLOWED_ORIGINS = [
    "https://showaimy.github.io",
    "http://localhost:4173",
    "http://localhost:5173",
]
MAX_TEXT_CHARS = 600
MAX_REF_BYTES = 8 * 1024 * 1024

# Ready-made voices: each one is read once by an open Piper voice when the image is built,
# and Chatterbox then speaks any of its 23 languages in that voice. Ids match the website.
REF_AR = "السلامُ عليكم ورحمةُ الله. أهلاً وسهلاً بكم. اليومَ نتحدّثُ عن أهميةِ التخطيطِ الجيّد، وكيف يساعدُنا على إنجازِ أعمالِنا بهدوءٍ ووضوح. خذوا وقتَكم، واستمتعوا بالرحلة."
REF_EN = "Hello, and welcome. Today we are talking about the value of good planning, and how it helps us finish our work calmly and clearly. Take your time, breathe, and enjoy the journey ahead of you."
PRESETS = {
    "hq-p-kareem": ("ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx", REF_AR),
    "hq-p-hannah": ("en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx", REF_EN),
    "hq-p-henry": ("en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx", REF_EN),
    "hq-p-lessac": ("en/en_US/lessac/medium/en_US-lessac-medium.onnx", REF_EN),
    "hq-p-ryan": ("en/en_US/ryan/medium/en_US-ryan-medium.onnx", REF_EN),
    "hq-p-alba": ("en/en_GB/alba/medium/en_GB-alba-medium.onnx", REF_EN),
    "hq-p-alan": ("en/en_GB/alan/medium/en_GB-alan-medium.onnx", REF_EN),
}


def download_weights():
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id="ResembleAI/chatterbox",
        repo_type="model",
        revision="main",
        allow_patterns=[
            "ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt",
            "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json",
        ],
    )


def make_preset_refs():
    """Builds one reference clip per ready-made voice. A failure here only drops that voice."""
    import os
    import wave
    from huggingface_hub import hf_hub_download
    from piper import PiperVoice, SynthesisConfig

    os.makedirs(REF_DIR, exist_ok=True)
    for key, (path, text) in PRESETS.items():
        try:
            model = hf_hub_download("rhasspy/piper-voices", path)
            hf_hub_download("rhasspy/piper-voices", path + ".json")
            voice = PiperVoice.load(model)
            if path.startswith("ar/"):
                voice.use_tashkeel = True  # adds missing diacritics, clearer Arabic
            with wave.open(f"{REF_DIR}/{key}.wav", "wb") as w:
                voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=1.0))
            print("preset ready:", key)
        except Exception as e:  # keep building; the site falls back for missing presets
            print("preset FAILED:", key, repr(e))


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install("chatterbox-tts==0.1.7", "fastapi[standard]==0.115.12", "soundfile", "piper-tts==1.8.0")
    .env({"HF_HOME": MODEL_DIR, "HF_HUB_DISABLE_TELEMETRY": "1"})
    .run_function(download_weights)   # weights baked into the image: faster cold starts
    .run_function(make_preset_refs)   # ready-made voice clips baked in too
)

app = modal.App(APP_NAME)
voices_store = modal.Dict.from_name("sawti-voices", create_if_missing=True)  # custom voices survive restarts


@app.cls(
    image=image,
    gpu="T4",                      # ~0.59 $/hour while running; "L4" is faster (~0.80 $/hour)
    secrets=[modal.Secret.from_name("sawti-auth")],
    scaledown_window=180,          # stay warm 3 minutes after the last request, then stop
    timeout=600,
    max_containers=1,              # personal use: never more than one GPU at a time
)
@modal.concurrent(max_inputs=4)
class TTS:
    @modal.enter()
    def load(self):
        import os
        import threading
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        self.model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
        # Keep references only: Chatterbox's voice tensors cannot be deep-copied. generate() replaces
        # conds.t3 when the expression level changes, so each request works on a shallow copy.
        self.default_conds = self.model.conds
        self.cond_cache = {}
        self.lock = threading.Lock()  # the model keeps per-voice state: one generation at a time
        self.presets = sorted(k for k in PRESETS if os.path.exists(f"{REF_DIR}/{k}.wav"))

    # ---------- voices ----------
    def _ref_bytes(self, voice_key):
        """Returns reference audio bytes for a voice key, or None for the built-in voice."""
        if voice_key in ("", "default", None):
            return None
        if voice_key in PRESETS:
            path = f"{REF_DIR}/{voice_key}.wav"
            try:
                with open(path, "rb") as f:
                    return f.read()
            except FileNotFoundError:
                raise KeyError(voice_key)
        if voice_key.startswith("u-"):
            data = voices_store.get(voice_key)
            if data is None:
                raise KeyError(voice_key)
            return data
        raise KeyError(voice_key)

    def _use_voice(self, voice_key, ref_bytes, exaggeration):
        import copy
        import os
        import tempfile

        if ref_bytes is None:
            self.model.conds = copy.copy(self.default_conds)
            return
        if voice_key in self.cond_cache:
            self.model.conds = copy.copy(self.cond_cache[voice_key])
            return
        fd, path = tempfile.mkstemp(suffix=".audio")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(ref_bytes)
            self.model.prepare_conditionals(path, exaggeration=exaggeration)
        finally:
            os.remove(path)
        if len(self.cond_cache) >= 24:
            self.cond_cache.pop(next(iter(self.cond_cache)))
        self.cond_cache[voice_key] = self.model.conds
        self.model.conds = copy.copy(self.model.conds)

    def synthesize(self, text, language, exaggeration, cfg_weight, voice_key):
        import io
        import numpy as np
        import soundfile as sf

        ref = self._ref_bytes(voice_key)  # KeyError -> unknown voice
        with self.lock:
            self._use_voice(voice_key or "default", ref, exaggeration)
            wav = self.model.generate(text, language_id=language, exaggeration=exaggeration, cfg_weight=cfg_weight)
        audio = wav.squeeze(0).numpy().astype(np.float32)
        buf = io.BytesIO()
        sf.write(buf, audio, self.model.sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), len(audio) / self.model.sr

    @modal.asgi_app(label="sawti")
    def web(self):
        import base64
        import hashlib
        import hmac
        import os
        from urllib.parse import unquote

        from fastapi import FastAPI, Header, HTTPException, Request
        from fastapi.concurrency import run_in_threadpool
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import Response
        from chatterbox.mtl_tts import SUPPORTED_LANGUAGES

        # strip: a secret pasted with a trailing newline or space must still match
        password = os.environ.get("SAWTI_PASSWORD", "").strip()
        api = FastAPI(title="sawti-tts", docs_url=None, redoc_url=None)
        api.add_middleware(
            CORSMiddleware,
            allow_origins=ALLOWED_ORIGINS,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=["X-Audio-Seconds"],
            max_age=86400,
        )

        def check_auth(authorization):
            given = unquote((authorization or "").removeprefix("Bearer ").strip()).strip()
            if not password or not hmac.compare_digest(given.encode(), password.encode()):
                raise HTTPException(status_code=401, detail="wrong password")

        async def read_json(request):
            try:
                return await request.json()
            except Exception:
                raise HTTPException(status_code=400, detail="invalid JSON")

        @api.get("/health")
        def health():
            return {"ok": True}

        @api.get("/check")
        def check(authorization: str = Header(default="")):
            check_auth(authorization)
            return {"ok": True, "languages": sorted(SUPPORTED_LANGUAGES), "presets": self.presets}

        @api.post("/voice")
        async def add_voice(request: Request, authorization: str = Header(default="")):
            check_auth(authorization)
            body = await read_json(request)
            try:
                data = base64.b64decode(body.get("ref_audio", ""), validate=True)
            except Exception:
                raise HTTPException(status_code=400, detail="bad ref_audio")
            if not data:
                raise HTTPException(status_code=400, detail="empty ref_audio")
            if len(data) > MAX_REF_BYTES:
                raise HTTPException(status_code=413, detail="ref_audio too large")
            key = "u-" + hashlib.sha256(data).hexdigest()[:32]
            try:
                if await voices_store.get.aio(key) is None:
                    await voices_store.put.aio(key, data)
            except Exception as e:
                import traceback
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"could not store voice: {type(e).__name__}")
            return {"voice_key": key}

        @api.post("/tts")
        async def tts(request: Request, authorization: str = Header(default="")):
            check_auth(authorization)
            body = await read_json(request)
            text = str(body.get("text") or " ".join(str(c) for c in body.get("chunks", []))).strip()
            if not text:
                raise HTTPException(status_code=400, detail="no text")
            if len(text) > MAX_TEXT_CHARS:
                raise HTTPException(status_code=413, detail="text too long")
            language = str(body.get("language", "ar")).lower()
            if language not in SUPPORTED_LANGUAGES:
                raise HTTPException(status_code=400, detail="unsupported language")
            exaggeration = min(max(float(body.get("exaggeration", 0.5)), 0.25), 2.0)
            cfg_weight = min(max(float(body.get("cfg_weight", 0.5)), 0.0), 1.0)
            voice_key = str(body.get("voice_key") or "default")
            try:
                wav, seconds = await run_in_threadpool(self.synthesize, text, language, exaggeration, cfg_weight, voice_key)
            except KeyError:
                raise HTTPException(status_code=404, detail="unknown voice")
            except Exception as e:
                import traceback
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"generation failed: {type(e).__name__}")
            return Response(content=wav, media_type="audio/wav", headers={"X-Audio-Seconds": f"{seconds:.2f}"})

        return api
