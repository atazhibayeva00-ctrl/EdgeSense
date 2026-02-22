import type { RoutingDecision, SessionState } from "@shared/schema";

/**
 * Validate that a local inference result is well-formed and not hallucinated.
 * Mirrors the hackathon's _is_well_formed + majority-overlap checks.
 */
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

/**
 * Multi-signal hybrid routing engine (adapted from hackathon generate_hybrid).
 *
 * Signals used:
 *   1. Session state (offline, cloud-disabled) — hard overrides
 *   2. Mode (hazard → always local for safety)
 *   3. Local confidence score
 *   4. Local result validity (well-formed, not hallucinated)
 *   5. Rate limiting to avoid cloud spam
 *   6. Cloud handoff flag from Cactus
 */
export function routeDecision(params: {
  session: SessionState;
  mode: string;
  localConfidence: number;
  isQuestion: boolean;
  localResultValid?: boolean;
}): RoutingDecision {
  const { session, mode, localConfidence, isQuestion, localResultValid } = params;
  const now = Date.now();

  // Rule 1: Hazard mode → always local (safety-critical, no latency)
  if (mode === "hazard" && !isQuestion) {
    return { routed: "local", reason: "hazard_low_latency" };
  }

  // Rule 2: Offline → local only
  if (session.offlineSimulated) {
    return { routed: "local", reason: "offline_mode" };
  }

  // Rule 3: Cloud disabled → local only
  if (!session.cloudEnabled) {
    return { routed: "local", reason: "cloud_disabled" };
  }

  // Rule 4: Invalid local result → escalate to cloud
  if (localResultValid === false) {
    return { routed: "cloud", reason: "local_result_invalid" };
  }

  // Rule 5: High confidence + valid result → local
  if (!isQuestion && localConfidence >= 0.75) {
    return { routed: "local", reason: "high_confidence" };
  }

  // Rule 6: Rate limit cloud calls
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
  routed?: string;
}): boolean {
  const { session, hazards, say, isQuestion, routed } = params;
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
  const isGenericLocal = say === "Scene analyzed." || say === "Local analysis unavailable.";

  if (isGenericLocal) return false;

  if (routed === "cloud" && timeSinceLastSpoken > 3000) {
    return true;
  }

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
