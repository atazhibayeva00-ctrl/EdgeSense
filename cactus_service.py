#!/usr/bin/env python3
"""
EdgeSense - Cactus local inference (official API)
- VLM (e.g. LFM2-VL-450M) for /infer (vision)
- Whisper for /transcribe (voice-to-action, Rubric 3)

Setup (from your Cactus clone):
  cd cactus && source ./setup && cd ..
  cactus build --python
  cactus download LiquidAI/LFM2-VL-450M   # VLM for vision
  cactus download openai/whisper-small    # for voice
  # Optional: CACTUS_MODEL_PATH, WHISPER_MODEL_PATH

Run: pip install flask && python cactus_service.py
Node: set CACTUS_ENDPOINT_URL to this service (e.g. http://localhost:8090).
"""

import atexit
import base64
import io
import json
import os
import re
import sys
import tempfile
import time
from flask import Flask, request, jsonify

app = Flask(__name__)

model = None
whisper_model = None
MODEL_PATH = os.environ.get("CACTUS_MODEL_PATH", "weights/lfm2-vl-450m")
WHISPER_MODEL_PATH = os.environ.get("WHISPER_MODEL_PATH", "weights/whisper-small")
WHISPER_PROMPT = "<|startoftranscript|><|en|><|transcribe|><|notimestamps|>"

try:
    try:
        from cactus import cactus_init, cactus_complete, cactus_destroy, cactus_transcribe
    except (ImportError, ModuleNotFoundError):
        from src.cactus import cactus_init, cactus_complete, cactus_destroy, cactus_transcribe
    model = cactus_init(MODEL_PATH)
    print(f"[cactus] VLM loaded: {MODEL_PATH}")
    whisper_model = cactus_init(WHISPER_MODEL_PATH)
    print(f"[cactus] Whisper loaded: {WHISPER_MODEL_PATH}")
except Exception as e:
    print(f"[cactus] Init failed: {e}", file=sys.stderr)
    model = None
    whisper_model = None


def _data_url_to_temp_file(data_url: str, target_size: int = 224):
    """Decode data URL to a temp file path, resizing to target_size square for the VLM."""
    m = re.match(r"data:image/(\w+);base64,(.+)", data_url.strip())
    if not m:
        raise ValueError("Invalid image data URL")
    ext = m.group(1).lower()
    if ext == "jpeg":
        ext = "jpg"
    b64 = m.group(2)
    raw = base64.b64decode(b64)
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(raw))
        img = img.resize((target_size, target_size), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        raw = buf.getvalue()
        ext = "jpg"
    except ImportError:
        pass
    f = tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}")
    f.write(raw)
    f.close()
    return f.name


def _prepare_messages(messages: list) -> tuple[list, list]:
    """
    Replace any base64 image data URLs in messages with temp file paths.
    Returns (prepared_messages, list of temp file paths to delete later).
    """
    out = []
    to_delete = []
    for msg in messages:
        m = dict(msg)
        images = m.get("images") or []
        if not images:
            out.append(m)
            continue
        paths = []
        for item in images:
            if isinstance(item, str) and item.startswith("data:"):
                path = _data_url_to_temp_file(item)
                to_delete.append(path)
                paths.append(path)
            else:
                paths.append(item)
        m["images"] = paths
        out.append(m)
    return out, to_delete


def _tools_to_cactus(tools: list) -> list:
    """Convert Node-style tools [{ function: { name, description, parameters } }] to Cactus format."""
    if not tools:
        return None
    out = []
    for t in tools:
        fn = t.get("function") or t
        out.append({
            "name": fn.get("name", "unknown"),
            "description": fn.get("description", ""),
            "parameters": fn.get("parameters", {}),
        })
    return out


def _is_readable(text: str) -> bool:
    """Check if text looks like readable English (not raw tokens/numbers)."""
    if not text or len(text) < 5:
        return False
    alpha_ratio = sum(c.isalpha() or c.isspace() for c in text) / len(text)
    return alpha_ratio > 0.6


def _parse_structured_response(response_text: str):
    """Parse VLM response into { confidence, hazards, tags, short }. Handles JSON or plain text."""
    text = (response_text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```\w*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    try:
        parsed = json.loads(text.replace("'", '"'))
        short = (
            parsed.get("short")
            or parsed.get("description")
            or parsed.get("response")
            or parsed.get("text")
            or parsed.get("summary")
            or "Scene analyzed."
        )
        confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0.5))))
        hazards = parsed.get("hazards") or []
        tags = parsed.get("tags") or []
        return {"confidence": confidence, "hazards": hazards, "tags": tags, "short": str(short)[:500]}
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    if _is_readable(text):
        return {
            "confidence": 0.4,
            "hazards": [],
            "tags": [],
            "short": text[:300],
        }
    return {
        "confidence": 0.1,
        "hazards": [],
        "tags": [],
        "short": "Scene analyzed.",
        "cloud_handoff": True,
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "cactus_available": model is not None,
        "whisper_available": whisper_model is not None,
        "model_path": MODEL_PATH,
        "whisper_path": WHISPER_MODEL_PATH,
    })


@app.route("/infer", methods=["POST"])
def infer():
    if model is None:
        return jsonify({"error": "Cactus model not loaded"}), 503

    start = time.time()
    data = request.get_json() or {}
    messages = data.get("messages", [])
    tools = data.get("tools", [])

    # Convert base64 images in messages to temp file paths (Cactus VLM expects file paths)
    try:
        messages, temp_paths = _prepare_messages(messages)
    except Exception as e:
        return jsonify({"error": f"Invalid image data: {e}"}), 400

    cactus_tools = _tools_to_cactus(tools)

    # VLM prompt: ask for structured JSON so we can parse confidence, hazards, tags, short
    # (Cactus VLM returns plain text; we don't rely on function_calls for the VLM)
    try:
        response_str = cactus_complete(
            model,
            messages,
            tools=cactus_tools,
            max_tokens=256,
        )
        result = json.loads(response_str)
    except Exception as e:
        for p in temp_paths:
            try:
                os.unlink(p)
            except OSError:
                pass
        return jsonify({
            "error": str(e),
            "response": json.dumps({
                "confidence": 0.3,
                "hazards": [],
                "tags": [],
                "short": "Local analysis failed. Try cloud.",
            }),
            "cloud_handoff": True,
        }), 200

    for p in temp_paths:
        try:
            os.unlink(p)
        except OSError:
            pass

    elapsed_ms = (time.time() - start) * 1000
    response_text = result.get("response") or ""
    cloud_handoff = result.get("cloud_handoff", False)
    confidence_sdk = result.get("confidence")

    # If Cactus returned function_calls (e.g. with FunctionGemma), use that; else parse response text
    function_calls = result.get("function_calls") or []
    if function_calls:
        fc = function_calls[0]
        args = fc.get("arguments") or fc.get("function", {}).get("arguments") or "{}"
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
            except json.JSONDecodeError:
                parsed = _parse_structured_response(response_text)
        else:
            parsed = args
        structured = {
            "confidence": max(0.0, min(1.0, float(parsed.get("confidence", 0.5)))),
            "hazards": parsed.get("hazards", []),
            "tags": parsed.get("tags", []),
            "short": (parsed.get("short") or "Scene analyzed.")[:500],
        }
    else:
        structured = _parse_structured_response(response_text)
        if confidence_sdk is not None:
            structured["confidence"] = max(0.0, min(1.0, float(confidence_sdk)))
        if structured.pop("cloud_handoff", False):
            cloud_handoff = True

    return jsonify({
        "response": json.dumps(structured),
        "cloud_handoff": cloud_handoff,
        "latency_ms": round(elapsed_ms, 2),
        "source": "cactus_edge",
    })


def _audio_bytes_to_wav_path(raw: bytes, content_type: str) -> tuple[str, bool]:
    """Write audio bytes to a temp WAV file. Returns (path, should_delete). Cactus expects WAV."""
    content_type = (content_type or "").lower()
    if "wav" in content_type or raw[:4] == b"RIFF":
        f = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        f.write(raw)
        f.close()
        return f.name, True
    # webm / ogg / mp4 -> convert to wav with pydub if available
    try:
        from pydub import AudioSegment
        ext = ".webm" if "webm" in content_type else ".mp4" if "mp4" in content_type else ".ogg"
        f_in = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
        f_in.write(raw)
        f_in.close()
        wav_path = f_in.name + ".wav"
        seg = AudioSegment.from_file(f_in.name, format=ext[1:])
        seg = seg.set_channels(1).set_frame_rate(16000).set_sample_width(2)
        seg.export(wav_path, format="wav")
        try:
            os.unlink(f_in.name)
        except OSError:
            pass
        return wav_path, True
    except Exception as e:
        print(f"[cactus] pydub convert failed: {e}", file=sys.stderr)
        raise ValueError("Send audio/wav or install pydub (+ ffmpeg) for webm/mp4") from e


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """Voice-to-action: accept audio (base64), return transcript via cactus_transcribe."""
    # #region agent log
    _dbg = lambda msg, d={}: open("/Users/atazhibayeva/EdgeSense/.cursor/debug-2a1712.log","a").write(json.dumps({"sessionId":"2a1712","location":"cactus_service.py:transcribe","message":msg,"data":d,"timestamp":int(time.time()*1000),"hypothesisId":"H2"})+"\n")
    # #endregion
    if whisper_model is None:
        # #region agent log
        _dbg("Whisper model NOT loaded")
        # #endregion
        return jsonify({"error": "Whisper model not loaded"}), 503

    data = request.get_json() or {}
    audio_b64 = data.get("audio_base64") or data.get("audioBase64")
    content_type = data.get("content_type") or data.get("contentType") or "audio/wav"
    if not audio_b64:
        return jsonify({"error": "audio_base64 required"}), 400

    try:
        raw = base64.b64decode(audio_b64)
    except Exception as e:
        return jsonify({"error": f"Invalid base64: {e}"}), 400

    # #region agent log
    _dbg("Audio received", {"raw_bytes": len(raw), "content_type": content_type})
    # #endregion

    wav_path = None
    try:
        wav_path, _ = _audio_bytes_to_wav_path(raw, content_type)
        # #region agent log
        _wav_size = os.path.getsize(wav_path) if os.path.exists(wav_path) else 0
        _dbg("WAV conversion ok", {"wav_path": wav_path, "wav_bytes": _wav_size})
        # #endregion
        response_str = cactus_transcribe(whisper_model, wav_path, prompt=WHISPER_PROMPT)
        result = json.loads(response_str)
        transcript = (result.get("response") or "").strip()
        # #region agent log
        _dbg("Transcription result", {"transcript": transcript[:100] if transcript else "", "len": len(transcript)})
        # #endregion
        return jsonify({"transcript": transcript, "success": True})
    except Exception as e:
        # #region agent log
        _dbg("Transcribe EXCEPTION", {"error": str(e)[:200]})
        # #endregion
        print(f"[cactus] transcribe error: {e}", file=sys.stderr)
        return jsonify({"error": str(e), "transcript": ""}), 200
    finally:
        if wav_path and os.path.exists(wav_path):
            try:
                os.unlink(wav_path)
            except OSError:
                pass


def _destroy():
    global model, whisper_model
    if model is not None:
        try:
            cactus_destroy(model)
        except Exception:
            pass
        model = None
    if whisper_model is not None:
        try:
            cactus_destroy(whisper_model)
        except Exception:
            pass
        whisper_model = None


atexit.register(_destroy)

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    print(f"[cactus] EdgeSense edge service on port {port} (model={MODEL_PATH})")
    if model is None:
        print("[cactus] ERROR: Model not loaded. Check CACTUS_MODEL_PATH and cactus_init.", file=sys.stderr)
        sys.exit(1)
    app.run(host="0.0.0.0", port=port, debug=False)
