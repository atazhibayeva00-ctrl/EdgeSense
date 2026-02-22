import type { RoutingDecision, SessionState } from "@shared/schema";

export function isLocalResultValid(result: {
  confidence: number;
  hazards: Array<{ label: string; severity: string }>;
  tags: string[];
  short: string;
  cloud_handoff?: boolean;
}): boolean {
  if (result.cloud_handoff) return false;
  if (result.confidence <= 0) return false;
  if (!result.short || result.short.length < 3) return false;
  if (result.short.length > 500) return false;
  const hasContent = result.hazards.length > 0 || result.tags.length > 0;
  if (!hasContent && result.confidence < 0.5) return false;
  return true;
}

export function sceneHash(imageDataUrl: string): string {
  let hash = 0;
  const sample = imageDataUrl.slice(-2000);
  for (let i = 0; i < sample.length; i++) {
    hash = ((hash << 5) - hash) + sample.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

export function isSceneChanged(session: SessionState, currentHash: string): boolean {
  if (!session.lastSceneHash) return true;
  return session.lastSceneHash !== currentHash;
}

function getAdaptiveCloudCooldown(session: SessionState): number {
  const now = Date.now();
  const recentCalls = session.recentCloudCalls.filter(ts => now - ts < 60000);
  if (recentCalls.length >= 8) return 15000;
  if (recentCalls.length >= 5) return 10000;
  if (recentCalls.length >= 3) return 7000;
  return 5000;
}

export function routeDecision(params: {
  session: SessionState;
  mode: string;
  localConfidence: number;
  isQuestion: boolean;
  localResultValid?: boolean;
  sceneChanged?: boolean;
}): RoutingDecision {
  const { session, mode, localConfidence, isQuestion, localResultValid, sceneChanged } = params;
  const now = Date.now();

  if (mode === "hazard" && !isQuestion) {
    return { routed: "local", reason: "hazard_low_latency" };
  }

  if (session.offlineSimulated) {
    return { routed: "local", reason: "offline_mode" };
  }

  if (!session.cloudEnabled) {
    return { routed: "local", reason: "cloud_disabled" };
  }

  if (localResultValid === false) {
    return { routed: "cloud", reason: "local_result_invalid" };
  }

  if (!isQuestion && localConfidence >= 0.75) {
    return { routed: "local", reason: "high_confidence" };
  }

  if (!isQuestion && localConfidence >= 0.5 && sceneChanged === false) {
    return { routed: "local", reason: "medium_confidence_stable_scene" };
  }

  if (!isQuestion && localConfidence >= 0.5 && session.consecutiveLocalSuccess >= 3) {
    return { routed: "local", reason: "medium_confidence_local_streak" };
  }

  const cloudCooldown = getAdaptiveCloudCooldown(session);
  const timeSinceLastCloud = now - session.lastCloudCallTs;
  if (timeSinceLastCloud < cloudCooldown) {
    return { routed: "local", reason: `rate_limited_${Math.round(cloudCooldown / 1000)}s` };
  }

  return { routed: "cloud", reason: isQuestion ? "user_question" : "low_confidence_escalate" };
}

export function shouldSpeak(params: {
  session: SessionState;
  hazards: Array<{ label: string; severity: string }>;
  say: string;
  isQuestion: boolean;
  routed?: string;
}): boolean {
  const { session, hazards, say, isQuestion, routed } = params;
  const now = Date.now();

  if (isQuestion) return true;

  const hash = simpleHash(say);
  const timeSinceLastSpoken = now - session.lastSpokenTs;

  const isGenericLocal = say === "Scene analyzed." || say === "Local analysis unavailable.";
  if (isGenericLocal) return false;

  if (hash === session.lastSpokenHash) return false;

  const highSeverityHazards = hazards.filter(h => h.severity === "high");
  if (highSeverityHazards.length > 0) {
    const newHazardLabels = highSeverityHazards.map(h => h.label);
    const isNewHazard = newHazardLabels.some(l => !session.lastHazardLabels.includes(l));
    const hazardCooldownOk = now - session.lastHazardTs > 8000;

    if (isNewHazard && hazardCooldownOk) {
      return true;
    }
  }

  if (routed === "cloud" && timeSinceLastSpoken > 10000) {
    return true;
  }

  if (timeSinceLastSpoken > 15000) {
    return true;
  }

  return false;
}

export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}
