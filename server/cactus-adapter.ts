import { log } from "./index";
import type { LocalInferenceResult } from "@shared/schema";

const CACTUS_ENDPOINT = process.env.CACTUS_ENDPOINT_URL || "";

async function runCactusRemote(imageDataUrl: string, mode: string, _testHazard: boolean): Promise<LocalInferenceResult> {
  if (!CACTUS_ENDPOINT) {
    throw new Error("CACTUS_ENDPOINT_URL is not set. Run the Cactus Python service and set the env var.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${CACTUS_ENDPOINT}/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You are a mobility safety assistant. Analyze the image and respond with ONLY a valid JSON object (no markdown) with keys: confidence (0-1), hazards (array of {label, pos, severity}), tags (array of strings), short (one sentence).",
          },
          {
            role: "user",
            content:
              mode === "hazard"
                ? "Analyze this image for mobility hazards (stairs, obstacles, drop-offs, curbs). Report any dangers in the JSON."
                : "Describe what you see in this scene briefly, in the JSON short field.",
            images: [imageDataUrl],
          },
        ],
        tools: [
          {
            function: {
              name: "report_hazards",
              description: "Report detected hazards and scene summary",
              parameters: {
                type: "object",
                properties: {
                  hazards: { type: "array", description: "List of {label, pos, severity}" },
                  confidence: { type: "number", description: "Confidence 0-1" },
                  tags: { type: "array", description: "Objects detected" },
                  short: { type: "string", description: "One sentence summary" },
                },
                required: ["hazards", "confidence", "tags", "short"],
              },
            },
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text();
      log(`Cactus HTTP ${res.status}: ${errBody.slice(0, 200)}`, "cactus");
      throw new Error(`Cactus returned ${res.status}`);
    }

    const data = await res.json();
    if (data.error && res.status >= 400) {
      throw new Error(data.error || "Cactus service error");
    }

    const responseText = data.response || "";

    try {
      const parsed = JSON.parse(responseText);
      return {
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
        hazards: (parsed.hazards || []).map((h: any) => ({
          label: h.label || "unknown",
          pos: h.pos || "ahead",
          severity: h.severity || "medium",
        })),
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        short: parsed.short || "Scene analyzed.",
        cloud_handoff: data.cloud_handoff === true,
      };
    } catch {
      log(`Cactus returned non-JSON response: ${responseText.slice(0, 100)}`, "cactus");
      return {
        confidence: 0.3,
        hazards: [],
        tags: [],
        short: "Scene analyzed.",
        cloud_handoff: true,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function runFunctionGemmaLocal(params: {
  imageDataUrl: string;
  mode: string;
  testHazard: boolean;
}): Promise<LocalInferenceResult> {
  const startMs = Date.now();
  const result = await runCactusRemote(params.imageDataUrl, params.mode, params.testHazard);
  const elapsed = Date.now() - startMs;
  log(`Cactus inference: ${elapsed}ms, confidence=${result.confidence}, hazards=${result.hazards.length}`, "cactus");
  return result;
}

export async function transcribeCactus(audioBase64: string, contentType = "audio/wav"): Promise<string> {
  if (!CACTUS_ENDPOINT) {
    throw new Error("CACTUS_ENDPOINT_URL is not set. Run the Cactus Python service for voice.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${CACTUS_ENDPOINT}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_base64: audioBase64, content_type: contentType }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.error && !data.transcript) {
      throw new Error(data.error || "Transcribe failed");
    }
    const transcript = (data.transcript ?? "").trim();
    log(`Cactus transcribe: ${transcript.slice(0, 60)}...`, "cactus");
    return transcript;
  } finally {
    clearTimeout(timeout);
  }
}
