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
} from "lucide-react";
import type { UpdateMessage, Hazard } from "@shared/schema";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "fallback";

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const userIdRef = useRef(`user_${Math.random().toString(36).slice(2, 8)}`);

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
    if (update.latencyMs) setLatencyMs(update.latencyMs);

    const total = (update.debug?.match(/edge=(\d+)/)?.[1] || "0");
    const cloud = (update.debug?.match(/cloud=(\d+)/)?.[1] || "0");
    const l = parseInt(total);
    const c = parseInt(cloud);
    setLocalCount(l);
    setCloudCount(c);
    const t = l + c;
    setEdgeRatio(t > 0 ? Math.round((l / t) * 100) : 100);

    if (update.speak) {
      speak(update.say);
    }
  }, [speak]);

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
    };

    ws.onerror = () => {
      setConnectionStatus("fallback");
      ws.close();
    };

    wsRef.current = ws;
  }, [cloudEnabled, offlineSimulated, testHazard, handleUpdate]);

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
      } catch (err) {
        console.error("HTTP fallback error:", err);
      }
    }
  }, [mode, cloudEnabled, offlineSimulated, testHazard, handleUpdate]);

  const startCamera = useCallback(async () => {
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
    } catch (err) {
      console.error("Camera access denied:", err);
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
      } catch (err) {
        console.error("Question error:", err);
      }
    }

    setQuestion("");
  }, [question, cloudEnabled, offlineSimulated, handleUpdate]);

  const connectionIcon = () => {
    switch (connectionStatus) {
      case "connected": return <Wifi className="w-4 h-4 text-green-500 dark:text-green-400" />;
      case "connecting": return <Radio className="w-4 h-4 text-yellow-500 dark:text-yellow-400 animate-pulse" />;
      case "fallback": return <Activity className="w-4 h-4 text-orange-500 dark:text-orange-400" />;
      default: return <WifiOff className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const connectionLabel = () => {
    switch (connectionStatus) {
      case "connected": return "WS Connected";
      case "connecting": return "Connecting...";
      case "fallback": return "HTTP Fallback";
      default: return "Disconnected";
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Shield className="w-5 h-5 text-foreground" />
            <h1 className="text-lg font-semibold">EchoPath</h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {connectionIcon()}
            <span className="text-xs text-muted-foreground">{connectionLabel()}</span>
            <Button
              data-testid="button-mute"
              size="icon"
              variant="ghost"
              onClick={() => setMuted(!muted)}
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Local-first conversational mobility assistant (prototype)
        </p>
      </header>

      <main className="flex-1 p-4 space-y-4 max-w-lg mx-auto w-full">
        {/* Camera Preview */}
        <div className="relative rounded-md bg-muted aspect-video flex items-center justify-center">
          <video
            ref={videoRef}
            className={`w-full h-full object-cover rounded-md ${!cameraActive ? "hidden" : ""}`}
            playsInline
            muted
            data-testid="video-camera"
          />
          {!cameraActive && (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <CameraOff className="w-8 h-8" />
              <span className="text-sm">Camera off</span>
            </div>
          )}
          <canvas ref={canvasRef} className="hidden" />

          {/* Streaming indicator */}
          {streaming && cameraActive && (
            <div className="absolute top-2 left-2 flex items-center gap-1 bg-destructive/90 text-destructive-foreground px-2 py-0.5 rounded-md text-xs">
              <div className="w-1.5 h-1.5 bg-destructive-foreground rounded-full animate-pulse" />
              LIVE {fps} FPS
            </div>
          )}
        </div>

        {/* Camera Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            data-testid="button-start-camera"
            onClick={cameraActive ? stopCamera : startCamera}
            variant={cameraActive ? "destructive" : "default"}
            size="sm"
          >
            {cameraActive ? <CameraOff className="w-4 h-4 mr-1" /> : <Camera className="w-4 h-4 mr-1" />}
            {cameraActive ? "Stop" : "Start Camera"}
          </Button>

          <div className="flex items-center gap-2">
            <Label htmlFor="streaming-toggle" className="text-sm">Stream</Label>
            <Switch
              id="streaming-toggle"
              data-testid="switch-streaming"
              checked={streaming}
              onCheckedChange={setStreaming}
              disabled={!cameraActive}
            />
          </div>

          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <Label className="text-xs text-muted-foreground">{fps} FPS</Label>
            <Slider
              data-testid="slider-fps"
              className="w-20"
              min={0.5}
              max={2}
              step={0.5}
              value={[fps]}
              onValueChange={([v]) => setFps(v)}
            />
          </div>
        </div>

        {/* Mode & Toggles */}
        <Card>
          <CardContent className="p-4 space-y-3">
            {/* Mode Selector */}
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-sm font-medium">Mode:</Label>
              <Button
                data-testid="button-mode-hazard"
                size="sm"
                variant={mode === "hazard" ? "default" : "secondary"}
                onClick={() => setMode("hazard")}
              >
                <TriangleAlert className="w-3 h-3 mr-1" />
                Hazard
              </Button>
              <Button
                data-testid="button-mode-qa"
                size="sm"
                variant={mode === "qa" ? "default" : "secondary"}
                onClick={() => setMode("qa")}
              >
                <MessageSquare className="w-3 h-3 mr-1" />
                Q&A
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="cloud-toggle" className="text-sm flex items-center gap-1">
                  {cloudEnabled ? <Cloud className="w-3.5 h-3.5" /> : <CloudOff className="w-3.5 h-3.5" />}
                  Cloud
                </Label>
                <Switch
                  id="cloud-toggle"
                  data-testid="switch-cloud"
                  checked={cloudEnabled}
                  onCheckedChange={setCloudEnabled}
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="offline-toggle" className="text-sm flex items-center gap-1">
                  <WifiOff className="w-3.5 h-3.5" />
                  Offline
                </Label>
                <Switch
                  id="offline-toggle"
                  data-testid="switch-offline"
                  checked={offlineSimulated}
                  onCheckedChange={setOfflineSimulated}
                />
              </div>

              <div className="flex items-center justify-between gap-2 col-span-2">
                <Label htmlFor="hazard-toggle" className="text-sm flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Test Hazard
                </Label>
                <Switch
                  id="hazard-toggle"
                  data-testid="switch-test-hazard"
                  checked={testHazard}
                  onCheckedChange={setTestHazard}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Question Input */}
        <div className="flex items-center gap-2">
          <Input
            data-testid="input-question"
            placeholder="Ask about your surroundings..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendQuestion()}
          />
          <Button
            data-testid="button-send-question"
            size="icon"
            onClick={sendQuestion}
            disabled={!question.trim()}
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>

        {/* Routing Status Panel */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Routing Status</span>
              {lastUpdate && (
                <Badge
                  data-testid="badge-route"
                  variant={lastUpdate.routed === "local" ? "default" : "secondary"}
                >
                  {lastUpdate.routed === "local" ? (
                    <><Cpu className="w-3 h-3 mr-1" /> LOCAL (Cactus)</>
                  ) : (
                    <><Cloud className="w-3 h-3 mr-1" /> CLOUD (Gemini)</>
                  )}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Reason: </span>
                <span data-testid="text-reason" className="font-mono">
                  {lastUpdate?.reason || "--"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Confidence: </span>
                <span data-testid="text-confidence" className="font-mono">
                  {lastUpdate?.confidence !== undefined ? lastUpdate.confidence.toFixed(2) : "--"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Latency: </span>
                <span data-testid="text-latency" className="font-mono">{latencyMs}ms</span>
              </div>
              <div>
                <span className="text-muted-foreground">Edge Ratio: </span>
                <span data-testid="text-edge-ratio" className="font-mono">{edgeRatio}%</span>
              </div>
              <div>
                <span className="text-muted-foreground">Edge calls: </span>
                <span data-testid="text-local-count" className="font-mono">{localCount}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Cloud calls: </span>
                <span data-testid="text-cloud-count" className="font-mono">{cloudCount}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Output Panel */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Assistant Output</span>
            </div>

            <p data-testid="text-say" className="text-sm leading-relaxed">
              {lastUpdate?.say || "Waiting for camera input..."}
            </p>

            {lastUpdate?.hazards && lastUpdate.hazards.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                {lastUpdate.hazards.map((h: Hazard, i: number) => (
                  <Badge
                    key={`${h.label}-${i}`}
                    data-testid={`badge-hazard-${i}`}
                    variant={h.severity === "high" ? "destructive" : "secondary"}
                  >
                    {h.label.toUpperCase()} ({h.severity})
                  </Badge>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Frames processed locally unless escalated to cloud.
            </p>
          </CardContent>
        </Card>

        {/* Connection Fallback Banner */}
        {connectionStatus === "fallback" && (
          <div className="bg-muted border rounded-md p-3 text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-orange-500 dark:text-orange-400 flex-shrink-0" />
            <span>WebSocket down -- using HTTP fallback</span>
          </div>
        )}

        {/* Demo Script Panel */}
        <Collapsible open={demoOpen} onOpenChange={setDemoOpen}>
          <CollapsibleTrigger asChild>
            <Button
              data-testid="button-demo-script"
              variant="secondary"
              className="w-full justify-between"
              size="sm"
            >
              <span className="flex items-center gap-2">
                <Zap className="w-4 h-4" />
                Demo Script
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform ${demoOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <Card>
              <CardContent className="p-4 space-y-3 text-sm">
                <div className="space-y-1">
                  <p className="font-medium">Step 1: Local-Only Mode</p>
                  <p className="text-muted-foreground">
                    Turn Cloud OFF + Offline ON. Start camera and streaming. See LOCAL hazard alerts with no cloud calls.
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="font-medium">Step 2: Cloud Escalation</p>
                  <p className="text-muted-foreground">
                    Turn Cloud ON + Offline OFF. Ask a complex question (e.g., "Is there a crosswalk ahead?"). See CLOUD route with reason.
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="font-medium">Step 3: Instant Hazard Alert</p>
                  <p className="text-muted-foreground">
                    Toggle Test Hazard ON. See instant LOCAL "Stop -- stairs ahead" with TTS. Always routes locally for safety.
                  </p>
                </div>
              </CardContent>
            </Card>
          </CollapsibleContent>
        </Collapsible>
      </main>
    </div>
  );
}
