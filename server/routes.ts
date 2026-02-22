import type { Express } from "express";
import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { runFunctionGemmaLocal, transcribeCactus } from "./cactus-adapter";
import { callGeminiCloud, transcribeGemini } from "./gemini-cloud";
import { routeDecision, shouldSpeak, isLocalResultValid } from "./router";
import { log } from "./index";
import type { UpdateMessage, SessionState } from "@shared/schema";

async function processFrame(params: {
  userId: string;
  imageDataUrl: string;
  mode: string;
  ts: number;
}): Promise<UpdateMessage> {
  const startMs = Date.now();
  const session = storage.getSession(params.userId);

  let localResult: Awaited<ReturnType<typeof runFunctionGemmaLocal>>;
  try {
    localResult = await runFunctionGemmaLocal({
      imageDataUrl: params.imageDataUrl,
      mode: params.mode,
      testHazard: session.testHazard,
    });
  } catch (err: any) {
    log(`Local inference failed: ${err.message}, escalating to cloud`, "cactus");
    localResult = {
      confidence: 0,
      hazards: [],
      tags: [],
      short: "Local analysis unavailable.",
      cloud_handoff: true,
    };
  }

  session.lastSceneSummary = `Tags: ${localResult.tags.join(", ")}. ${localResult.short}`;

  const resultValid = isLocalResultValid(localResult);

  const decision = routeDecision({
    session,
    mode: params.mode,
    localConfidence: localResult.confidence,
    isQuestion: false,
    localResultValid: resultValid,
  });

  let finalSay = localResult.short;

  const useCloud = decision.routed === "cloud" || localResult.cloud_handoff;
  if (useCloud) {
    try {
      const cloudResponse = await callGeminiCloud({
        lastSceneSummary: session.lastSceneSummary,
        imageDataUrl: params.imageDataUrl,
      });
      finalSay = cloudResponse;
      session.lastCloudCallTs = Date.now();
      session.stats.cloudCount++;
      if (localResult.cloud_handoff) {
        decision.routed = "cloud";
        decision.reason = "local_handoff_to_cloud";
      }
    } catch {
      finalSay = localResult.short;
      decision.routed = "local";
      decision.reason = "cloud_fallback_error";
      session.stats.localCount++;
    }
  } else {
    session.stats.localCount++;
  }

  const speak = shouldSpeak({
    session,
    hazards: localResult.hazards,
    say: finalSay,
    isQuestion: false,
    routed: decision.routed,
  });

  if (speak) {
    session.lastSpokenTs = Date.now();
    session.lastSpokenHash = simpleHash(finalSay);
  }

  if (localResult.hazards.length > 0) {
    session.lastHazardLabels = localResult.hazards.map(h => h.label);
    session.lastHazardTs = Date.now();
  }

  session.stats.frameCount++;
  const latencyMs = Date.now() - startMs;
  session.stats.totalLatencyMs += latencyMs;

  storage.updateSession(params.userId, session);

  return {
    type: "update",
    ts: Date.now(),
    routed: decision.routed,
    reason: decision.reason,
    confidence: localResult.confidence,
    hazards: localResult.hazards,
    say: finalSay,
    speak,
    latencyMs,
    debug: `edge=${session.stats.localCount} cloud=${session.stats.cloudCount} frames=${session.stats.frameCount}`,
  };
}

async function processQuestion(params: {
  userId: string;
  text: string;
  ts: number;
}): Promise<UpdateMessage> {
  const startMs = Date.now();
  const session = storage.getSession(params.userId);

  const decision = routeDecision({
    session,
    mode: "qa",
    localConfidence: 0.3,
    isQuestion: true,
  });

  let finalSay: string;

  if (decision.routed === "cloud") {
    try {
      finalSay = await callGeminiCloud({
        question: params.text,
        lastSceneSummary: session.lastSceneSummary,
      });
      session.lastCloudCallTs = Date.now();
      session.stats.cloudCount++;
    } catch {
      finalSay = "I couldn't reach cloud analysis. Based on what I can see locally, please proceed carefully.";
      decision.routed = "local";
      decision.reason = "cloud_fallback_error";
      session.stats.localCount++;
    }
  } else {
    finalSay = `Based on local analysis: ${session.lastSceneSummary || "No recent scene data. Please enable camera first."}`;
    session.stats.localCount++;
  }

  session.lastSpokenTs = Date.now();
  session.lastSpokenHash = simpleHash(finalSay);

  const latencyMs = Date.now() - startMs;
  session.stats.totalLatencyMs += latencyMs;

  storage.updateSession(params.userId, session);

  return {
    type: "update",
    ts: Date.now(),
    routed: decision.routed,
    reason: decision.reason,
    confidence: 0,
    hazards: [],
    say: finalSay,
    speak: true,
    latencyMs,
    debug: `edge=${session.stats.localCount} cloud=${session.stats.cloudCount}`,
  };
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", cactusEndpoint: !!process.env.CACTUS_ENDPOINT_URL });
  });

  app.post("/api/frame", async (req, res) => {
    try {
      const { userId, ts, imageDataUrl, mode, cloudEnabled, offlineSimulated, testHazard } = req.body;
      if (!userId || !imageDataUrl) {
        return res.status(400).json({ error: "userId and imageDataUrl required" });
      }

      const session = storage.getSession(userId);
      if (cloudEnabled !== undefined) session.cloudEnabled = cloudEnabled;
      if (offlineSimulated !== undefined) session.offlineSimulated = offlineSimulated;
      if (testHazard !== undefined) session.testHazard = testHazard;
      storage.updateSession(userId, session);

      const result = await processFrame({
        userId,
        imageDataUrl,
        mode: mode || "hazard",
        ts: ts || Date.now(),
      });

      res.json(result);
    } catch (err: any) {
      log(`POST /api/frame error: ${err.message}`, "error");
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ask", async (req, res) => {
    try {
      const { userId, ts, text, cloudEnabled, offlineSimulated } = req.body;
      if (!userId || !text) {
        return res.status(400).json({ error: "userId and text required" });
      }

      const session = storage.getSession(userId);
      if (cloudEnabled !== undefined) session.cloudEnabled = cloudEnabled;
      if (offlineSimulated !== undefined) session.offlineSimulated = offlineSimulated;
      storage.updateSession(userId, session);

      const result = await processQuestion({
        userId,
        text,
        ts: ts || Date.now(),
      });

      res.json(result);
    } catch (err: any) {
      log(`POST /api/ask error: ${err.message}`, "error");
      res.status(500).json({ error: err.message });
    }
  });

  /** Voice-to-action (Rubric 3): audio → Cactus transcribe → Q&A pipeline → response + TTS */
  app.post("/api/voice", async (req, res) => {
    try {
      const { userId, audioBase64, contentType, cloudEnabled, offlineSimulated } = req.body;
      if (!userId || !audioBase64) {
        return res.status(400).json({ error: "userId and audioBase64 required" });
      }

      const session = storage.getSession(userId);
      if (cloudEnabled !== undefined) session.cloudEnabled = cloudEnabled;
      if (offlineSimulated !== undefined) session.offlineSimulated = offlineSimulated;
      storage.updateSession(userId, session);

      let transcript: string;
      let transcribeSource = "cactus";
      try {
        transcript = await transcribeCactus(audioBase64, contentType || "audio/wav");
      } catch (cactusErr: any) {
        log(`Cactus transcribe failed: ${cactusErr.message}, falling back to Gemini`, "cactus");
        if (!session.cloudEnabled || session.offlineSimulated) {
          log("Cloud disabled or offline — cannot use Gemini transcription fallback", "cactus");
          return res.status(502).json({
            error: "Transcription unavailable",
            transcript: "",
            transcribeSource: "none",
            say: "Voice is unavailable in offline mode. Please type your question instead.",
          });
        }
        try {
          transcript = await transcribeGemini(audioBase64, contentType || "audio/webm");
          transcribeSource = "gemini";
        } catch (geminiErr: any) {
          log(`Gemini transcribe also failed: ${geminiErr.message}`, "gemini");
          return res.status(502).json({
            error: "Transcription unavailable",
            transcript: "",
            transcribeSource: "none",
            say: "I couldn't process your voice. Please try again.",
          });
        }
      }

      if (!transcript.trim()) {
        return res.json({
          type: "update",
          ts: Date.now(),
          routed: "local" as const,
          reason: "voice_no_speech",
          confidence: 0,
          hazards: [],
          say: "I didn't catch that. Try speaking again.",
          speak: true,
          transcript: "",
          transcribeSource,
          debug: `edge=${session.stats.localCount} cloud=${session.stats.cloudCount}`,
        });
      }

      const result = await processQuestion({
        userId,
        text: transcript,
        ts: Date.now(),
      });

      res.json({ ...result, transcript, transcribeSource });
    } catch (err: any) {
      log(`POST /api/voice error: ${err.message}`, "error");
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tts", async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: "text required" });

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
      if (!GEMINI_API_KEY) {
        return res.status(503).json({ error: "No API key for TTS" });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const apiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `Say in a calm, clear voice: ${text}` }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Kore" },
                },
              },
            },
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        log(`TTS API error: ${apiRes.status} - ${errText.slice(0, 200)}`, "gemini");
        return res.status(apiRes.status).json({ error: "TTS generation failed" });
      }

      const data = await apiRes.json();
      const audioBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      const mimeType = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || "audio/L16;rate=24000";

      if (!audioBase64) {
        log("TTS: no audio in response", "gemini");
        return res.status(500).json({ error: "No audio generated" });
      }

      const audioBuffer = Buffer.from(audioBase64, "base64");

      if (mimeType.includes("L16") || mimeType.includes("pcm")) {
        const sampleRate = 24000;
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const wavHeader = Buffer.alloc(44);
        wavHeader.write("RIFF", 0);
        wavHeader.writeUInt32LE(36 + audioBuffer.length, 4);
        wavHeader.write("WAVE", 8);
        wavHeader.write("fmt ", 12);
        wavHeader.writeUInt32LE(16, 16);
        wavHeader.writeUInt16LE(1, 20);
        wavHeader.writeUInt16LE(numChannels, 22);
        wavHeader.writeUInt32LE(sampleRate, 24);
        wavHeader.writeUInt32LE(byteRate, 28);
        wavHeader.writeUInt16LE(blockAlign, 32);
        wavHeader.writeUInt16LE(bitsPerSample, 34);
        wavHeader.write("data", 36);
        wavHeader.writeUInt32LE(audioBuffer.length, 40);
        const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Length", wavBuffer.length);
        return res.send(wavBuffer);
      }

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", audioBuffer.length);
      res.send(audioBuffer);
    } catch (err: any) {
      if (err.name === "AbortError") {
        log("TTS timed out", "gemini");
        return res.status(504).json({ error: "TTS timed out" });
      }
      log(`TTS error: ${err.message}`, "error");
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/stats/:userId", (req, res) => {
    const session = storage.getSession(req.params.userId);
    const total = session.stats.localCount + session.stats.cloudCount;
    res.json({
      localCount: session.stats.localCount,
      cloudCount: session.stats.cloudCount,
      totalFrames: session.stats.frameCount,
      edgeRatio: total > 0 ? Math.round((session.stats.localCount / total) * 100) : 100,
      avgLatencyMs: session.stats.frameCount > 0
        ? Math.round(session.stats.totalLatencyMs / session.stats.frameCount)
        : 0,
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    let userId = "";
    log("WebSocket client connected", "ws");

    ws.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case "hello": {
            userId = msg.userId;
            log(`User ${userId} connected via WS`, "ws");
            ws.send(JSON.stringify({ type: "welcome", ts: Date.now() }));
            break;
          }

          case "set": {
            const session = storage.getSession(msg.userId || userId);
            if (msg.cloudEnabled !== undefined) session.cloudEnabled = msg.cloudEnabled;
            if (msg.offlineSimulated !== undefined) session.offlineSimulated = msg.offlineSimulated;
            if (msg.testHazard !== undefined) session.testHazard = msg.testHazard;
            storage.updateSession(msg.userId || userId, session);
            log(`Settings updated for ${msg.userId || userId}: cloud=${session.cloudEnabled} offline=${session.offlineSimulated} testHazard=${session.testHazard}`, "ws");
            break;
          }

          case "frame": {
            const result = await processFrame({
              userId: msg.userId || userId,
              imageDataUrl: msg.imageDataUrl,
              mode: msg.mode || "hazard",
              ts: msg.ts || Date.now(),
            });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(result));
            }
            break;
          }

          case "question": {
            const result = await processQuestion({
              userId: msg.userId || userId,
              text: msg.text,
              ts: msg.ts || Date.now(),
            });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(result));
            }
            break;
          }
        }
      } catch (err: any) {
        log(`WS message error: ${err.message}`, "ws-error");
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
      }
    });

    ws.on("close", () => {
      log(`User ${userId} disconnected`, "ws");
    });

    ws.on("error", (err) => {
      log(`WS error: ${err.message}`, "ws-error");
    });
  });

  log(`WebSocket server attached at /ws`, "ws");

  return httpServer;
}
