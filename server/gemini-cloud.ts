import { log } from "./index";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

export async function transcribeGemini(audioBase64: string, contentType: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("No Gemini API key for transcription fallback");
  }

  let mimeType = contentType.split(";")[0].trim() || "audio/webm";
  if (mimeType === "audio/webm") {
    mimeType = "audio/webm";
  }

  log(`Gemini transcribe: mimeType=${mimeType}, audioSize=${audioBase64.length} chars`, "gemini");

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: "Transcribe the speech in this audio recording. Return ONLY the exact words spoken by the user, with no extra commentary, labels, or formatting. If you cannot detect any speech, return exactly: [NO_SPEECH]" },
    { inlineData: { mimeType, data: audioBase64 } },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { maxOutputTokens: 500, temperature: 0.0 },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      log(`Gemini transcribe error: ${res.status} - ${errText.slice(0, 300)}`, "gemini");
      throw new Error(`Gemini transcribe ${res.status}`);
    }

    const data = await res.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    log(`Gemini transcription raw: "${text.slice(0, 120)}"`, "gemini");

    text = text.trim();
    if (text === "[NO_SPEECH]" || text.toLowerCase().includes("no speech")) {
      return "";
    }
    text = text.replace(/^["']|["']$/g, "").trim();
    return text;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      log("Gemini transcribe timed out", "gemini");
      throw new Error("Transcription timed out");
    }
    throw err;
  }
}

export async function callGeminiCloud(params: {
  question?: string;
  lastSceneSummary: string;
  imageDataUrl?: string;
}): Promise<string> {
  if (!GEMINI_API_KEY) {
    return "Cloud analysis unavailable -- no API key configured. Please proceed with caution.";
  }

  const systemPrompt = `You are EchoPath, a mobility safety assistant for visually impaired users. 
Rules:
- Keep responses to 1-2 sentences maximum
- ONLY describe what you actually see in the image
- If no image is provided, say you cannot analyze the scene
- Never make up or hallucinate hazards that are not visible
- Focus on actionable guidance based on what is actually visible
- If you see hazards, warn about them specifically`;

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  parts.push({ text: systemPrompt });

  if (params.imageDataUrl && params.imageDataUrl.startsWith("data:image/")) {
    const commaIdx = params.imageDataUrl.indexOf(",");
    if (commaIdx > 0) {
      const mimeMatch = params.imageDataUrl.match(/^data:(image\/[^;]+);/);
      const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
      const base64Data = params.imageDataUrl.slice(commaIdx + 1);

      parts.push({
        inlineData: {
          mimeType,
          data: base64Data,
        },
      });
    }
  }

  if (params.question) {
    parts.push({
      text: `User question: ${params.question}\nScene context: ${params.lastSceneSummary || "No prior scene data."}`,
    });
  } else {
    parts.push({
      text: "Describe what you see in this image for a visually impaired user. Focus on obstacles, hazards, or navigation-relevant details. Only describe what is actually visible.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts }
          ],
          generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.3,
          },
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      log(`Gemini API error: ${res.status} - ${errText.slice(0, 200)}`, "gemini");
      throw new Error(`Gemini ${res.status}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    log(`Gemini response: ${text.slice(0, 100)}`, "gemini");
    return text.trim() || "I wasn't able to analyze the scene clearly. Please proceed with caution.";
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      log("Gemini call timed out (5s)", "gemini");
      return "Cloud analysis timed out. Please proceed with caution.";
    }
    log(`Gemini error: ${err.message}`, "gemini");
    return "Cloud analysis failed. Please proceed carefully.";
  }
}
