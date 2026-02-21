import { z } from "zod";

export const hazardSchema = z.object({
  label: z.string(),
  pos: z.string().optional(),
  severity: z.enum(["low", "medium", "high"]),
});

export const localInferenceResultSchema = z.object({
  confidence: z.number().min(0).max(1),
  hazards: z.array(hazardSchema),
  tags: z.array(z.string()),
  short: z.string(),
  cloud_handoff: z.boolean().optional(),
});

export const routingDecisionSchema = z.object({
  routed: z.enum(["local", "cloud"]),
  reason: z.string(),
});

export const frameMessageSchema = z.object({
  type: z.literal("frame"),
  userId: z.string(),
  ts: z.number(),
  imageDataUrl: z.string(),
  mode: z.enum(["hazard", "qa"]),
});

export const questionMessageSchema = z.object({
  type: z.literal("question"),
  userId: z.string(),
  ts: z.number(),
  text: z.string(),
});

export const settingsMessageSchema = z.object({
  type: z.literal("set"),
  userId: z.string(),
  cloudEnabled: z.boolean(),
  offlineSimulated: z.boolean(),
  testHazard: z.boolean().optional(),
});

export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  userId: z.string(),
});

export const wsMessageSchema = z.discriminatedUnion("type", [
  frameMessageSchema,
  questionMessageSchema,
  settingsMessageSchema,
  helloMessageSchema,
]);

export const updateMessageSchema = z.object({
  type: z.literal("update"),
  ts: z.number(),
  routed: z.enum(["local", "cloud"]),
  reason: z.string(),
  confidence: z.number(),
  hazards: z.array(hazardSchema),
  say: z.string(),
  speak: z.boolean(),
  debug: z.string().optional(),
  latencyMs: z.number().optional(),
});

export type Hazard = z.infer<typeof hazardSchema>;
export type LocalInferenceResult = z.infer<typeof localInferenceResultSchema>;
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;
export type FrameMessage = z.infer<typeof frameMessageSchema>;
export type QuestionMessage = z.infer<typeof questionMessageSchema>;
export type SettingsMessage = z.infer<typeof settingsMessageSchema>;
export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type WsMessage = z.infer<typeof wsMessageSchema>;
export type UpdateMessage = z.infer<typeof updateMessageSchema>;

export interface SessionState {
  userId: string;
  cloudEnabled: boolean;
  offlineSimulated: boolean;
  testHazard: boolean;
  lastCloudCallTs: number;
  lastSpokenTs: number;
  lastSpokenHash: string;
  lastHazardLabels: string[];
  lastHazardTs: number;
  lastSceneSummary: string;
  stats: {
    localCount: number;
    cloudCount: number;
    totalLatencyMs: number;
    frameCount: number;
  };
}
