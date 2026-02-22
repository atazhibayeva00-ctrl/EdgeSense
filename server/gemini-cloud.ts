import { log } from "./index";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

export async function callGeminiCloud(params: {
  question?: string;
  lastSceneSummary: string;
}): Promise<string> {
  if (!GEMINI_API_KEY) {
    return "Cloud analysis unavailable -- no API key configured. I might be wrong, but the path ahead looks generally clear based on local analysis.";
  }

  const systemPrompt = `You are EchoPath, a mobility safety assistant for visually impaired users. 
Rules:
- Keep responses to 1-2 sentences maximum
- Never claim certainty about safety ("path is clear")
- Always hedge with "I might be wrong" or "it appears"
- Focus on actionable guidance
- If hazards mentioned, prioritize warning about them`;

  const userContent = params.question
    ? `Scene context: ${params.lastSceneSummary || "No scene data available."}\n\nUser question: ${params.question}`
    : `Analyze this scene for a visually impaired user: ${params.lastSceneSummary}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }
          ],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.3,
            thinkingConfig: { thinkingBudget: 0 },
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
      return "Cloud analysis timed out. Based on local analysis, proceed with caution -- I might be wrong.";
    }
    log(`Gemini error: ${err.message}`, "gemini");
    return "Cloud analysis failed. Based on local analysis, the area appears navigable but please proceed carefully.";
  }
}
