import type { Express } from "express";
import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { runFunctionGemmaLocal } from "./cactus-adapter";
import { callGeminiCloud } from "./gemini-cloud";
import { routeDecision, shouldSpeak } from "./router";
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

  const localResult = await runFunctionGemmaLocal({
    imageDataUrl: params.imageDataUrl,
    mode: params.mode,
    testHazard: session.testHazard,
  });

  session.lastSceneSummary = `Tags: ${localResult.tags.join(", ")}. ${localResult.short}`;

  const decision = routeDecision({
    session,
    mode: params.mode,
    localConfidence: localResult.confidence,
    isQuestion: false,
  });

  let finalSay = localResult.short;

  if (decision.routed === "cloud") {
    try {
      const cloudResponse = await callGeminiCloud({
        lastSceneSummary: session.lastSceneSummary,
      });
      finalSay = cloudResponse;
      session.lastCloudCallTs = Date.now();
      session.stats.cloudCount++;
    } catch {
      finalSay = localResult.short;
      decision.routed = "local";
      decision.reason = "cloud_fallback_error";
    }
  } else {
    session.stats.localCount++;
  }

  const speak = shouldSpeak({
    session,
    hazards: localResult.hazards,
    say: finalSay,
    isQuestion: false,
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

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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
