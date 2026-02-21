import type { RoutingDecision, SessionState } from "@shared/schema";

export function routeDecision(params: {
  session: SessionState;
  mode: string;
  localConfidence: number;
  isQuestion: boolean;
}): RoutingDecision {
  const { session, mode, localConfidence, isQuestion } = params;
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

  if (!isQuestion && localConfidence >= 0.75) {
    return { routed: "local", reason: "high_confidence" };
  }

  const timeSinceLastCloud = now - session.lastCloudCallTs;
  if (timeSinceLastCloud < 5000) {
    return { routed: "local", reason: "rate_limited" };
  }

  return { routed: "cloud", reason: isQuestion ? "user_question" : "low_confidence_escalate" };
}

export function shouldSpeak(params: {
  session: SessionState;
  hazards: Array<{ label: string; severity: string }>;
  say: string;
  isQuestion: boolean;
}): boolean {
  const { session, hazards, say, isQuestion } = params;
  const now = Date.now();

  if (isQuestion) return true;

  const highSeverityHazards = hazards.filter(h => h.severity === "high");
  if (highSeverityHazards.length > 0) {
    const newHazardLabels = highSeverityHazards.map(h => h.label);
    const isNewHazard = newHazardLabels.some(l => !session.lastHazardLabels.includes(l));
    const hazardCooldownOk = now - session.lastHazardTs > 3000;

    if (isNewHazard || hazardCooldownOk) {
      return true;
    }
  }

  const hash = simpleHash(say);
  const timeSinceLastSpoken = now - session.lastSpokenTs;

  if (timeSinceLastSpoken > 4000 && hash !== session.lastSpokenHash) {
    return true;
  }

  return false;
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
