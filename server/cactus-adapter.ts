import { log } from "./index";
import type { LocalInferenceResult, Hazard } from "@shared/schema";
import crypto from "crypto";

const CACTUS_ENDPOINT = process.env.CACTUS_ENDPOINT_URL || "";

function hashImage(imageDataUrl: string): number {
  const hash = crypto.createHash("md5").update(imageDataUrl.slice(0, 500)).digest();
  return (hash[0] + hash[1] * 256) / 65535;
}

async function runCactusRemote(imageDataUrl: string, mode: string, testHazard: boolean): Promise<LocalInferenceResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await fetch(`${CACTUS_ENDPOINT}/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "You are a mobility safety assistant analyzing camera frames. Return JSON with: tags (string array of objects seen), hazards (array of {label, pos, severity}), confidence (0-1), short (one sentence description)."
          },
          {
            role: "user",
            content: mode === "hazard"
              ? "Analyze this image for mobility hazards like stairs, obstacles, drop-offs, curbs. Report any dangers."
              : "Describe what you see in this scene briefly.",
            images: [imageDataUrl]
          }
        ],
        tools: mode === "hazard" ? [{
          function: {
            name: "report_hazards",
            description: "Report detected hazards in the scene",
            parameters: {
              properties: {
                hazards: { type: "array", description: "List of hazards with label, position, severity" },
                confidence: { type: "number", description: "Confidence 0-1" },
                tags: { type: "array", description: "Objects detected" },
                short: { type: "string", description: "One sentence summary" }
              },
              required: ["hazards", "confidence", "tags", "short"]
            }
          }
        }] : undefined
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Cactus returned ${res.status}`);
    }

    const data = await res.json();
    const responseText = data.response || "";

    try {
      const parsed = JSON.parse(responseText);
      return {
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        hazards: (parsed.hazards || []).map((h: any) => ({
          label: h.label || "unknown",
          pos: h.pos || "ahead",
          severity: h.severity || "medium",
        })),
        tags: parsed.tags || [],
        short: parsed.short || "Scene analyzed.",
        cloud_handoff: data.cloud_handoff || false,
      };
    } catch {
      return {
        confidence: 0.6,
        hazards: [],
        tags: [],
        short: responseText.slice(0, 100) || "Scene analyzed.",
        cloud_handoff: data.cloud_handoff || false,
      };
    }
  } catch (err: any) {
    clearTimeout(timeout);
    throw err;
  }
}

function runMockLocal(imageDataUrl: string, mode: string, testHazard: boolean): LocalInferenceResult {
  const h = hashImage(imageDataUrl);
  const confidence = 0.55 + h * 0.4;

  const baseTags = ["floor", "wall", "lighting"];
  if (h > 0.6) baseTags.push("doorway");
  if (h > 0.8) baseTags.push("furniture");

  const hazards: Hazard[] = [];

  if (testHazard) {
    hazards.push({ label: "stairs", pos: "ahead 2m", severity: "high" });
    return {
      confidence: 0.92,
      hazards,
      tags: [...baseTags, "stairs"],
      short: "Stop -- stairs detected directly ahead.",
      cloud_handoff: false,
    };
  }

  if (mode === "hazard") {
    if (h < 0.15) {
      hazards.push({ label: "obstacle", pos: "left", severity: "medium" });
    }
    if (h > 0.9) {
      hazards.push({ label: "curb", pos: "ahead", severity: "medium" });
    }
  }

  const short = hazards.length > 0
    ? `Caution: ${hazards.map(h => h.label).join(", ")} detected nearby.`
    : "Path appears clear. Proceed with caution.";

  return {
    confidence: Math.round(confidence * 100) / 100,
    hazards,
    tags: baseTags,
    short,
    cloud_handoff: false,
  };
}

export async function runFunctionGemmaLocal(params: {
  imageDataUrl: string;
  mode: string;
  testHazard: boolean;
}): Promise<LocalInferenceResult> {
  const startMs = Date.now();

  if (CACTUS_ENDPOINT) {
    try {
      const result = await runCactusRemote(params.imageDataUrl, params.mode, params.testHazard);
      const elapsed = Date.now() - startMs;
      log(`Cactus inference: ${elapsed}ms, confidence=${result.confidence}, hazards=${result.hazards.length}`, "cactus");
      return result;
    } catch (err: any) {
      log(`Cactus endpoint error: ${err.message}, falling back to mock`, "cactus");
    }
  }

  await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
  const result = runMockLocal(params.imageDataUrl, params.mode, params.testHazard);
  const elapsed = Date.now() - startMs;
  log(`Mock local inference: ${elapsed}ms, confidence=${result.confidence}, hazards=${result.hazards.length}`, "cactus-mock");
  return result;
}
