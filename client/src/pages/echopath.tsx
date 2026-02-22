import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Camera,
  CameraOff,
  WifiOff,
  Cloud,
  CloudOff,
  Send,
  Volume2,
  VolumeX,
  AlertTriangle,
  Shield,
  ChevronDown,
  Cpu,
  Zap,
  Eye,
  MessageSquare,
  TriangleAlert,
  Activity,
  Mic,
  Square,
  Settings2,
  Waves,
  CircleAlert,
} from "lucide-react";
import type { UpdateMessage, Hazard } from "@shared/schema";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "fallback";

interface ConversationEntry {
  id: number;
  timestamp: number;
  type: "assistant" | "user" | "hazard";
  text: string;
  routed?: "local" | "cloud";
  hazards?: Hazard[];
  latencyMs?: number;
}

let entryIdCounter = 0;

export default function EchoPathPage() {
  const [cameraActive, setCameraActive] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [fps, setFps] = useState(0.5);
  const [cloudEnabled, setCloudEnabled] = useState(true);
  const [offlineSimulated, setOfflineSimulated] = useState(false);
  const [testHazard, setTestHazard] = useState(false);
  const [mode, setMode] = useState<"hazard" | "qa">("hazard");
  const [muted, setMuted] = useState(false);
  const [question, setQuestion] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [lastUpdate, setLastUpdate] = useState<UpdateMessage | null>(null);
  const [latencyMs, setLatencyMs] = useState(0);
  const [edgeRatio, setEdgeRatio] = useState(100);
  const [localCount, setLocalCount] = useState(0);
  const [cloudCount, setCloudCount] = useState(0);
  const [demoOpen, setDemoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [lastTranscript, setLastTranscript] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [micError, setMicError] = useState("");
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isAnalyzingRef = useRef(false);
  const lastSayRef = useRef("");
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const userIdRef = useRef(`user_${Math.random().toString(36).slice(2, 8)}`);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const conversationEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [conversation, scrollToBottom]);

  const addConversationEntry = useCallback((entry: Omit<ConversationEntry, "id" | "timestamp">) => {
    setConversation((prev) => {
      const updated = [
        ...prev,
        { ...entry, id: ++entryIdCounter, timestamp: Date.now() },
      ];
      return updated.length > 20 ? updated.slice(-20) : updated;
    });
  }, []);

  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsSpeakingRef = useRef(false);
  const ttsPendingRef = useRef<string | null>(null);

  const stopCurrentAudio = useCallback(() => {
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.currentTime = 0;
      ttsAudioRef.current = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    ttsSpeakingRef.current = false;
  }, []);

  const speak = useCallback((text: string) => {
    if (muted || !text) return;

    stopCurrentAudio();

    const abort = new AbortController();
    ttsAbortRef.current = abort;
    ttsSpeakingRef.current = true;

    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: abort.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error("TTS API failed");
        return res.blob();
      })
      .then((blob) => {
        if (abort.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = 1.0;
        ttsAudioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          ttsSpeakingRef.current = false;
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          ttsSpeakingRef.current = false;
        };
        audio.play().catch(() => {
          ttsPendingRef.current = text;
          ttsSpeakingRef.current = false;
        });
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        ttsSpeakingRef.current = false;
        if (!("speechSynthesis" in window)) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.volume = 1.0;
        utterance.onend = () => { ttsSpeakingRef.current = false; };
        window.speechSynthesis.speak(utterance);
        ttsSpeakingRef.current = true;
      });
  }, [muted, stopCurrentAudio]);

  useEffect(() => {
    const retryPending = () => {
      if (ttsPendingRef.current) {
        const text = ttsPendingRef.current;
        ttsPendingRef.current = null;
        speak(text);
      }
    };
    document.addEventListener("click", retryPending, { once: true });
    document.addEventListener("touchstart", retryPending, { once: true });
    return () => {
      document.removeEventListener("click", retryPending);
      document.removeEventListener("touchstart", retryPending);
    };
  }, [speak]);

  const handleUpdate = useCallback((update: UpdateMessage) => {
    setLastUpdate(update);
    setIsAnalyzing(false);
    isAnalyzingRef.current = false;
    if (update.latencyMs) setLatencyMs(update.latencyMs);

    const total = (update.debug?.match(/edge=(\d+)/)?.[1] || "0");
    const cloud = (update.debug?.match(/cloud=(\d+)/)?.[1] || "0");
    const l = parseInt(total);
    const c = parseInt(cloud);
    setLocalCount(l);
    setCloudCount(c);
    const t = l + c;
    setEdgeRatio(t > 0 ? Math.round((l / t) * 100) : 100);

    if (update.say && update.say !== lastSayRef.current) {
      lastSayRef.current = update.say;
      const hasHazards = update.hazards && update.hazards.length > 0;
      addConversationEntry({
        type: hasHazards ? "hazard" : "assistant",
        text: update.say,
        routed: update.routed as "local" | "cloud",
        hazards: update.hazards,
        latencyMs: update.latencyMs,
      });
    }

    if (update.speak) {
      speak(update.say);
    }
  }, [speak, addConversationEntry]);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setConnectionStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setConnectionStatus("connected");
      ws.send(JSON.stringify({ type: "hello", userId: userIdRef.current }));
      ws.send(JSON.stringify({
        type: "set",
        userId: userIdRef.current,
        cloudEnabled,
        offlineSimulated,
        testHazard,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "update") {
          handleUpdate(data);
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnectionStatus("disconnected");
      wsRef.current = null;
      setTimeout(() => {
        if (cameraActive) connectWebSocket();
      }, 2000);
    };

    ws.onerror = () => {
      setConnectionStatus("fallback");
      ws.close();
    };

    wsRef.current = ws;
  }, [cloudEnabled, offlineSimulated, testHazard, handleUpdate, cameraActive]);

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "set",
        userId: userIdRef.current,
        cloudEnabled,
        offlineSimulated,
        testHazard,
      }));
    }
  }, [cloudEnabled, offlineSimulated, testHazard]);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return null;

    const targetSize = 224;
    canvas.width = targetSize;
    canvas.height = targetSize;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.5);
  }, []);

  const sendFrame = useCallback(async (imageDataUrl: string) => {
    if (isAnalyzingRef.current) return;
    isAnalyzingRef.current = true;
    setIsAnalyzing(true);
    const msg = {
      type: "frame" as const,
      userId: userIdRef.current,
      ts: Date.now(),
      imageDataUrl,
      mode,
    };

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      setConnectionStatus("fallback");
      try {
        const res = await fetch("/api/frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...msg,
            cloudEnabled,
            offlineSimulated,
            testHazard,
          }),
        });
        const data = await res.json();
        if (data.type === "update") {
          handleUpdate(data);
        }
      } catch {
        setIsAnalyzing(false);
        isAnalyzingRef.current = false;
      }
    }
  }, [mode, cloudEnabled, offlineSimulated, testHazard, handleUpdate]);

  const startCamera = useCallback(async () => {
    setCameraError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      connectWebSocket();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Permission") || message.includes("NotAllowed")) {
        setCameraError("Camera permission denied. Please allow camera access in your browser settings.");
      } else if (message.includes("NotFound")) {
        setCameraError("No camera found. Please connect a camera and try again.");
      } else {
        setCameraError(`Could not access camera: ${message}`);
      }
    }
  }, [connectWebSocket]);

  const stopCamera = useCallback(() => {
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setStreaming(false);
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current);
      streamIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (streaming && cameraActive) {
      const intervalMs = 1000 / fps;
      streamIntervalRef.current = setInterval(() => {
        const frame = captureFrame();
        if (frame) sendFrame(frame);
      }, intervalMs);
    } else {
      if (streamIntervalRef.current) {
        clearInterval(streamIntervalRef.current);
        streamIntervalRef.current = null;
      }
    }

    return () => {
      if (streamIntervalRef.current) {
        clearInterval(streamIntervalRef.current);
        streamIntervalRef.current = null;
      }
    };
  }, [streaming, cameraActive, fps, captureFrame, sendFrame]);

  const sendQuestion = useCallback(async () => {
    if (!question.trim()) return;
    addConversationEntry({ type: "user", text: question.trim() });
    const msg = {
      type: "question" as const,
      userId: userIdRef.current,
      ts: Date.now(),
      text: question.trim(),
    };

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...msg, cloudEnabled, offlineSimulated }),
        });
        const data = await res.json();
        if (data.type === "update") handleUpdate(data);
      } catch {
        addConversationEntry({ type: "assistant", text: "Sorry, I couldn't process your question. Please try again." });
      }
    }
    setQuestion("");
  }, [question, cloudEnabled, offlineSimulated, handleUpdate, addConversationEntry]);

  const startVoiceRecording = useCallback(async () => {
    setMicError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mime });
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1] || "";
          if (!base64) { setVoiceLoading(false); return; }
          setVoiceLoading(true);
          fetch("/api/voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: userIdRef.current, audioBase64: base64, contentType: mime, cloudEnabled, offlineSimulated }),
          })
            .then((r) => r.json())
            .then((data) => {
              setVoiceLoading(false);
              if (data.transcript !== undefined) {
                setLastTranscript(data.transcript);
                addConversationEntry({ type: "user", text: data.transcript });
              }
              if (data.type === "update") handleUpdate(data);
              if (data.speak && data.say) speak(data.say);
            })
            .catch(() => {
              setVoiceLoading(false);
              addConversationEntry({ type: "assistant", text: "Voice processing failed. Please try again." });
            });
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(200);
      setVoiceRecording(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Permission") || message.includes("NotAllowed")) {
        setMicError("Microphone permission denied. Please allow microphone access.");
      } else {
        setMicError(`Could not access microphone: ${message}`);
      }
    }
  }, [cloudEnabled, offlineSimulated, handleUpdate, speak, addConversationEntry]);

  const stopVoiceRecording = useCallback(() => {
    if (mediaRecorderRef.current && voiceRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setVoiceRecording(false);
    }
  }, [voiceRecording]);

  const connectionColor = {
    connected: "bg-emerald-500",
    connecting: "bg-amber-500",
    fallback: "bg-orange-500",
    disconnected: "bg-zinc-400",
  }[connectionStatus];

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white dark:from-slate-950 dark:to-slate-900 flex flex-col">
      {/* Compact Header */}
      <header className="sticky top-0 z-50 border-b bg-white/80 dark:bg-slate-950/80 backdrop-blur-xl">
        <div className="px-4 py-2.5 max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
              <Shield className="w-3.5 h-3.5 text-white" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-none tracking-tight">EdgeSense</h1>
              <p className="text-[10px] text-muted-foreground leading-none mt-0.5">AI Mobility Assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${connectionColor} ${connectionStatus === "connecting" ? "animate-pulse" : ""}`} />
              <span className="text-[10px] font-medium text-muted-foreground capitalize">{connectionStatus}</span>
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setMuted(!muted)} aria-label={muted ? "Unmute" : "Mute"}>
              {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
        {(connectionStatus === "disconnected" && cameraActive) && (
          <div className="bg-red-50 dark:bg-red-950/30 border-t border-red-200/50 px-4 py-1.5">
            <div className="flex items-center gap-1.5 max-w-lg mx-auto">
              <WifiOff className="w-3 h-3 text-red-500" />
              <span className="text-[10px] text-red-600 dark:text-red-400 font-medium">Reconnecting...</span>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 flex flex-col max-w-lg mx-auto w-full">
        {/* Camera — compact */}
        <section className="px-4 pt-3">
          <div className="relative rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-800 aspect-[16/10] border border-slate-200 dark:border-slate-700 shadow-sm">
            <video ref={videoRef} className={`w-full h-full object-cover ${!cameraActive ? "hidden" : ""}`} playsInline muted />
            {!cameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/10 to-purple-500/10 flex items-center justify-center">
                  <Camera className="w-7 h-7 text-indigo-500" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold">Point your camera</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 max-w-[200px]">EdgeSense analyzes surroundings for hazards in real time</p>
                </div>
                <Button onClick={startCamera} className="gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white shadow-md">
                  <Camera className="w-4 h-4" /> Start Camera
                </Button>
                {cameraError && (
                  <div className="flex items-start gap-1.5 bg-red-50 dark:bg-red-950/30 text-red-600 text-[11px] rounded-lg px-2.5 py-1.5 max-w-[260px]" role="alert">
                    <CircleAlert className="w-3 h-3 mt-0.5 flex-shrink-0" /><span>{cameraError}</span>
                  </div>
                )}
              </div>
            )}
            <canvas ref={canvasRef} className="hidden" />
            {cameraActive && (
              <>
                {streaming && (
                  <div className="absolute top-2.5 left-2.5 flex items-center gap-1 bg-red-600 text-white px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider shadow-lg">
                    <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" /> LIVE
                  </div>
                )}
                {isAnalyzing && (
                  <div className="absolute top-2.5 right-2.5 flex items-center gap-1 bg-indigo-600/90 text-white px-2 py-0.5 rounded-full text-[10px] font-medium shadow-lg">
                    <Waves className="w-3 h-3 animate-pulse" /> Analyzing
                  </div>
                )}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-3 pt-6 pb-2.5">
                  <div className="flex items-center justify-between">
                    <Button onClick={stopCamera} variant="destructive" size="sm" className="rounded-full h-7 text-[11px] gap-1 px-3">
                      <CameraOff className="w-3 h-3" /> Stop
                    </Button>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 bg-white/15 backdrop-blur rounded-full px-2 py-0.5">
                        <span className="text-[10px] text-white/80 font-medium">Stream</span>
                        <Switch checked={streaming} onCheckedChange={setStreaming} className="scale-[0.6]" />
                      </div>
                      <div className="flex items-center gap-1 bg-white/15 backdrop-blur rounded-full px-2 py-0.5">
                        <span className="text-[10px] text-white/80 font-medium">{fps}fps</span>
                        <Slider className="w-10" min={0.2} max={1} step={0.2} value={[fps]} onValueChange={([v]) => setFps(v)} />
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Mode + Stats bar */}
        <div className="px-4 pt-3 flex items-center gap-2">
          <div className="flex gap-1 flex-1">
            <button
              onClick={() => setMode("hazard")}
              className={`flex-1 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-semibold transition-all ${mode === "hazard" ? "bg-indigo-500 text-white shadow-sm" : "bg-muted/60 text-muted-foreground hover:bg-muted"}`}
            >
              <TriangleAlert className="w-3 h-3" /> Hazard
            </button>
            <button
              onClick={() => setMode("qa")}
              className={`flex-1 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-semibold transition-all ${mode === "qa" ? "bg-indigo-500 text-white shadow-sm" : "bg-muted/60 text-muted-foreground hover:bg-muted"}`}
            >
              <MessageSquare className="w-3 h-3" /> Q&A
            </button>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground bg-muted/40 rounded-lg px-2.5 py-1.5">
            <span className="flex items-center gap-0.5"><Cpu className="w-3 h-3" />{edgeRatio}%</span>
            <span className="text-muted-foreground/30">|</span>
            <span className="flex items-center gap-0.5"><Zap className="w-3 h-3" />{latencyMs}ms</span>
          </div>
        </div>

        {/* Conversation — main scrollable area */}
        <section className="flex-1 px-4 pt-3 pb-2 min-h-0" aria-label="Conversation" aria-live="polite">
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-y-auto space-y-2.5 min-h-[200px] max-h-[40vh]">
              {conversation.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center opacity-50">
                  <Eye className="w-8 h-8 text-muted-foreground/40 mb-2" />
                  <p className="text-xs text-muted-foreground">
                    {cameraActive ? "Waiting for analysis..." : "Start the camera or ask a question"}
                  </p>
                </div>
              ) : (
                conversation.map((entry) => (
                  <div key={entry.id} className={`flex gap-2 animate-slide-in-up ${entry.type === "user" ? "flex-row-reverse" : ""}`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                      entry.type === "user" ? "bg-indigo-100 dark:bg-indigo-900/30"
                        : entry.type === "hazard" ? "bg-red-100 dark:bg-red-900/30"
                        : "bg-slate-100 dark:bg-slate-800"
                    }`}>
                      {entry.type === "user" ? <MessageSquare className="w-3 h-3 text-indigo-500" />
                        : entry.type === "hazard" ? <AlertTriangle className="w-3 h-3 text-red-500" />
                        : <Eye className="w-3 h-3 text-slate-400" />}
                    </div>
                    <div className={`flex-1 min-w-0 ${entry.type === "user" ? "text-right" : ""}`}>
                      <div className={`inline-block rounded-2xl px-3 py-2 text-[13px] leading-relaxed max-w-[85%] ${
                        entry.type === "user"
                          ? "bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-br-md"
                          : entry.type === "hazard"
                          ? "bg-red-50 dark:bg-red-950/20 text-foreground border border-red-200 dark:border-red-800/30 rounded-bl-md"
                          : "bg-white dark:bg-slate-800 text-foreground border border-slate-200 dark:border-slate-700 rounded-bl-md shadow-sm"
                      }`}>
                        <p className="break-words">{entry.text}</p>
                        {entry.hazards && entry.hazards.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap mt-1.5">
                            {entry.hazards.map((h: Hazard, i: number) => (
                              <Badge key={`${h.label}-${i}`} variant={h.severity === "high" ? "destructive" : "secondary"} className="text-[9px] h-4">
                                {h.label.toUpperCase()}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className={`flex items-center gap-1 mt-0.5 ${entry.type === "user" ? "justify-end" : ""}`}>
                        <span className="text-[9px] text-muted-foreground/60">{formatTime(entry.timestamp)}</span>
                        {entry.routed && (
                          <span className={`text-[9px] font-medium ${entry.routed === "local" ? "text-emerald-500" : "text-indigo-400"}`}>
                            {entry.routed === "local" ? "Edge" : "Cloud"}
                            {entry.latencyMs ? ` · ${entry.latencyMs}ms` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={conversationEndRef} />
            </div>
          </div>
        </section>

        {/* Input bar — voice + text */}
        <div className="sticky bottom-0 bg-white/90 dark:bg-slate-950/90 backdrop-blur-xl border-t px-4 py-3">
          <div className="max-w-lg mx-auto space-y-2">
            {micError && (
              <div className="flex items-center gap-1.5 text-red-500 text-[11px]"><CircleAlert className="w-3 h-3" />{micError}</div>
            )}
            {lastTranscript && (
              <div className="text-[11px] text-muted-foreground truncate"><span className="font-medium">You said:</span> {lastTranscript}</div>
            )}
            <div className="flex items-center gap-2">
              {/* Voice button */}
              {!voiceRecording ? (
                <button
                  onClick={voiceLoading ? undefined : startVoiceRecording}
                  disabled={voiceLoading}
                  className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                    voiceLoading ? "bg-muted text-muted-foreground" : "bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-md hover:shadow-lg hover:scale-105 active:scale-95"
                  }`}
                  aria-label="Tap to talk"
                >
                  {voiceLoading ? <Waves className="w-4 h-4 animate-pulse" /> : <Mic className="w-4 h-4" />}
                </button>
              ) : (
                <button
                  onClick={stopVoiceRecording}
                  className="w-10 h-10 rounded-full bg-red-500 text-white flex items-center justify-center flex-shrink-0 shadow-md animate-pulse hover:scale-105 active:scale-95"
                  aria-label="Stop recording"
                >
                  <Square className="w-4 h-4" />
                </button>
              )}
              {/* Text input */}
              <div className="flex-1 flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 rounded-full pl-4 pr-1.5 py-1">
                <Input
                  placeholder={voiceRecording ? "Listening..." : "Ask about your surroundings..."}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendQuestion()}
                  className="border-0 bg-transparent h-8 text-sm focus-visible:ring-0 shadow-none px-0"
                  disabled={voiceRecording}
                />
                <Button
                  size="icon"
                  onClick={sendQuestion}
                  disabled={!question.trim()}
                  className="rounded-full h-7 w-7 flex-shrink-0 bg-indigo-500 hover:bg-indigo-600"
                >
                  <Send className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Collapsible Settings & Demo */}
        <div className="px-4 pb-4 space-y-2">
          <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between h-8 text-[11px] text-muted-foreground hover:text-foreground" size="sm">
                <span className="flex items-center gap-1.5"><Settings2 className="w-3.5 h-3.5" />Settings</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1">
              <Card className="border-dashed">
                <CardContent className="p-3 space-y-2.5">
                  {[
                    { id: "cloud", label: "Cloud processing", icon: cloudEnabled ? Cloud : CloudOff, checked: cloudEnabled, onChange: setCloudEnabled },
                    { id: "offline", label: "Simulate offline", icon: WifiOff, checked: offlineSimulated, onChange: setOfflineSimulated },
                    { id: "hazard", label: "Test hazard", icon: AlertTriangle, checked: testHazard, onChange: setTestHazard },
                  ].map(({ id, label, icon: Icon, checked, onChange }) => (
                    <div key={id} className="flex items-center justify-between">
                      <Label htmlFor={`${id}-toggle`} className="text-xs flex items-center gap-1.5 cursor-pointer">
                        <Icon className="w-3.5 h-3.5 text-muted-foreground" />{label}
                      </Label>
                      <Switch id={`${id}-toggle`} checked={checked} onCheckedChange={onChange} className="scale-90" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={demoOpen} onOpenChange={setDemoOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between h-8 text-[11px] text-muted-foreground hover:text-foreground" size="sm">
                <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" />Demo Script</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${demoOpen ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1">
              <Card className="border-dashed">
                <CardContent className="p-3 space-y-2">
                  {[
                    { n: 1, t: "Local-Only Mode", d: "Cloud OFF + Offline ON. Stream camera. All local, no cloud calls." },
                    { n: 2, t: "Cloud Escalation", d: "Cloud ON. Ask \"Is there a crosswalk ahead?\" See cloud routing." },
                    { n: 3, t: "Hazard Alert", d: "Toggle Test Hazard. Instant local alert with TTS." },
                  ].map(({ n, t, d }) => (
                    <div key={n} className="flex gap-2">
                      <div className="w-5 h-5 rounded-full bg-indigo-50 dark:bg-indigo-950/30 text-indigo-500 text-[10px] font-bold flex items-center justify-center flex-shrink-0">{n}</div>
                      <div><p className="text-xs font-medium">{t}</p><p className="text-[10px] text-muted-foreground">{d}</p></div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>

          {/* Routing detail footer */}
          {lastUpdate && (
            <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground pt-1">
              <Badge variant={lastUpdate.routed === "local" ? "default" : "secondary"} className="text-[9px] h-4 px-1.5">
                {lastUpdate.routed === "local" ? <><Cpu className="w-2.5 h-2.5 mr-0.5" />Edge</> : <><Cloud className="w-2.5 h-2.5 mr-0.5" />Cloud</>}
              </Badge>
              <span className="font-mono">{lastUpdate.reason}</span>
              <span className="font-mono">E:{localCount} C:{cloudCount}</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
