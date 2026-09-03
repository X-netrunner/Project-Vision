(() => {
  const SRIJAN_WS_URL =
    "ws://127.0.0.1:8001/ws";

  let socket:
    WebSocket | null = null;

  let port:
    chrome.runtime.Port | null = null;

  let reconnectTimer:
    ReturnType<typeof setTimeout> | null =
    null;

  let reconnectTimerWs:
    ReturnType<typeof setTimeout> | null =
    null;

  function log(
    ...args: unknown[]
  ): void {
    console.log(
      "[Project-Vision:offscreen]",
      ...args
    );
  }

  function notify(
    message: unknown
  ): void {
    try {
      port?.postMessage(message);
    } catch {
      // Port may be closed while the service worker restarts.
    }
  }

  function openSocket(): void {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (reconnectTimerWs !== null) {
      return;
    }

    log(
      "Connecting to Srijan:",
      SRIJAN_WS_URL
    );

    try {
      const ws =
        new WebSocket(
          SRIJAN_WS_URL
        );

      socket = ws;

      ws.onopen = () => {
        notify({
          type: "WS_STATUS",
          status: "open",
        });
      };

      ws.onmessage = (
        event
      ) => {
        notify({
          type: "WS_MSG",
          data: event.data,
        });
      };

      ws.onerror = (
        event
      ) => {
        log(
          "Srijan WebSocket error:",
          event
        );
      };

      ws.onclose = () => {
        if (socket === ws) {
          socket = null;
        }

        notify({
          type: "WS_STATUS",
          status: "closed",
        });

        scheduleSocketReconnect();
      };
    } catch (error) {
      log(
        "Failed to connect to Srijan:",
        error
      );

      socket = null;

      scheduleSocketReconnect();
    }
  }

  function scheduleSocketReconnect(): void {
    if (reconnectTimerWs !== null) {
      return;
    }

    reconnectTimerWs =
      setTimeout(() => {
        reconnectTimerWs = null;
        openSocket();
      }, 3000);
  }

  function connectToWorker(): void {
    try {
      port?.disconnect();
    } catch {
      // ignore
    }

    const p =
      chrome.runtime.connect({
        name: "offscreen",
      });

    port = p;

    p.onMessage.addListener(
      (message) => {
        const msg =
          message as {
            type?: string;
            data?: unknown;
          };

        if (
          msg?.type === "WS_SEND" &&
          typeof msg.data === "string"
        ) {
          if (
            !socket ||
            socket.readyState !== WebSocket.OPEN
          ) {
            openSocket();
            return;
          }

          try {
            socket.send(msg.data);
          } catch (error) {
            log(
              "Failed to send:",
              error
            );
          }
          return;
        }
      }
    );

    p.onDisconnect.addListener(
      () => {
        log(
          "Service worker bridge disconnected; reconnecting."
        );

        if (port === p) {
          port = null;
        }

        scheduleWorkerReconnect();
      }
    );

    log(
      "Connected to service worker."
    );
  }

  function scheduleWorkerReconnect(): void {
    if (reconnectTimer !== null) {
      return;
    }

    reconnectTimer =
      setTimeout(() => {
        reconnectTimer = null;
        connectToWorker();
      }, 2000);
  }

  connectToWorker();

  log(
    "Offscreen document ready"
  );
})();
