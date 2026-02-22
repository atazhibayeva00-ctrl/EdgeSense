import type { SessionState } from "@shared/schema";

export interface IStorage {
  getSession(userId: string): SessionState;
  updateSession(userId: string, updates: Partial<SessionState>): SessionState;
}

export class MemStorage implements IStorage {
  private sessions: Map<string, SessionState>;

  constructor() {
    this.sessions = new Map();
  }

  getSession(userId: string): SessionState {
    let session = this.sessions.get(userId);
    if (!session) {
      session = {
        userId,
        cloudEnabled: true,
        offlineSimulated: false,
        testHazard: false,
        lastCloudCallTs: 0,
        lastSpokenTs: 0,
        lastSpokenHash: "",
        lastHazardLabels: [],
        lastHazardTs: 0,
        lastSceneSummary: "",
        lastSceneHash: "",
        consecutiveLocalSuccess: 0,
        recentCloudCalls: [],
        stats: { localCount: 0, cloudCount: 0, totalLatencyMs: 0, frameCount: 0 },
      };
      this.sessions.set(userId, session);
    }
    return session;
  }

  updateSession(userId: string, updates: Partial<SessionState>): SessionState {
    const session = this.getSession(userId);
    Object.assign(session, updates);
    return session;
  }
}

export const storage = new MemStorage();
