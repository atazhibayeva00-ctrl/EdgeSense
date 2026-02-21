# EchoPath - Local-First Agentic Mobility Assistant

## Overview
EchoPath is a hackathon MVP for the Cactus x DeepMind hackathon. It demonstrates a local-first agentic mobility assistant with hybrid AI routing: Cactus FunctionGemma for edge inference (targeting 80%+ local processing) and Google Gemini API for cloud fallback (<20%).

## Architecture
Three-part system:
1. **Cactus Python Service** (`cactus_service.py`) - Flask microservice wrapping Cactus SDK, runs on user's Apple Silicon Mac
2. **Node.js Express Backend** (Replit) - WebSocket server, routing engine, Gemini cloud integration
3. **React Frontend** - Camera streaming, TTS, routing dashboard, demo controls

## Key Files
- `shared/schema.ts` - All shared types, Zod schemas
- `server/routes.ts` - WebSocket server + HTTP fallback endpoints + frame/question processing pipeline
- `server/cactus-adapter.ts` - Cactus edge inference adapter with smart mock fallback
- `server/gemini-cloud.ts` - Gemini 2.0 Flash cloud API integration
- `server/router.ts` - 5-rule smart routing engine (hazard→local, offline→local, cloud-disabled→local, high-confidence→local, else→cloud)
- `server/storage.ts` - In-memory session state management
- `client/src/pages/echopath.tsx` - Main UI page with camera, controls, dashboard
- `cactus_service.py` - Python Flask service for running Cactus SDK on Mac

## Environment Variables
- `GEMINI_API_KEY` - Google AI Studio API key for Gemini cloud fallback
- `CACTUS_ENDPOINT_URL` - URL pointing to the Cactus Python service on Mac (e.g., ngrok tunnel)
- `SESSION_SECRET` - Express session secret

## Running
- `npm run dev` starts Express + Vite on port 5000
- Cactus service: `python cactus_service.py` on Mac (port 8090), expose via ngrok

## Routing Strategy
1. Hazard mode → always LOCAL (safety-critical, no latency)
2. Offline simulated → LOCAL only
3. Cloud disabled → LOCAL only
4. Local confidence ≥ 0.75 → LOCAL (good enough)
5. Rate limited (< 5s since last cloud call) → LOCAL
6. Otherwise → CLOUD (Gemini escalation)
