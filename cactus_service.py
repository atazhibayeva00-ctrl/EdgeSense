#!/usr/bin/env python3
"""
EchoPath - Cactus local inference (official API)
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
    from cactus import cactus_init, cactus_complete, cactus_destroy, cactus_transcribe
    model = cactus_init(MODEL_PATH)
    print(f"[cactus] VLM loaded: {MODEL_PATH}")
    whisper_model = cactus_init(WHISPER_MODEL_PATH)
    print(f"[cactus] Whisper loaded: {WHISPER_MODEL_PATH}")
except Exception as e:
    print(f"[cactus] Init failed: {e}", file=sys.stderr)
    model = None
    whisper_model = None


def _data_url_to_temp_file(data_url: str):
    """Decode data URL (e.g. data:image/jpeg;base64,...) to a temp file path. Caller must unlink."""
    m = re.match(r"data:image/(\w+);base64,(.+)", data_url.strip())
    if not m:
        raise ValueError("Invalid image data URL")
    ext = m.group(1).lower()
    if ext == "jpeg":
        ext = "jpg"
    b64 = m.group(2)
    raw = base64.b64decode(b64)
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


def _parse_structured_response(response_text: str):
    """Parse VLM response into { confidence, hazards, tags, short }. Handles JSON or plain text."""
    text = (response_text or "").strip()
    # Try JSON first (we prompt the VLM to return JSON)
    try:
        # Strip markdown code block if present
        if text.startswith("```"):
            text = re.sub(r"^```\w*\n?", "", text)
            text = re.sub(r"\n?```\s*$", "", text)
        parsed = json.loads(text)
        confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0.5))))
        hazards = parsed.get("hazards") or []
        tags = parsed.get("tags") or []
        short = (parsed.get("short") or "Scene analyzed.")[:500]
        return {"confidence": confidence, "hazards": hazards, "tags": tags, "short": short}
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return {
        "confidence": 0.5,
        "hazards": [],
        "tags": [],
        "short": text[:300] if text else "Scene analyzed.",
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
    if whisper_model is None:
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

    wav_path = None
    try:
        wav_path, _ = _audio_bytes_to_wav_path(raw, content_type)
        response_str = cactus_transcribe(whisper_model, wav_path, prompt=WHISPER_PROMPT)
        result = json.loads(response_str)
        transcript = (result.get("response") or "").strip()
        return jsonify({"transcript": transcript, "success": True})
    except Exception as e:
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
    print(f"[cactus] EchoPath edge service on port {port} (model={MODEL_PATH})")
    if model is None:
        print("[cactus] ERROR: Model not loaded. Check CACTUS_MODEL_PATH and cactus_init.", file=sys.stderr)
        sys.exit(1)
    app.run(host="0.0.0.0", port=port, debug=False)
