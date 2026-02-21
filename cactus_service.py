#!/usr/bin/env python3
"""
EchoPath - Cactus FunctionGemma Local Service
Run on Apple Silicon Mac with Cactus SDK installed.

Usage:
  pip install flask cactus-ai
  python cactus_service.py

Exposes POST /infer endpoint for the Replit backend to call.
Set CACTUS_ENDPOINT_URL on Replit to point to this service.

For hackathon demo with ngrok:
  ngrok http 8090
  Then set CACTUS_ENDPOINT_URL=https://<ngrok-id>.ngrok.io on Replit
"""

import json
import time
import sys
from flask import Flask, request, jsonify

app = Flask(__name__)

model = None
CACTUS_AVAILABLE = False

try:
    import cactus
    model = cactus.Cactus(
        model_path="functionary-small-v3.2.Q4_0.gguf",
        use_metal=True
    )
    CACTUS_AVAILABLE = True
    print("[cactus] Model loaded successfully on Apple Silicon")
except Exception as e:
    print(f"[cactus] SDK not available: {e}")
    print("[cactus] Running in mock mode for testing")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "cactus_available": CACTUS_AVAILABLE,
        "device": "apple_silicon"
    })


@app.route("/infer", methods=["POST"])
def infer():
    start = time.time()
    data = request.get_json()
    messages = data.get("messages", [])
    tools = data.get("tools", [])

    user_msg = ""
    for msg in messages:
        if msg.get("role") == "user":
            user_msg = msg.get("content", "")

    if CACTUS_AVAILABLE and model:
        try:
            result = model.complete(
                messages=messages,
                tools=[{
                    "type": "function",
                    "function": t.get("function", t)
                } for t in tools] if tools else None
            )

            response_text = result.get("content", "") if isinstance(result, dict) else str(result)
            tool_calls = result.get("tool_calls", []) if isinstance(result, dict) else []

            if tool_calls:
                args = tool_calls[0].get("function", {}).get("arguments", "{}")
                try:
                    parsed = json.loads(args) if isinstance(args, str) else args
                    response_text = json.dumps(parsed)
                except:
                    pass

            elapsed = (time.time() - start) * 1000
            print(f"[cactus] Inference: {elapsed:.0f}ms")

            return jsonify({
                "response": response_text,
                "cloud_handoff": False,
                "latency_ms": elapsed,
                "source": "cactus_edge"
            })
        except Exception as e:
            print(f"[cactus] Inference error: {e}")
            return jsonify({
                "response": json.dumps({
                    "confidence": 0.4,
                    "hazards": [],
                    "tags": ["unknown"],
                    "short": f"Local model error: {str(e)[:50]}"
                }),
                "cloud_handoff": True,
                "source": "cactus_error"
            })
    else:
        import hashlib
        h = int(hashlib.md5(user_msg.encode()).hexdigest()[:4], 16) / 65535
        confidence = 0.55 + h * 0.4

        hazards = []
        tags = ["floor", "wall", "lighting"]

        if h > 0.6:
            tags.append("doorway")
        if h > 0.9:
            hazards.append({"label": "curb", "pos": "ahead", "severity": "medium"})
        if h < 0.1:
            hazards.append({"label": "obstacle", "pos": "left", "severity": "medium"})

        short = (
            f"Caution: {', '.join(x['label'] for x in hazards)} detected."
            if hazards
            else "Path appears clear. Proceed with caution."
        )

        elapsed = (time.time() - start) * 1000

        return jsonify({
            "response": json.dumps({
                "confidence": round(confidence, 2),
                "hazards": hazards,
                "tags": tags,
                "short": short
            }),
            "cloud_handoff": False,
            "latency_ms": elapsed,
            "source": "mock_edge"
        })


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    print(f"[cactus] Starting EchoPath edge service on port {port}")
    print(f"[cactus] Cactus SDK: {'LOADED' if CACTUS_AVAILABLE else 'MOCK MODE'}")
    app.run(host="0.0.0.0", port=port, debug=False)
