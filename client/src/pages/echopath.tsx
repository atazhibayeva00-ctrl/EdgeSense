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
  Wifi,
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
  Radio,
  Eye,
  MessageSquare,
  TriangleAlert,
  Activity,
  Mic,
  Square,
  Settings2,
  Waves,
  CircleAlert,
  History,
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
  const [fps, setFps] = useState(1);
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
    setConversation((prev) => [
      ...prev,
      { ...entry, id: ++entryIdCounter, timestamp: Date.now() },
    ]);
  }, []);

  const speak = useCallback((text: string) => {
    if (muted || !text) return;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1;
      utterance.volume = 0.8;
      window.speechSynthesis.speak(utterance);
    }
  }, [muted]);

  const handleUpdate = useCallback((update: UpdateMessage) => {
    setLastUpdate(update);
    setIsAnalyzing(false);
    if (update.latencyMs) setLatencyMs(update.latencyMs);

    const total = (update.debug?.match(/edge=(\d+)/)?.[1] || "0");
    const cloud = (update.debug?.match(/cloud=(\d+)/)?.[1] || "0");
    const l = parseInt(total);
    const c = parseInt(cloud);
    setLocalCount(l);
    setCloudCount(c);
    const t = l + c;
    setEdgeRatio(t > 0 ? Math.round((l / t) * 100) : 100);

    if (update.say) {
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

    const maxWidth = 512;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.5);
  }, []);

  const sendFrame = useCallback(async (imageDataUrl: string) => {
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
          body: JSON.stringify({
            ...msg,
            cloudEnabled,
            offlineSimulated,
          }),
        });
        const data = await res.json();
        if (data.type === "update") {
          handleUpdate(data);
        }
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
      recorder.ondataavailable = (e) => {
        if (e.data.size) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mime });
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1] || "";
          if (!base64) {
            setVoiceLoading(false);
            return;
          }
          setVoiceLoading(true);
          fetch("/api/voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: userIdRef.current,
              audioBase64: base64,
              contentType: mime,
              cloudEnabled,
              offlineSimulated,
            }),
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

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between max-w-lg mx-auto">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Shield className="w-4.5 h-4.5 text-primary" aria-hidden="true" />
              </div>
              <div>
                <h1 className="text-base font-semibold leading-tight">EchoPath</h1>
                <p className="text-[11px] text-muted-foreground leading-tight">Mobility Assistant</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1" role="status" aria-label={`Connection: ${connectionStatus}`}>
                <span className={`w-2 h-2 rounded-full ${connectionColor} ${connectionStatus === "connecting" ? "animate-pulse" : ""}`} />
                <span className="text-[11px] font-medium text-muted-foreground capitalize">{connectionStatus}</span>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => setMuted(!muted)}
                aria-label={muted ? "Unmute audio" : "Mute audio"}
              >
                {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Connection warning banner */}
        {(connectionStatus === "disconnected" && cameraActive) && (
          <div className="bg-destructive/10 border-t border-destructive/20 px-4 py-2" role="alert">
            <div className="flex items-center gap-2 max-w-lg mx-auto">
              <WifiOff className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
              <span className="text-xs text-destructive font-medium">Connection lost. Reconnecting...</span>
            </div>
          </div>
        )}
        {connectionStatus === "fallback" && (
          <div className="bg-orange-500/10 border-t border-orange-500/20 px-4 py-2" role="alert">
            <div className="flex items-center gap-2 max-w-lg mx-auto">
              <Activity className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400 flex-shrink-0" />
              <span className="text-xs text-orange-600 dark:text-orange-400 font-medium">WebSocket unavailable — using HTTP fallback</span>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 p-4 space-y-4 max-w-lg mx-auto w-full pb-8">
        {/* Camera Section */}
        <section aria-label="Camera preview">
          <div className="relative rounded-xl overflow-hidden bg-muted aspect-video border">
            <video
              ref={videoRef}
              className={`w-full h-full object-cover ${!cameraActive ? "hidden" : ""}`}
              playsInline
              muted
              aria-label="Live camera feed"
            />
            {!cameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                  <Camera className="w-8 h-8 text-primary" />
                </div>
                <div className="text-center space-y-1.5">
                  <p className="text-sm font-medium text-foreground">Start your camera to begin</p>
                  <p className="text-xs text-muted-foreground max-w-[240px]">
                    EchoPath will analyze your surroundings and alert you to hazards in real time.
                  </p>
                </div>
                <Button onClick={startCamera} size="lg" className="mt-1 gap-2 rounded-xl">
                  <Camera className="w-4 h-4" />
                  Enable Camera
                </Button>
                {cameraError && (
                  <div className="flex items-start gap-2 bg-destructive/10 text-destructive text-xs rounded-lg px-3 py-2 max-w-[300px]" role="alert">
                    <CircleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{cameraError}</span>
                  </div>
                )}
              </div>
            )}
            <canvas ref={canvasRef} className="hidden" />

            {/* Overlay controls when camera is active */}
            {cameraActive && (
              <>
                {/* Live indicator */}
                {streaming && (
                  <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-red-600/90 text-white px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide shadow-lg">
                    <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                    LIVE · {fps} FPS
                  </div>
                )}

                {/* Analyzing indicator */}
                {isAnalyzing && (
                  <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-primary/90 text-primary-foreground px-2.5 py-1 rounded-full text-[11px] font-medium shadow-lg">
                    <Waves className="w-3 h-3 animate-pulse" />
                    Analyzing...
                  </div>
                )}

                {/* Bottom overlay controls */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 via-black/30 to-transparent px-3 pt-8 pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      onClick={stopCamera}
                      variant="destructive"
                      size="sm"
                      className="rounded-full gap-1.5 shadow-lg h-8 text-xs"
                    >
                      <CameraOff className="w-3.5 h-3.5" />
                      Stop
                    </Button>

                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1.5 bg-black/40 backdrop-blur-sm rounded-full px-2.5 py-1">
                        <label htmlFor="stream-toggle" className="text-[11px] text-white/80 font-medium cursor-pointer">Stream</label>
                        <Switch
                          id="stream-toggle"
                          checked={streaming}
                          onCheckedChange={setStreaming}
                          className="scale-75"
                          aria-label="Toggle frame streaming"
                        />
                      </div>

                      <div className="flex items-center gap-1.5 bg-black/40 backdrop-blur-sm rounded-full px-2.5 py-1">
                        <span className="text-[11px] text-white/80 font-medium">{fps} FPS</span>
                        <Slider
                          className="w-14"
                          min={0.5}
                          max={2}
                          step={0.5}
                          value={[fps]}
                          onValueChange={([v]) => setFps(v)}
                          aria-label="Frames per second"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Mode Selector */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === "hazard" ? "default" : "secondary"}
            onClick={() => setMode("hazard")}
            className="flex-1 gap-1.5 rounded-lg h-9"
            aria-pressed={mode === "hazard"}
          >
            <TriangleAlert className="w-3.5 h-3.5" />
            Hazard Detection
          </Button>
          <Button
            size="sm"
            variant={mode === "qa" ? "default" : "secondary"}
            onClick={() => setMode("qa")}
            className="flex-1 gap-1.5 rounded-lg h-9"
            aria-pressed={mode === "qa"}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            Q&A Mode
          </Button>
        </div>

        {/* Voice Input — Large, Prominent */}
        <Card className="border-2 border-dashed border-primary/20 bg-primary/[0.02]">
          <CardContent className="p-5 flex flex-col items-center gap-3">
            {!voiceRecording ? (
              <button
                onClick={voiceLoading ? undefined : startVoiceRecording}
                disabled={voiceLoading}
                className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 shadow-lg ${
                  voiceLoading
                    ? "bg-muted text-muted-foreground cursor-wait"
                    : "bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105 active:scale-95 cursor-pointer"
                }`}
                aria-label={voiceLoading ? "Processing voice input" : "Tap to start voice recording"}
              >
                {voiceLoading ? (
                  <Waves className="w-8 h-8 animate-pulse" />
                ) : (
                  <Mic className="w-8 h-8" />
                )}
              </button>
            ) : (
              <button
                onClick={stopVoiceRecording}
                className="w-20 h-20 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center transition-all duration-200 shadow-lg hover:scale-105 active:scale-95 cursor-pointer animate-pulse"
                aria-label="Tap to stop recording"
              >
                <Square className="w-7 h-7" />
              </button>
            )}
            <div className="text-center">
              <p className="text-sm font-medium">
                {voiceRecording ? "Listening... Tap to stop" : voiceLoading ? "Processing your voice..." : "Tap to talk"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Voice powered by Cactus Whisper
              </p>
            </div>
            {lastTranscript && (
              <div className="w-full bg-muted/50 rounded-lg px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">You said:</p>
                <p className="text-sm font-medium">{lastTranscript}</p>
              </div>
            )}
            {micError && (
              <div className="flex items-start gap-2 bg-destructive/10 text-destructive text-xs rounded-lg px-3 py-2" role="alert">
                <CircleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{micError}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Text Input */}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Type a question about your surroundings..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendQuestion()}
            className="rounded-lg h-10"
            aria-label="Type your question"
          />
          <Button
            size="icon"
            onClick={sendQuestion}
            disabled={!question.trim()}
            className="rounded-lg h-10 w-10 flex-shrink-0"
            aria-label="Send question"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>

        {/* Conversation History */}
        <section aria-label="Conversation history" aria-live="polite">
          <div className="flex items-center gap-2 mb-2">
            <History className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Conversation</h2>
            {conversation.length > 0 && (
              <Badge variant="secondary" className="text-[10px] h-5">
                {conversation.length}
              </Badge>
            )}
          </div>

          <Card>
            <CardContent className="p-3">
              {conversation.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <Eye className="w-6 h-6 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {cameraActive ? "Waiting for analysis results..." : "Start the camera or ask a question to begin"}
                  </p>
                </div>
              ) : (
                <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                  {conversation.map((entry) => (
                    <div key={entry.id} className={`flex gap-2.5 animate-slide-in-up ${entry.type === "user" ? "flex-row-reverse" : ""}`}>
                      {/* Avatar */}
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                          entry.type === "user"
                            ? "bg-primary/10"
                            : entry.type === "hazard"
                            ? "bg-destructive/10"
                            : "bg-muted"
                        }`}
                      >
                        {entry.type === "user" ? (
                          <MessageSquare className="w-3.5 h-3.5 text-primary" />
                        ) : entry.type === "hazard" ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                        ) : (
                          <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                      </div>

                      {/* Bubble */}
                      <div className={`flex-1 min-w-0 ${entry.type === "user" ? "text-right" : ""}`}>
                        <div
                          className={`inline-block rounded-xl px-3 py-2 text-sm leading-relaxed max-w-full ${
                            entry.type === "user"
                              ? "bg-primary text-primary-foreground rounded-br-sm"
                              : entry.type === "hazard"
                              ? "bg-destructive/10 text-foreground border border-destructive/20 rounded-bl-sm"
                              : "bg-muted text-foreground rounded-bl-sm"
                          }`}
                        >
                          <p className="break-words">{entry.text}</p>
                          {entry.hazards && entry.hazards.length > 0 && (
                            <div className="flex items-center gap-1.5 flex-wrap mt-2">
                              {entry.hazards.map((h: Hazard, i: number) => (
                                <Badge
                                  key={`${h.label}-${i}`}
                                  variant={h.severity === "high" ? "destructive" : "secondary"}
                                  className="text-[10px]"
                                >
                                  {h.label.toUpperCase()}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-[10px] text-muted-foreground">{formatTime(entry.timestamp)}</span>
                          {entry.routed && (
                            <Badge variant="outline" className="text-[9px] h-4 px-1.5 font-normal">
                              {entry.routed === "local" ? "Edge" : "Cloud"}
                              {entry.latencyMs ? ` · ${entry.latencyMs}ms` : ""}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={conversationEndRef} />
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Routing Stats — Compact */}
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "Latency", value: `${latencyMs}ms`, icon: Zap },
            { label: "Edge ratio", value: `${edgeRatio}%`, icon: Cpu },
            { label: "Edge", value: String(localCount), icon: Cpu },
            { label: "Cloud", value: String(cloudCount), icon: Cloud },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-muted/50 rounded-lg px-2.5 py-2 text-center border">
              <Icon className="w-3.5 h-3.5 text-muted-foreground mx-auto mb-1" aria-hidden="true" />
              <p className="text-sm font-semibold font-mono leading-none">{value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* Last routing detail */}
        {lastUpdate && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <Badge
              variant={lastUpdate.routed === "local" ? "default" : "secondary"}
              className="text-[10px] h-5"
            >
              {lastUpdate.routed === "local" ? (
                <><Cpu className="w-3 h-3 mr-1" />LOCAL</>
              ) : (
                <><Cloud className="w-3 h-3 mr-1" />CLOUD</>
              )}
            </Badge>
            <span className="font-mono">{lastUpdate.reason || "—"}</span>
            {lastUpdate.confidence !== undefined && (
              <span className="ml-auto font-mono">conf: {lastUpdate.confidence.toFixed(2)}</span>
            )}
          </div>
        )}

        {/* Settings */}
        <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="secondary"
              className="w-full justify-between rounded-lg"
              size="sm"
            >
              <span className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                Settings
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${settingsOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="cloud-toggle" className="text-sm flex items-center gap-2 cursor-pointer">
                      {cloudEnabled ? <Cloud className="w-4 h-4 text-primary" /> : <CloudOff className="w-4 h-4 text-muted-foreground" />}
                      <span>Cloud processing</span>
                    </Label>
                    <Switch
                      id="cloud-toggle"
                      checked={cloudEnabled}
                      onCheckedChange={setCloudEnabled}
                      aria-label="Toggle cloud processing"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="offline-toggle" className="text-sm flex items-center gap-2 cursor-pointer">
                      <WifiOff className="w-4 h-4 text-muted-foreground" />
                      <span>Simulate offline</span>
                    </Label>
                    <Switch
                      id="offline-toggle"
                      checked={offlineSimulated}
                      onCheckedChange={setOfflineSimulated}
                      aria-label="Simulate offline mode"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="hazard-toggle" className="text-sm flex items-center gap-2 cursor-pointer">
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                      <span>Test hazard</span>
                    </Label>
                    <Switch
                      id="hazard-toggle"
                      checked={testHazard}
                      onCheckedChange={setTestHazard}
                      aria-label="Toggle test hazard"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </CollapsibleContent>
        </Collapsible>

        {/* Demo Script */}
        <Collapsible open={demoOpen} onOpenChange={setDemoOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="secondary"
              className="w-full justify-between rounded-lg"
              size="sm"
            >
              <span className="flex items-center gap-2">
                <Zap className="w-4 h-4" />
                Demo Script
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${demoOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <Card>
              <CardContent className="p-4 space-y-4 text-sm">
                {[
                  {
                    step: 1,
                    title: "Local-Only Mode",
                    desc: "Turn Cloud OFF + Offline ON. Start camera and streaming. See LOCAL hazard alerts with no cloud calls.",
                  },
                  {
                    step: 2,
                    title: "Cloud Escalation",
                    desc: 'Turn Cloud ON + Offline OFF. Ask a complex question (e.g., "Is there a crosswalk ahead?"). See CLOUD route with reason.',
                  },
                  {
                    step: 3,
                    title: "Instant Hazard Alert",
                    desc: 'Toggle Test Hazard ON. See instant LOCAL "Stop — stairs ahead" with TTS. Always routes locally for safety.',
                  },
                ].map(({ step, title, desc }) => (
                  <div key={step} className="flex gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {step}
                    </div>
                    <div>
                      <p className="font-medium">{title}</p>
                      <p className="text-muted-foreground text-xs mt-0.5">{desc}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </CollapsibleContent>
        </Collapsible>
      </main>
    </div>
  );
}
