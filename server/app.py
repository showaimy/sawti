"""
صوتي — سيرفر تحويل النص إلى صوت على Modal.

Runs Chatterbox Multilingual (Resemble AI, MIT) on a GPU that starts on demand and
shuts down when idle, so it only spends credits while generating.

Auth: every endpoint except /health needs  Authorization: Bearer <encodeURIComponent(SAWTI_PASSWORD)>

  GET  /health   -> {"ok": true, "engines": {"saudi": true, "habibi": true}}
  GET  /check    -> {"ok": true, "languages": [...], "presets": [...]}
  POST /voice    -> {"voice_key": "u-..."}      body: {"ref_audio": "<base64 wav/mp3/m4a>"}
                    Stores a custom voice once (kept across restarts), so later requests send only the key.
  POST /tts      -> audio/wav                    body: {"text": "...", "language": "ar",
                    "voice_key": "default" | "<preset id>" | "u-...", "exaggeration": 0.5, "cfg_weight": 0.5,
                    "temperature": 0.8, "dialect": "saudi" | "msa", "engine": "chatterbox" | "habibi", "speed": 1.0}
                    Arabic + dialect "saudi" uses the Saudi-dialect model (NAMAA-Saudi-TTS) when available.
                    engine "habibi" = Habibi-TTS Unified (Arabic only, needs an Arabic voice: Kareem or your own).
                    Its weights are CC BY-NC-SA 4.0: non-commercial use only.
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
SAUDI_REPO = "NAMAA-Space/NAMAA-Saudi-TTS"
# Habibi-TTS (SWivid, F5-TTS based). Unified weights: CC BY-NC-SA 4.0 -> non-commercial use only.
HABIBI_REPO = "SWivid/Habibi-TTS"
HABIBI_CKPT = "Unified/model_200000.safetensors"
HABIBI_VOCAB = "Unified/vocab.txt"
VOCOS_REPO = "charactr/vocos-mel-24khz"
WHISPER_REPO = "openai/whisper-large-v3-turbo"  # writes down what a reference clip says (Habibi needs it)
HABIBI_PRESETS = {"hq-p-kareem"}  # ready-made voices recorded in Arabic; Habibi reads Arabic only


class VoiceNotArabic(Exception):
    pass
MAX_REF_BYTES = 8 * 1024 * 1024

# Ready-made voices: each one is read once by an open Piper voice when the image is built,
# and Chatterbox then speaks any of its 23 languages in that voice. Ids match the website.
REF_AR = "السلامُ عليكم ورحمةُ الله. أهلاً وسهلاً بكم. اليومَ نتحدّثُ عن أهميةِ التخطيطِ الجيّد، وكيف يساعدُنا على إنجازِ أعمالِنا بهدوءٍ ووضوح. خذوا وقتَكم، واستمتعوا بالرحلة."
REF_EN = "Hello, and welcome. Today we are talking about the value of good planning, and how it helps us finish our work calmly and clearly. Take your time, breathe, and enjoy the journey ahead of you."
PRESET_LANG = {"hq-p-kareem": "ar"}  # all other presets were recorded in English
PRESETS = {
    "hq-p-kareem": ("ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx", REF_AR),
    "hq-p-hannah": ("en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx", REF_EN),
    "hq-p-henry": ("en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx", REF_EN),
    "hq-p-lessac": ("en/en_US/lessac/medium/en_US-lessac-medium.onnx", REF_EN),
    "hq-p-ryan": ("en/en_US/ryan/medium/en_US-ryan-medium.onnx", REF_EN),
    "hq-p-alba": ("en/en_GB/alba/medium/en_GB-alba-medium.onnx", REF_EN),
    "hq-p-alan": ("en/en_GB/alan/medium/en_GB-alan-medium.onnx", REF_EN),
}


# ---------- Arabic numbers -> words ----------
# The Saudi model reads digits poorly (its model card says so), so numbers are spelled out first.
_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫٬٪", "01234567890123456789.,%")
_ONES = ["", "واحد", "اثنين", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"]
_TENS = ["", "عشرة", "عشرين", "ثلاثين", "أربعين", "خمسين", "ستين", "سبعين", "ثمانين", "تسعين"]
_SHORT = ["", "", "", "ثلاث", "أربع", "خمس", "ست", "سبع", "ثمان", "تسع", "عشر"]
_FULL = ["", "", "", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة"]
_SCALES = ((10**9, "مليار", "مليارين", "مليارات"), (10**6, "مليون", "مليونين", "ملايين"), (1000, "ألف", "ألفين", "آلاف"))


def _under_100(n):
    if n < 10:
        return _ONES[n]
    if n == 10:
        return "عشرة"
    if n == 11:
        return "أحد عشر"
    if n == 12:
        return "اثنا عشر"
    if n < 20:
        return _ONES[n - 10] + " عشر"
    t, o = divmod(n, 10)
    return f"{_ONES[o]} و{_TENS[t]}" if o else _TENS[t]


def _under_1000(n, saudi):
    h, r = divmod(n, 100)
    parts = []
    if h == 1:
        parts.append("مية" if saudi else "مئة")
    elif h == 2:
        parts.append("ميتين" if saudi else "مئتين")
    elif h:
        parts.append(f"{_SHORT[h]} مية" if saudi else f"{_SHORT[h]}مئة")
    if r:
        parts.append(_under_100(r))
    return " و".join(parts)


def number_words(n, saudi=True):
    if n == 0:
        return "صفر"
    out = []
    for value, one, two, plural in _SCALES:
        q, n = divmod(n, value)
        if q == 1:
            out.append(one)
        elif q == 2:
            out.append(two)
        elif 3 <= q <= 10:
            out.append(f"{(_SHORT if saudi else _FULL)[q]} {plural}")
        elif q:
            out.append(f"{number_words(q, saudi)} {one}")
    if n:
        out.append(_under_1000(n, saudi))
    return " و".join(out)


def _digits_one_by_one(s):
    return " ".join("صفر" if d == "0" else _ONES[int(d)] for d in s)


def spell_numbers_ar(text, saudi=True):
    """'خصم 25% على 1,500 ريال الساعة 10:30' -> words. Phone-like numbers are read digit by digit."""
    import re

    text = text.translate(_DIGITS)
    percent = "بالمية" if saudi else "بالمئة"

    def time(m):
        h, mi = int(m.group(1)), int(m.group(2))
        if mi == 0:
            return number_words(h, saudi)
        if mi == 30 and saudi:
            return f"{number_words(h, saudi)} ونص"
        return f"{number_words(h, saudi)} و{number_words(mi, saudi)}"

    def num(m):
        whole, frac, pct = m.group(1).replace(",", ""), m.group(2), m.group(3)
        if (len(whole) > 1 and whole.startswith("0")) or len(whole) > 12:
            words = _digits_one_by_one(whole)
        else:
            words = number_words(int(whole), saudi)
        if frac:
            frac_words = number_words(int(frac), saudi) if len(frac) <= 2 and not frac.startswith("0") else _digits_one_by_one(frac)
            words += f" فاصلة {frac_words}"
        if pct:
            words += f" {percent}"
        src, a, b = m.string, m.start(), m.end()
        # keep one-letter prefixes attached (و13 -> وثلاثة عشر), otherwise keep words apart
        prefix = a >= 1 and src[a - 1].isalpha() and (src[a - 1] not in "وبلكف" or (a >= 2 and src[a - 2].isalpha()))
        suffix = b < len(src) and src[b].isalpha()
        return (" " if prefix else "") + words + (" " if suffix else "")

    text = re.sub(r"(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])", time, text)
    text = re.sub(r"(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(%)?", num, text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


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
    # Saudi-dialect speech model (NAMAA Community, MIT): same architecture, Saudi-tuned T3 weights.
    try:
        snapshot_download(repo_id=SAUDI_REPO, repo_type="model", revision="main", allow_patterns=["t3_mtl23ls_v2.safetensors"])
    except Exception as e:  # keep building; the server then runs without the Saudi engine
        print("Saudi weights FAILED:", repr(e))


def download_habibi():
    from huggingface_hub import hf_hub_download, snapshot_download

    try:
        for f in (HABIBI_CKPT, HABIBI_VOCAB):
            hf_hub_download(HABIBI_REPO, f)
        for f in ("config.yaml", "pytorch_model.bin"):
            hf_hub_download(VOCOS_REPO, f)
        snapshot_download(WHISPER_REPO, allow_patterns=["*.json", "*.safetensors", "*.txt"])
    except Exception as e:  # keep building; the server then runs without Habibi
        print("Habibi weights FAILED:", repr(e))


def _habibi_files_present():
    try:
        from huggingface_hub import hf_hub_download

        hf_hub_download(HABIBI_REPO, HABIBI_CKPT, local_files_only=True)
        return True
    except Exception:
        return False


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
    .pip_install(
        "chatterbox-tts==0.1.7", "fastapi[standard]==0.115.12", "soundfile", "piper-tts==1.8.0",
        "habibi-tts==0.1.1",
        # pinned so they work with NumPy 1.26 (Chatterbox needs NumPy < 2); newer pyarrow needs NumPy 2
        "datasets==4.0.0", "pyarrow==20.0.0",
    )
    # torchcodec comes in with F5-TTS but its current build needs a newer PyTorch/CUDA than Chatterbox's.
    # Nothing here uses it, and transformers falls back to other audio readers without it.
    .run_commands("pip uninstall -y torchcodec")
    .env({"HF_HOME": MODEL_DIR, "HF_HUB_DISABLE_TELEMETRY": "1"})
    .run_function(download_weights)   # weights baked into the image: faster cold starts
    .run_function(make_preset_refs)   # ready-made voice clips baked in too
    .run_function(download_habibi)    # Habibi + its vocoder + Whisper, also baked in
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
        self.t3_base = self.model.t3
        self.t3_saudi = self._load_saudi_t3()
        # Keep references only: Chatterbox's voice tensors cannot be deep-copied. generate() replaces
        # conds.t3 when the expression level changes, so each request works on a shallow copy.
        self.default_conds = self.model.conds
        self.cond_cache = {}
        self.lock = threading.Lock()  # the model keeps per-voice state: one generation at a time
        self.presets = sorted(k for k in PRESETS if os.path.exists(f"{REF_DIR}/{k}.wav"))
        # Habibi loads on first use, so the usual start stays as fast as before
        self.habibi_ready = _habibi_files_present()
        self.habibi = None
        self.habibi_load_lock = threading.Lock()
        self.habibi_lock = threading.Lock()
        self.habibi_refs = {}  # voice key -> (trimmed reference wav, what it says)
        self.asr = None

    def _load_saudi_t3(self):
        """Loads NAMAA's Saudi-dialect T3 next to the base one. Returns None if unavailable."""
        try:
            from pathlib import Path
            from huggingface_hub import snapshot_download
            from safetensors.torch import load_file
            from chatterbox.models.t3 import T3
            from chatterbox.models.t3.modules.t3_config import T3Config

            ckpt = Path(snapshot_download(repo_id=SAUDI_REPO, repo_type="model", revision="main",
                                          allow_patterns=["t3_mtl23ls_v2.safetensors"], local_files_only=True))
            state = load_file(str(ckpt / "t3_mtl23ls_v2.safetensors"))
            if "model" in state.keys():
                state = state["model"][0]
            t3 = T3(T3Config.multilingual())
            t3.load_state_dict(state)
            t3.to("cuda").eval()
            print("Saudi engine ready")
            return t3
        except Exception as e:
            import traceback
            traceback.print_exc()
            print("Saudi engine unavailable:", repr(e))
            return None

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

    # ---------- Habibi ----------
    def _load_habibi(self):
        if self.habibi is None:
            with self.habibi_load_lock:
                if self.habibi is None:
                    from importlib.resources import files
                    from huggingface_hub import hf_hub_download
                    from hydra.utils import get_class
                    from omegaconf import OmegaConf
                    from f5_tts.infer.utils_infer import load_model, load_vocoder

                    cfg = OmegaConf.load(str(files("f5_tts").joinpath("configs/F5TTS_v1_Base.yaml")))
                    mel = cfg.model.mel_spec.mel_spec_type
                    model = load_model(
                        get_class(f"f5_tts.model.{cfg.model.backbone}"), cfg.model.arch,
                        hf_hub_download(HABIBI_REPO, HABIBI_CKPT), mel_spec_type=mel,
                        vocab_file=hf_hub_download(HABIBI_REPO, HABIBI_VOCAB), device="cuda",
                    )
                    vocoder = load_vocoder(vocoder_name=mel, device="cuda")
                    self.habibi = (model, vocoder, mel)
                    print("Habibi ready")
        return self.habibi

    def _transcribe(self, path):
        import torch
        from transformers import pipeline

        if self.asr is None:
            try:
                self.asr = pipeline("automatic-speech-recognition", model=WHISPER_REPO, dtype=torch.float16, device="cuda")
            except TypeError:  # older transformers
                self.asr = pipeline("automatic-speech-recognition", model=WHISPER_REPO, torch_dtype=torch.float16, device="cuda")
        import soundfile as sf

        audio, sr = sf.read(path, dtype="float32", always_2d=True)  # samples, not a file path: no decoder needed
        out = self.asr({"raw": audio.mean(axis=1), "sampling_rate": sr}, chunk_length_s=30, return_timestamps=False,
                       generate_kwargs={"task": "transcribe", "language": "arabic"})
        return out["text"].strip()

    def _habibi_ref(self, voice_key, ref_bytes):
        """Trims the voice clip to at most 12 s (Habibi's limit) and writes down what it says."""
        if voice_key in self.habibi_refs:
            return self.habibi_refs[voice_key]
        import os
        import tempfile
        from f5_tts.infer.utils_infer import preprocess_ref_audio_text

        fd, raw = tempfile.mkstemp(suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(ref_bytes)
            # a placeholder text skips F5's own transcription; ours below is forced to Arabic
            trimmed, _ = preprocess_ref_audio_text(raw, "-", show_info=lambda *a, **k: None)
        finally:
            os.remove(raw)
        ref_text = self._transcribe(trimmed)
        if not ref_text.endswith((".", "。", "!", "؟", "?")):
            ref_text += "."
        ref_text += " "
        print(f"Habibi reference {voice_key}: {ref_text!r}")
        self.habibi_refs[voice_key] = (trimmed, ref_text)
        return trimmed, ref_text

    def synthesize_habibi(self, text, dialect, speed, voice_key):
        import io
        import numpy as np
        import soundfile as sf

        if voice_key not in HABIBI_PRESETS and not voice_key.startswith("u-"):
            raise VoiceNotArabic(voice_key)
        ref = self._ref_bytes(voice_key)  # KeyError -> unknown voice
        saudi = dialect == "saudi"
        text = spell_numbers_ar(text, saudi=saudi)
        model, vocoder, mel = self._load_habibi()
        from habibi_tts.infer.utils_infer import infer_process
        from habibi_tts.model.utils import dialect_id_map

        with self.habibi_lock:
            ref_audio, ref_text = self._habibi_ref(voice_key, ref)
            wave, sr, _ = infer_process(
                ref_audio, ref_text, text, model, vocoder, mel_spec_type=mel,
                show_info=lambda *a, **k: None, progress=None, nfe_step=32, cfg_strength=2.0,
                speed=speed, device="cuda", dialect_id=dialect_id_map["SAU" if saudi else "MSA"],
            )
        audio = np.asarray(wave, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), len(audio) / sr

    @modal.method()
    def selftest(self, text="هلا والله! تدري إن قلة النوم تأثر على مزاجك وتركيزك في الشغل؟ نصيحتنا لك: نام من 7 إلى 8 ساعات، وابعد الجوال قبل النوم بنص ساعة."):
        """Run from CI after a deploy: one sample per engine, plus what Whisper hears in it."""
        import os
        import tempfile

        jobs = [
            ("namaa-saudi", lambda: self.synthesize(text, "ar", 0.4, 0.5, "hq-p-kareem", "saudi", 0.7)),  # calm explainer
            ("habibi-saudi", lambda: self.synthesize_habibi(text, "saudi", 1.0, "hq-p-kareem")),
        ]
        import traceback

        out = []
        for name, job in jobs:
            try:
                wav, secs = job()
            except Exception as e:
                traceback.print_exc()
                out.append({"name": name, "error": f"generating: {type(e).__name__}: {e}"})
                continue
            try:
                fd, path = tempfile.mkstemp(suffix=".wav")
                with os.fdopen(fd, "wb") as f:
                    f.write(wav)
                heard = self._transcribe(path)
                os.remove(path)
            except Exception as e:
                traceback.print_exc()
                heard = f"(could not transcribe: {type(e).__name__}: {e})"
            out.append({"name": name, "seconds": round(secs, 2), "heard": heard, "wav": wav})
        return out

    def synthesize(self, text, language, exaggeration, cfg_weight, voice_key, dialect="saudi", temperature=0.8):
        import io
        import numpy as np
        import soundfile as sf

        ref = self._ref_bytes(voice_key)  # KeyError -> unknown voice
        # Chatterbox guidance: when the reference voice speaks another language, cfg_weight=0 avoids
        # carrying its accent over (e.g. an English voice speaking Saudi Arabic).
        ref_lang = PRESET_LANG.get(voice_key, "en" if voice_key in PRESETS else None)
        if ref_lang and ref_lang != language:
            cfg_weight = 0.0
        use_saudi = language == "ar" and dialect == "saudi" and self.t3_saudi is not None
        if language == "ar":
            text = spell_numbers_ar(text, saudi=dialect == "saudi")
        with self.lock:
            self.model.t3 = self.t3_saudi if use_saudi else self.t3_base
            self._use_voice(voice_key or "default", ref, exaggeration)
            wav = self.model.generate(text, language_id=language, exaggeration=exaggeration,
                                      cfg_weight=cfg_weight, temperature=temperature)
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
            # no secrets here: only whether the Saudi-dialect model loaded, so a deploy can be checked
            return {"ok": True, "engines": {"saudi": self.t3_saudi is not None, "habibi": self.habibi_ready}}

        @api.get("/check")
        def check(authorization: str = Header(default="")):
            check_auth(authorization)
            return {"ok": True, "languages": sorted(SUPPORTED_LANGUAGES), "presets": self.presets,
                    "engines": {"saudi": self.t3_saudi is not None, "habibi": self.habibi_ready}}

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
            temperature = min(max(float(body.get("temperature", 0.8)), 0.4), 1.2)
            dialect = "msa" if str(body.get("dialect", "saudi")).lower() == "msa" else "saudi"
            voice_key = str(body.get("voice_key") or "default")
            engine = "habibi" if str(body.get("engine", "")).lower() == "habibi" else "chatterbox"
            speed = min(max(float(body.get("speed", 1.0)), 0.7), 1.3)
            if engine == "habibi":
                if language != "ar":
                    raise HTTPException(status_code=400, detail="habibi speaks Arabic only")
                if not self.habibi_ready:
                    raise HTTPException(status_code=503, detail="habibi not installed")
            try:
                if engine == "habibi":
                    wav, seconds = await run_in_threadpool(self.synthesize_habibi, text, dialect, speed, voice_key)
                else:
                    wav, seconds = await run_in_threadpool(self.synthesize, text, language, exaggeration, cfg_weight,
                                                           voice_key, dialect, temperature)
            except VoiceNotArabic:
                raise HTTPException(status_code=422, detail="habibi needs an Arabic voice")
            except KeyError:
                raise HTTPException(status_code=404, detail="unknown voice")
            except Exception as e:
                import traceback
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"generation failed: {type(e).__name__}")
            return Response(content=wav, media_type="audio/wav", headers={"X-Audio-Seconds": f"{seconds:.2f}"})

        return api
