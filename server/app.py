"""
صوتي — سيرفر تحويل النص إلى صوت على Modal.

Runs Chatterbox Multilingual (Resemble AI, MIT) on a GPU that starts on demand and
shuts down when idle, so it only spends credits while generating.

Endpoints (all except /health need the header  Authorization: Bearer <SAWTI_PASSWORD>):
  GET  /health        -> {"ok": true}
  GET  /check         -> {"ok": true} if the password is right
  POST /tts           -> audio/wav
       JSON: {"chunks": ["..."], "language": "ar", "exaggeration": 0.5, "cfg_weight": 0.5,
              "ref_audio": "<base64 wav, optional>"}
       Without ref_audio the model's built-in voice is used.

Deploy:  modal deploy server/app.py   (GitHub Actions does this on every push to server/)
URL:     https://<workspace>--sawti.modal.run
"""

import modal

APP_NAME = "sawti-tts"
MODEL_DIR = "/models"
ALLOWED_ORIGINS = [
    "https://showaimy.github.io",
    "http://localhost:4173",
    "http://localhost:5173",
]
MAX_CHARS = 6000          # per request
MAX_CHUNK_CHARS = 400     # per sentence group
MAX_REF_BYTES = 8 * 1024 * 1024


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


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install("chatterbox-tts==0.1.7", "fastapi[standard]==0.115.12", "soundfile")
    .env({"HF_HOME": MODEL_DIR, "HF_HUB_DISABLE_TELEMETRY": "1"})
    .run_function(download_weights)  # weights are baked into the image: faster cold starts
)

app = modal.App(APP_NAME)


@app.cls(
    image=image,
    gpu="T4",                      # ~0.59 $/hour while running; change to "L4" for more speed
    secrets=[modal.Secret.from_name("sawti-auth")],
    scaledown_window=180,          # stay warm 3 minutes after the last request, then stop
    timeout=600,
    max_containers=1,              # personal use: never more than one GPU at a time
)
@modal.concurrent(max_inputs=4)
class TTS:
    @modal.enter()
    def load(self):
        import copy
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        self.torch = torch
        self.model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
        self.default_conds = copy.deepcopy(self.model.conds)
        self.cond_cache = {}  # sha256 of reference audio -> Conditionals
        import threading
        self.lock = threading.Lock()  # the model keeps per-voice state, so one generation at a time

    def _use_voice(self, ref_bytes, exaggeration):
        import copy
        import hashlib
        import os
        import tempfile

        if not ref_bytes:
            self.model.conds = copy.deepcopy(self.default_conds)
            return
        key = hashlib.sha256(ref_bytes).hexdigest()
        if key in self.cond_cache:
            self.model.conds = copy.deepcopy(self.cond_cache[key])
            return
        fd, path = tempfile.mkstemp(suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(ref_bytes)
            self.model.prepare_conditionals(path, exaggeration=exaggeration)
        finally:
            os.remove(path)
        if len(self.cond_cache) >= 16:
            self.cond_cache.pop(next(iter(self.cond_cache)))
        self.cond_cache[key] = copy.deepcopy(self.model.conds)

    def synthesize(self, chunks, language, exaggeration, cfg_weight, ref_bytes):
        import io
        import numpy as np
        import soundfile as sf

        sr = self.model.sr
        gap = np.zeros(int(sr * 0.22), dtype=np.float32)
        parts = []
        with self.lock:
            self._use_voice(ref_bytes, exaggeration)
            for i, text in enumerate(chunks):
                wav = self.model.generate(
                    text,
                    language_id=language,
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                )
                parts.append(wav.squeeze(0).numpy().astype(np.float32))
                if i < len(chunks) - 1:
                    parts.append(gap)
        audio = np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), len(audio) / sr

    @modal.asgi_app(label="sawti")
    def web(self):
        import base64
        import hmac
        import os

        from fastapi import FastAPI, Header, HTTPException, Request
        from fastapi.concurrency import run_in_threadpool
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import Response
        from chatterbox.mtl_tts import SUPPORTED_LANGUAGES

        password = os.environ.get("SAWTI_PASSWORD", "")
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
            given = (authorization or "").removeprefix("Bearer ").strip()
            if not password or not hmac.compare_digest(given.encode(), password.encode()):
                raise HTTPException(status_code=401, detail="wrong password")

        @api.get("/health")
        def health():
            return {"ok": True}

        @api.get("/check")
        def check(authorization: str = Header(default="")):
            check_auth(authorization)
            return {"ok": True, "languages": sorted(SUPPORTED_LANGUAGES)}

        @api.post("/tts")
        async def tts(request: Request, authorization: str = Header(default="")):
            check_auth(authorization)
            try:
                body = await request.json()
            except Exception:
                raise HTTPException(status_code=400, detail="invalid JSON")

            chunks = [str(c).strip() for c in body.get("chunks", []) if str(c).strip()]
            if not chunks:
                raise HTTPException(status_code=400, detail="no text")
            if sum(len(c) for c in chunks) > MAX_CHARS or any(len(c) > MAX_CHUNK_CHARS for c in chunks):
                raise HTTPException(status_code=413, detail="text too long")
            language = str(body.get("language", "ar")).lower()
            if language not in SUPPORTED_LANGUAGES:
                raise HTTPException(status_code=400, detail="unsupported language")
            exaggeration = min(max(float(body.get("exaggeration", 0.5)), 0.25), 2.0)
            cfg_weight = min(max(float(body.get("cfg_weight", 0.5)), 0.0), 1.0)

            ref_bytes = None
            if body.get("ref_audio"):
                try:
                    ref_bytes = base64.b64decode(body["ref_audio"], validate=True)
                except Exception:
                    raise HTTPException(status_code=400, detail="bad ref_audio")
                if len(ref_bytes) > MAX_REF_BYTES:
                    raise HTTPException(status_code=413, detail="ref_audio too large")

            wav, seconds = await run_in_threadpool(
                self.synthesize, chunks, language, exaggeration, cfg_weight, ref_bytes
            )
            return Response(content=wav, media_type="audio/wav", headers={"X-Audio-Seconds": f"{seconds:.2f}"})

        return api
