(() => {
  const STORAGE_KEY = "projectVisionSrijanWsUrl";
  const DEFAULT_URL = "";

  let srijanWsUrl = DEFAULT_URL;
  let socket: WebSocket | null = null;
  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let workerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectGeneration = 0;

  const outgoingQueue: string[] = [];
  const MAX_QUEUE_SIZE = 100;

  function log(event: string, data?: unknown): void {
    const prefix = `[Project-Vision:offscreen ${new Date().toISOString()}]`;
    if (data === undefined) console.log(prefix, event);
    else console.log(prefix, event, data);
  }

  function notify(message: unknown): void {
    try { port?.postMessage(message); } catch { /* worker may be restarting */ }
  }

  function notifyStatus(status: string, extra: Record<string, unknown> = {}): void {
    notify({ type: "WS_STATUS", status, url: srijanWsUrl, ...extra });
  }

  function setSrijanUrl(nextUrl: string): void {
    const next = nextUrl.trim();

    if (next === srijanWsUrl) {
      return;
    }

    srijanWsUrl = next;
    connectGeneration++;

    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const oldSocket = socket;
    socket = null;

    if (oldSocket) {
      try { oldSocket.close(1000, "Srijan URL changed"); } catch {}
    }

    log("SRIJAN_URL_UPDATED", { url: srijanWsUrl || "<not configured>" });
    void openSocket();
  }

  function validUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === "wss:" || parsed.protocol === "ws:") && !!parsed.host;
    } catch {
      return false;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null || !srijanWsUrl) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openSocket();
    }, 3000);
    log("SRIJAN_RECONNECT_SCHEDULED", { delayMs: 3000, queue: outgoingQueue.length });
  }

  function flushQueue(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (outgoingQueue.length) {
      const data = outgoingQueue.shift()!;
      try {
        socket.send(data);
        log("SRIJAN_TX_QUEUED_FLUSHED", { bytes: data.length, queue: outgoingQueue.length });
      } catch (error) {
        outgoingQueue.unshift(data);
        log("SRIJAN_TX_QUEUE_FLUSH_FAILED", error);
        break;
      }
    }
  }

  async function openSocket(): Promise<void> {
    if (!srijanWsUrl) {
      notifyStatus("not_configured");
      log("SRIJAN_NOT_CONFIGURED");
      return;
    }
    if (!validUrl(srijanWsUrl)) {
      notifyStatus("invalid_url", { error: "Srijan URL must start with ws:// or wss://" });
      log("SRIJAN_INVALID_URL", { url: srijanWsUrl });
      return;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (reconnectTimer !== null) return;

    const generation = ++connectGeneration;
    notifyStatus("connecting");
    log("SRIJAN_WS_CONNECTING", { url: srijanWsUrl, generation });

    let ws: WebSocket;
    try {
      ws = new WebSocket(srijanWsUrl);
    } catch (error) {
      socket = null;
      notifyStatus("error", {
        error: error instanceof Error ? error.message : String(error),
      });
      notify({
        type: "WS_ERROR",
        url: srijanWsUrl,
        message: error instanceof Error ? error.message : String(error),
      });
      log("SRIJAN_WS_CONSTRUCTOR_FAILED", {
        url: srijanWsUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      if (generation !== connectGeneration) return;
      log("SRIJAN_WS_OPEN", { url: srijanWsUrl, queue: outgoingQueue.length });
      notifyStatus("open");
      flushQueue();
    };

    ws.onmessage = (event) => {
      log("SRIJAN_RX", { bytes: typeof event.data === "string" ? event.data.length : undefined });
      notify({ type: "WS_MSG", data: event.data });
    };

    ws.onerror = () => {
      log("SRIJAN_WS_ERROR", { url: srijanWsUrl, readyState: ws.readyState });
      notify({ type: "WS_ERROR", url: srijanWsUrl, message: "WebSocket error event fired" });
    };

    ws.onclose = (event) => {
      if (generation !== connectGeneration) return;
      log("SRIJAN_WS_CLOSE", {
        url: srijanWsUrl,
        code: event.code,
        reason: event.reason,
        clean: event.wasClean,
        queue: outgoingQueue.length,
      });
      if (socket === ws) socket = null;
      notifyStatus("closed", { code: event.code, reason: event.reason, clean: event.wasClean });
      scheduleReconnect();
    };
  }

  function send(data: string): void {
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(data);
        log("SRIJAN_TX", { bytes: data.length });
        return;
      } catch (error) {
        log("SRIJAN_TX_FAILED_QUEUEING", error);
      }
    }
    if (outgoingQueue.length >= MAX_QUEUE_SIZE) outgoingQueue.shift();
    outgoingQueue.push(data);
    log("SRIJAN_TX_QUEUED", { queue: outgoingQueue.length, bytes: data.length });
    void openSocket();
  }

  function connectToWorker(): void {
    try { port?.disconnect(); } catch {}
    const p = chrome.runtime.connect({ name: "offscreen" });
    port = p;
    p.onMessage.addListener((message) => {
      const msg = message as { type?: string; data?: unknown };
      if (msg?.type === "WS_SEND" && typeof msg.data === "string") {
        send(msg.data);
        return;
      }
      if (msg?.type === "WS_SET_URL" && typeof msg.data === "string") {
        setSrijanUrl(msg.data);
        return;
      }
      if (msg?.type === "WS_RECONNECT") {
        log("SRIJAN_RECONNECT_REQUESTED");
        connectGeneration++;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        const oldSocket = socket;
        socket = null;
        if (oldSocket) {
          try { oldSocket.close(1000, "Manual reconnect"); } catch {}
        }
        void openSocket();
      }
    });
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      log("OFFSCREEN_WORKER_BRIDGE_CLOSED");
      if (workerReconnectTimer === null) {
        workerReconnectTimer = setTimeout(() => {
          workerReconnectTimer = null;
          connectToWorker();
        }, 2000);
      }
    });
    log("OFFSCREEN_WORKER_BRIDGE_OPEN");
  }



  connectToWorker();
  void openSocket();
  log("OFFSCREEN_READY");
})();
