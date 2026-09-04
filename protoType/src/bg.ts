import { validateAction } from "./actions/validator.js";
import { executeContentAction } from "./actions/executor.js";

import type {
  ActionPayload,
  ActionResult,
  ActionResultMessage,
  AgentActionMessage,
  ChatMessage,
  ErrorMessage,
  RawScreenshotMessage,
  RedactedScreenshotMessage,
  SrijanMessage,
  UserPromptMessage,
} from "./types.js";



const SRIJAN_WS_URL_STORAGE_KEY =
  "projectVisionSrijanWsUrl";

const DEFAULT_SRIJAN_WS_URL = "";



const VARUN_WS_URL =
  "ws://127.0.0.1:8000/ws";

let varunSocket: WebSocket | null = null;
let varunConnectPromise: Promise<WebSocket> | null = null;

const varunPendingRequests = new Map<
  string,
  {
    resolve: (message: RedactedScreenshotMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();



let offscreenPort:
  chrome.runtime.Port | null = null;

let nativeServerPort:
  chrome.runtime.Port | null = null;
let nativeHostRetryTimer: ReturnType<typeof setTimeout> | null = null;
let nativeHostRetryDelayMs = 2000;

let srijanConnectionStatus = "not_configured";
let srijanConnectionUrl = "";

const NATIVE_HOST_NAME =
  "com.projectvision.local_server";

const OFFSCREEN_URL =
  "offscreen.html";



const CHAT_STORAGE_KEY =
  "projectVisionChatMessages";

const MAX_CHAT_MESSAGES = 100;

async function getChatMessages(): Promise<ChatMessage[]> {
  const stored =
    await chrome.storage.local.get(
      CHAT_STORAGE_KEY
    );

  const messages =
    stored[CHAT_STORAGE_KEY];

  if (!Array.isArray(messages)) {
    return [];
  }

  return messages as ChatMessage[];
}

async function saveChatMessages(
  messages: ChatMessage[]
): Promise<void> {
  const trimmed =
    messages.slice(
      -MAX_CHAT_MESSAGES
    );

  await chrome.storage.local.set({
    [CHAT_STORAGE_KEY]:
      trimmed,
  });
}

async function addChatMessage(
  message: ChatMessage
): Promise<void> {
  const messages =
    await getChatMessages();

  messages.push(message);

  await saveChatMessages(
    messages
  );

 
  try {
    await chrome.runtime.sendMessage({
      type: "CHAT_MESSAGE",
      message,
    });
  } catch {
    
  }
}

function createChatMessage(
  sender: ChatMessage["sender"],
  options: {
    text?: string;
    raw?: unknown;
    image?: string;
    type?: string;
  }
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    sender,
    timestamp: Date.now(),
    ...options,
  };
}



function log(
  ...args: unknown[]
): void {
  console.log(
    "[Project-Vision]",
    ...args
  );
}



async function getSrijanWsUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(SRIJAN_WS_URL_STORAGE_KEY);
    return typeof stored[SRIJAN_WS_URL_STORAGE_KEY] === "string"
      ? stored[SRIJAN_WS_URL_STORAGE_KEY].trim()
      : DEFAULT_SRIJAN_WS_URL;
  } catch {
    return DEFAULT_SRIJAN_WS_URL;
  }
}

function sendToSrijan(
  message: unknown
): boolean {
  if (
    !offscreenPort
  ) {
    log("SRIJAN_SEND_BRIDGE_UNAVAILABLE");

    return false;
  }

  try {
    const serialized = JSON.stringify(message);
    offscreenPort.postMessage({
      type: "WS_SEND",
      data: serialized,
    });
    log("SRIJAN_BRIDGE_TX", {
      type: (message as { type?: unknown })?.type,
      requestId: (message as { request_id?: unknown })?.request_id,
      bytes: serialized.length,
    });
    return true;
  } catch (error) {
    log(
      "Failed to send message to Srijan:",
      error
    );

    return false;
  }
}



function scheduleNativeHostRetry(): void {
  if (nativeHostRetryTimer !== null) return;
  const delay = nativeHostRetryDelayMs;
  nativeHostRetryDelayMs = Math.min(nativeHostRetryDelayMs * 2, 30000);
  nativeHostRetryTimer = setTimeout(() => {
    nativeHostRetryTimer = null;
    startLocalServerHost();
  }, delay);
}

function startLocalServerHost(): void {
  if (nativeServerPort || nativeHostRetryTimer !== null) return;
  try {
    if (nativeServerPort) {
      return;
    }

    const port = chrome.runtime.connectNative(
      NATIVE_HOST_NAME
    );

    nativeServerPort = port;
    nativeHostRetryDelayMs = 2000;

    port.onMessage.addListener((message) => {
      log("Local server host:", message);
      void addChatMessage(
        createChatMessage("system", {
          type: "LOCAL_SERVER_STATUS",
          text:
            message?.status === "started"
              ? `Local app.py started (PID ${String(message.pid ?? "unknown")}).`
              : `Local server: ${JSON.stringify(message)}`,
        })
      );
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      nativeServerPort = null;
      log(
        "Local server native host disconnected:",
        error?.message ?? "no error"
      );

      if (nativeServerPort === null) {
        scheduleNativeHostRetry();
      }
    });

    port.postMessage({ type: "PING" });
    log("Requested local app.py startup through native host.");
  } catch (error) {
    log("Local server auto-start unavailable:", error);
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification:
        "Keep an idle-persistent WebSocket connection to the Project-Vision server alive across service-worker evictions.",
    });
  } catch (error) {
    // Only a single offscreen document may exist; treat "already
    // present" errors as success.
    log(
      "Offscreen document create (may already exist):",
      error
    );
  }
}

async function waitForOffscreenBridge(timeoutMs = 5000): Promise<boolean> {
  if (offscreenPort) {
    return true;
  }

  log("SRIJAN_WAITING_FOR_OFFSCREEN_BRIDGE", { timeoutMs });
  await ensureOffscreenDocument();

  const startedAt = Date.now();
  while (!offscreenPort && Date.now() - startedAt < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  if (offscreenPort) {
    log("SRIJAN_OFFSCREEN_BRIDGE_READY", { waitedMs: Date.now() - startedAt });
    return true;
  }

  log("SRIJAN_OFFSCREEN_BRIDGE_TIMEOUT", { timeoutMs });
  return false;
}

function registerOffscreenListener(): void {
  chrome.runtime.onConnect.addListener(
    (port) => {
      if (
        port.name !== "offscreen"
      ) {
        return;
      }

      log(
        "Offscreen bridge connected."
      );

      offscreenPort = port;

      void getSrijanWsUrl().then((url) => {
        if (offscreenPort !== port) return;
        try {
          port.postMessage({ type: "WS_SET_URL", data: url });
          log("SRIJAN_URL_SENT_TO_OFFSCREEN", { url: url || "<not configured>" });
        } catch (error) {
          log("Failed to send Srijan URL to offscreen bridge:", error);
        }
      });

      port.onMessage.addListener(
        (message) => {
          const msg =
            message as {
              type?: string;
              data?: unknown;
            };

          if (
            msg?.type === "WS_MSG" &&
            typeof msg.data === "string"
          ) {
            void handleSrijanMessage(
              msg.data
            ).catch(
              (error) => {
                log(
                  "Unhandled error processing Srijan message:",
                  error
                );
              }
            );
            return;
          }

          if (msg?.type === "WS_STATUS") {
            const statusMessage = msg as {
              status?: unknown;
              url?: unknown;
              code?: unknown;
              reason?: unknown;
              wasClean?: unknown;
            };

            srijanConnectionStatus = typeof statusMessage.status === "string"
              ? statusMessage.status
              : "unknown";
            srijanConnectionUrl = typeof statusMessage.url === "string"
              ? statusMessage.url
              : "";
            log(
              "Srijan WebSocket status:",
              srijanConnectionStatus,
              "url:",
              srijanConnectionUrl || "<not configured>",
              "code:",
              statusMessage.code ?? "-",
              "reason:",
              statusMessage.reason ?? "-",
              "clean:",
              statusMessage.wasClean ?? "-"
            );
            void chrome.runtime.sendMessage({
              type: "SRIJAN_STATUS",
              status: srijanConnectionStatus,
              url: srijanConnectionUrl,
              code: statusMessage.code,
              reason: statusMessage.reason,
              wasClean: statusMessage.wasClean,
            }).catch(() => {});
            return;
          }

          if (msg?.type === "WS_ERROR") {
            log(
              "Srijan WebSocket error:",
              msg
            );
          }
        }
      );

      port.onDisconnect.addListener(
        () => {
          log(
            "Offscreen bridge disconnected."
          );

          if (offscreenPort === port) {
            offscreenPort = null;
          }
        }
      );
    }
  );
}

async function setupOffscreenBridge(): Promise<void> {
  try {
    await ensureOffscreenDocument();
  } catch (error) {
    log(
      "Failed to set up offscreen bridge:",
      error
    );
  }
}



async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs =
    await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

  return tabs[0] ?? null;
}



async function waitForTabReady(
  tabId: number
): Promise<void> {
  const tab =
    await chrome.tabs.get(
      tabId
    );

  if (
    tab.status === "complete"
  ) {
    return;
  }

  await new Promise<void>(
    (resolve) => {
      const listener = (
        changedTabId: number,
        changeInfo: {
          status?: string;
        }
      ) => {
        if (
          changedTabId === tabId &&
          changeInfo.status ===
            "complete"
        ) {
          chrome.tabs.onUpdated.removeListener(
            listener
          );

          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(
        listener
      );
    }
  );
}


async function ensureContentScript(
  tabId: number
): Promise<void> {
  try {
    const response =
      await chrome.tabs.sendMessage(
        tabId,
        {
          type: "PING",
        }
      );

    if (
      response &&
      response.success === true
    ) {
      return;
    }
  } catch {
    // Content script isn't loaded.
  }

  await chrome.scripting.executeScript({
    target: {
      tabId,
    },
    files: [
      "dist/cs.js",
    ],
  });
}



async function captureScreenshot(
  tabId: number
): Promise<string> {
  const tab =
    await chrome.tabs.get(
      tabId
    );

  const url =
    tab.url ?? "";

  if (
    url.startsWith("chrome://") ||
    url.startsWith(
      "chrome-extension://"
    ) ||
    url.startsWith("edge://")
  ) {
    throw new Error(
      "Cannot capture screenshots on this browser page."
    );
  }

  return new Promise<string>(
    (resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        {
          format: "jpeg",
          quality: 90,
        },
        (
          dataUrl
        ) => {
          const runtimeError =
            chrome.runtime.lastError;

          if (runtimeError) {
            reject(
              new Error(
                runtimeError.message
              )
            );

            return;
          }

          if (!dataUrl) {
            reject(
              new Error(
                "Screenshot capture returned no data."
              )
            );

            return;
          }

          const prefix =
            "data:image/jpeg;base64,";

          const image =
            dataUrl.startsWith(prefix)
              ? dataUrl.slice(
                  prefix.length
                )
              : dataUrl;

          resolve(image);
        }
      );
    }
  );
}


function rejectPendingVarunRequests(
  error: Error
): void {
  for (const [requestId, pending] of varunPendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(error);
    varunPendingRequests.delete(requestId);
  }
}

function connectToVarun(): Promise<WebSocket> {
  if (varunSocket?.readyState === WebSocket.OPEN) {
    return Promise.resolve(varunSocket);
  }

  if (varunConnectPromise) {
    return varunConnectPromise;
  }

  varunConnectPromise = new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(VARUN_WS_URL);
    varunSocket = socket;

    socket.onopen = () => {
      settled = true;
      varunConnectPromise = null;
      log("Connected to Varun:", VARUN_WS_URL);
      resolve(socket);
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const message = JSON.parse(event.data) as RedactedScreenshotMessage | ErrorMessage;
        const requestId = message.request_id;

        if (!requestId) {
          return;
        }

        const pending = varunPendingRequests.get(requestId);
        if (!pending) {
          return;
        }

        varunPendingRequests.delete(requestId);
        clearTimeout(pending.timer);

        if (message.type === "REDACTED_SCREENSHOT") {
          pending.resolve(message);
        } else {
          pending.reject(new Error(message.error));
        }
      } catch (error) {
        log("Failed to parse Varun response:", error);
      }
    };

    socket.onerror = () => {
      if (!settled) {
        settled = true;
        varunConnectPromise = null;
        reject(new Error(`Varun is not reachable at ${VARUN_WS_URL}.`));
      }
    };

    socket.onclose = () => {
      if (varunSocket === socket) {
        varunSocket = null;
      }
      varunConnectPromise = null;
      rejectPendingVarunRequests(
        new Error("Varun WebSocket connection closed.")
      );

      if (!settled) {
        settled = true;
        reject(new Error(`Varun closed the connection at ${VARUN_WS_URL}.`));
      }
    };
  });

  return varunConnectPromise;
}

async function sendRawScreenshotToVarun(
  message: RawScreenshotMessage
): Promise<RedactedScreenshotMessage> {
  const socket = await connectToVarun();

  return new Promise<RedactedScreenshotMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      varunPendingRequests.delete(message.request_id);
      reject(
        new Error(
          "Varun did not return a redacted screenshot within 30 seconds."
        )
      );
    }, 30000);

    varunPendingRequests.set(message.request_id, {
      resolve,
      reject,
      timer,
    });

    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      clearTimeout(timer);
      varunPendingRequests.delete(message.request_id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}



async function getDevicePixelRatio(
  tabId: number
): Promise<number> {
  try {
    const results =
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.devicePixelRatio,
      });

    const value =
      results?.[0]?.result;

    return typeof value === "number" && value > 0
      ? value
      : 1;
  } catch {
    return 1;
  }
}

async function sendCapturedScreenshotToSrijan(
  requestId: string,
  tabId: number,
  stepIndex: number,
  actionResult: ActionResult | null,
  image: string
): Promise<boolean> {
  const devicePixelRatio =
    await getDevicePixelRatio(tabId);

  const rawMessage: RawScreenshotMessage = {
    type: "RAW_SCREENSHOT",
    request_id: requestId,
    tab_id: tabId,
    step_index: stepIndex,
    image,
    action_result: actionResult,
    device_pixel_ratio: devicePixelRatio,
  };

  const redactedMessage =
    await sendRawScreenshotToVarun(rawMessage);

  const srijanMessage: RawScreenshotMessage = {
    ...rawMessage,
    image: redactedMessage.image,
  };

  return sendToSrijan(srijanMessage);
}

async function sendRawScreenshotToSrijan(
  requestId: string,
  tabId: number,
  stepIndex: number,
  actionResult: ActionResult | null
): Promise<boolean> {
  try {
    const image = await captureScreenshot(tabId);
    return await sendCapturedScreenshotToSrijan(
      requestId,
      tabId,
      stepIndex,
      actionResult,
      image
    );
  } catch (error) {
    sendErrorToSrijan(
      requestId,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}



function sendActionResultToSrijan(
  requestId: string,
  actionId: string,
  result: ActionResult
): boolean {
  const message:
    ActionResultMessage = {
    type: "ACTION_RESULT",
    request_id:
      requestId,
    action_id:
      actionId,
    result,
  };

  return sendToSrijan(
    message
  );
}



function sendErrorToSrijan(
  requestId: string | undefined,
  error: string
): boolean {
  const message:
    ErrorMessage = {
    type: "ERROR",
    ...(requestId
      ? {
          request_id:
            requestId,
        }
      : {}),
    error,
  };

  return sendToSrijan(
    message
  );
}



function sendUserPromptToSrijan(
  requestId: string,
  prompt: string
): boolean {
  const message:
    UserPromptMessage = {
    type: "USER_PROMPT",
    request_id:
      requestId,
    prompt,
  };

  return sendToSrijan(
    message
  );
}



async function executeBackgroundAction(
  action: ActionPayload,
  tabId: number
): Promise<ActionResult> {
  try {
    switch (action.action) {
      case "open_tab": {
        if (!action.url) {
          return {
            success: false,
            action:
              action.action,
            step_index:
              action.step_index,
            tab_id: tabId,
            error:
              "URL is required",
          };
        }

        const newTab =
          await chrome.tabs.create({
            url: action.url,
          });

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            newTab.id,
        };
      }

      case "navigate": {
        if (!action.url) {
          return {
            success: false,
            action:
              action.action,
            step_index:
              action.step_index,
            tab_id: tabId,
            error:
              "URL is required",
          };
        }

        await chrome.tabs.update(
          tabId,
          {
            url: action.url,
          }
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            tabId,
        };
      }

      case "search": {
        if (!action.query) {
          return {
            success: false,
            action:
              action.action,
            step_index:
              action.step_index,
            tab_id: tabId,
            error:
              "Search query is required",
          };
        }

        const url =
          "https://duckduckgo.com/?q=" +
          encodeURIComponent(
            action.query
          );

        await chrome.tabs.update(
          tabId,
          {
            url,
          }
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            tabId,
        };
      }

      case "close_tab": {
        await chrome.tabs.remove(
          tabId
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            tabId,
        };
      }

      case "switch_tab": {
        if (
          typeof action.tab_id !==
          "number"
        ) {
          return {
            success: false,
            action:
              action.action,
            step_index:
              action.step_index,
            tab_id: tabId,
            error:
              "tab_id is required",
          };
        }

        await chrome.tabs.update(
          action.tab_id,
          {
            active: true,
          }
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            action.tab_id,
        };
      }

      default:
        return {
          success: false,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id: tabId,
          error:
            "Unsupported background action",
        };
    }
  } catch (error) {
    return {
      success: false,
      action:
        action.action,
      step_index:
        action.step_index,
      tab_id: tabId,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}


async function executeAgentAction(
  message: AgentActionMessage
): Promise<void> {
  const action =
    message.action;

  if (
    !validateAction(action)
  ) {
    sendErrorToSrijan(
      message.request_id,
      "Invalid AGENT_ACTION payload"
    );

    return;
  }

  let tabId =
    message.tab_id ??
    action.tab_id;

  if (
    typeof tabId !== "number"
  ) {
    const activeTab =
      await getActiveTab();

    if (
      !activeTab ||
      typeof activeTab.id !==
        "number"
    ) {
      sendErrorToSrijan(
        message.request_id,
        "No active browser tab found"
      );

      return;
    }

    tabId =
      activeTab.id;
  }

  try {
    await waitForTabReady(
      tabId
    );
  } catch (error) {
    sendErrorToSrijan(
      message.request_id,
      error instanceof Error
        ? error.message
        : String(error)
    );

    return;
  }

  let result:
    ActionResult;

  const backgroundActions =
    new Set([
      "open_tab",
      "navigate",
      "search",
      "close_tab",
      "switch_tab",
    ]);

  if (
    backgroundActions.has(
      action.action
    )
  ) {
    result =
      await executeBackgroundAction(
        action,
        tabId
      );
  } else {
    try {
      await ensureContentScript(
        tabId
      );

      result =
        await executeContentAction(
          action,
          tabId
        );
    } catch (error) {
      result = {
        success: false,
        action:
          action.action,
        step_index:
          action.step_index,
        tab_id:
          tabId,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  sendActionResultToSrijan(
    message.request_id,
    message.action_id,
    result
  );

  
  if (
    result.success &&
    !message.is_last_step
  ) {
    try {
      // Background actions can change which tab is active (open_tab,
      // switch_tab, close_tab). Capture the tab that is active after the
      // action rather than blindly reusing the pre-action tab id.
      let screenshotTabId = tabId;
      if (backgroundActions.has(action.action)) {
        const activeAfterAction = await getActiveTab();
        if (activeAfterAction && typeof activeAfterAction.id === "number") {
          screenshotTabId = activeAfterAction.id;
        }
      }

      await waitForTabReady(screenshotTabId);

      await sendRawScreenshotToSrijan(
        message.request_id,
        screenshotTabId,
        action.step_index,
        result
      );
    } catch (error) {
      log(
        "Failed to send screenshot after action:",
        error
      );
    }
  }
}



async function handleSrijanMessage(
  rawData: unknown
): Promise<void> {
  try {
    let parsed: unknown;

    if (
      typeof rawData === "string"
    ) {
      parsed =
        JSON.parse(rawData);
    } else {
      parsed =
        rawData;
    }

   

    const packet =
      parsed as {
        type?: string;
        [key: string]: unknown;
      };

    
    if (
      packet?.type ===
      "AGENT_ACTION"
    ) {
      await addChatMessage(
        createChatMessage(
          "server",
          {
            type:
              "AGENT_ACTION",
            raw: parsed,
            text:
              `Agent action: ${String(
                (
                  packet.action as
                    { action?: unknown }
                )?.action ??
                "unknown"
              )}`,
          }
        )
      );

      await executeAgentAction(
        parsed as AgentActionMessage
      );

      return;
    }

    
    if (
      packet?.type ===
      "ERROR"
    ) {
      await addChatMessage(
        createChatMessage(
          "server",
          {
            type:
              "ERROR",
            raw: parsed,
            text:
              typeof packet.error ===
              "string"
                ? packet.error
                : "Server error",
          }
        )
      );

      return;
    }

    
    await addChatMessage(
      createChatMessage(
        "server",
        {
          type:
            typeof packet?.type ===
            "string"
              ? packet.type
              : "JSON",
          raw: parsed,
          text:
            JSON.stringify(
              parsed,
              null,
              2
            ),
        }
      )
    );
  } catch (error) {
    const errorText =
      error instanceof Error
        ? error.message
        : String(error);

    log(
      "Failed to process Srijan JSON:",
      error
    );

    await addChatMessage(
      createChatMessage(
        "system",
        {
          type:
            "JSON_PARSE_ERROR",
          text:
            `Failed to process server JSON: ${errorText}`,
        }
      )
    );

    sendErrorToSrijan(
      undefined,
      errorText
    );
  }
}



async function startAgent(
  prompt: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  const cleanPrompt =
    prompt.trim();

  if (!cleanPrompt) {
    return {
      success: false,
      error:
        "Prompt cannot be empty",
    };
  }

  const requestId =
    crypto.randomUUID();

  // The popup can submit a prompt immediately after saving the URL.
  // The offscreen document may still be starting, so wait for its
  // bridge instead of failing the prompt with a false "not connected"
  // error. The offscreen WebSocket itself queues while CONNECTING.
  const bridgeReady = await waitForOffscreenBridge(5000);
  if (!bridgeReady) {
    const error = "Srijan bridge is still starting. Please retry in a moment.";
    await addChatMessage(
      createChatMessage("system", {
        type: "CONNECTION_ERROR",
        text: error,
      })
    );
    return { success: false, error };
  }

  const srijanUrl = await getSrijanWsUrl();
  if (!srijanUrl) {
    const error = "Srijan WebSocket URL is not configured. Set your ngrok wss:// URL in the extension Debug panel.";
    log("SRIJAN_NOT_CONFIGURED", error);
    return { success: false, error };
  }

  const activeTab = await getActiveTab();

  if (!activeTab || typeof activeTab.id !== "number") {
    return {
      success: false,
      error: "No active browser tab found",
    };
  }

  let initialScreenshot: string;
  try {
    initialScreenshot = await captureScreenshot(activeTab.id);
  } catch (error) {
    await addChatMessage(
      createChatMessage("user", {
        type: "USER_PROMPT",
        text: cleanPrompt,
      })
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const devicePixelRatio =
    await getDevicePixelRatio(activeTab.id);

  const rawInitialMessage: RawScreenshotMessage = {
    type: "RAW_SCREENSHOT",
    request_id: requestId,
    tab_id: activeTab.id,
    step_index: 0,
    image: initialScreenshot,
    action_result: null,
    device_pixel_ratio: devicePixelRatio,
  };

  let redactedInitialMessage: RedactedScreenshotMessage;

  try {
    redactedInitialMessage =
      await sendRawScreenshotToVarun(rawInitialMessage);
  } catch (error) {
    const errorText =
      error instanceof Error ? error.message : String(error);

    await addChatMessage(
      createChatMessage("system", {
        type: "VARUN_ERROR",
        text: `Varun failed to process the screenshot: ${errorText}`,
      })
    );

    return {
      success: false,
      error: errorText,
    };
  }

  await addChatMessage(
    createChatMessage("user", {
      type: "USER_PROMPT",
      text: cleanPrompt,
      image: redactedInitialMessage.image,
      raw: redactedInitialMessage,
    })
  );

  const promptSent = sendUserPromptToSrijan(
    requestId,
    cleanPrompt
  );

  if (!promptSent) {
    await addChatMessage(
      createChatMessage(
        "system",
        {
          text:
            "Could not send prompt: Srijan server is not connected.",
          type:
            "CONNECTION_ERROR",
        }
      )
    );

    return {
      success: false,
      error:
        "Srijan server is not connected",
    };
  }

  const screenshotSent =
    sendToSrijan({
      ...rawInitialMessage,
      image: redactedInitialMessage.image,
    });

  if (!screenshotSent) {
    await addChatMessage(
      createChatMessage(
        "system",
        {
          text:
            "Prompt was sent, but the initial screenshot could not be sent.",
          type:
            "SCREENSHOT_ERROR",
        }
      )
    );

    return {
      success: false,
      error:
        "Prompt was sent, but initial screenshot could not be sent",
    };
  }

  return {
    success: true,
  };
}



async function checkLocalServerHealth(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(VARUN_WS_URL);
    const finish = (result: { success: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ success: false, error: "Local app.py server did not accept a WebSocket connection on port 8000." }), 2500);
    socket.onopen = () => {
      clearTimeout(timer);
      finish({ success: true });
    };
    socket.onerror = () => {
      clearTimeout(timer);
      finish({ success: false, error: `Local app.py server is not reachable on ${VARUN_WS_URL}.` });
    };
  });
}

async function debugInitialContext(prompt: string): Promise<{ success: boolean; error?: string }> {
  return startAgent(prompt);
}

async function debugNativeHostPing(): Promise<{ success: boolean; error?: string }> {
  if (!nativeServerPort) {
    startLocalServerHost();
    return { success: false, error: "Native host is not connected. Check Native Messaging registration and retry." };
  }
  try {
    nativeServerPort.postMessage({ type: "PING" });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function debugContentPing(): Promise<{ success: boolean; error?: string }> {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    return { success: false, error: "No active browser tab found" };
  }
  try {
    await waitForTabReady(tab.id);
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    return response?.success === true
      ? { success: true }
      : { success: false, error: "Content script did not answer PING." };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function localScreenshotTest(): Promise<{
  success: boolean;
  error?: string;
}> {
  const activeTab =
    await getActiveTab();

  if (
    !activeTab ||
    typeof activeTab.id !==
      "number"
  ) {
    return {
      success: false,
      error:
        "No active browser tab found",
    };
  }

  const requestId =
    crypto.randomUUID();

  const sent =
    await sendRawScreenshotToSrijan(
      requestId,
      activeTab.id,
      0,
      null
    );

  return sent
    ? { success: true }
    : {
        success: false,
        error:
          "Failed to send screenshot",
      };
}



async function demoAction(): Promise<{
  success: boolean;
  error?: string;
}> {
  const activeTab =
    await getActiveTab();

  if (
    !activeTab ||
    typeof activeTab.id !==
      "number"
  ) {
    return {
      success: false,
      error:
        "No active browser tab found",
    };
  }

  const requestId =
    crypto.randomUUID();

  const actionId =
    crypto.randomUUID();

  const action:
    ActionPayload = {
    action:
      "navigate",
    url:
      "https://www.google.com",
    step_index: 0,
    is_last_step: true,
  };

  const message:
    AgentActionMessage = {
    type:
      "AGENT_ACTION",
    request_id:
      requestId,
    action_id:
      actionId,
    tab_id:
      activeTab.id,
    step_index: 0,
    action,
    is_last_step: true,
  };

  await executeAgentAction(
    message
  );

  return {
    success: true,
  };
}


chrome.runtime.onMessage.addListener(
  (
    message,
    _sender,
    sendResponse
  ) => {
    if (
      !message ||
      typeof message !==
        "object"
    ) {
      return;
    }

    if (message.type === "GET_SRIJAN_CONFIG") {
      void getSrijanWsUrl().then((url) => {
        srijanConnectionUrl = url;
        if (!url) srijanConnectionStatus = "not_configured";
        sendResponse({ success: true, url, status: srijanConnectionStatus });
      });
      return true;
    }

    if (message.type === "SET_SRIJAN_CONFIG") {
      void (async () => {
        const url = typeof message.url === "string" ? message.url.trim() : "";
        if (url) {
          let parsed: URL;
          try { parsed = new URL(url); } catch { return { success: false, error: "Invalid WebSocket URL." }; }
          if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
            return { success: false, error: "Srijan URL must start with wss:// or ws://." };
          }
          if (!parsed.pathname.endsWith("/ws")) {
            return { success: false, error: "Srijan URL must end with /ws." };
          }
        }
        await chrome.storage.local.set({ [SRIJAN_WS_URL_STORAGE_KEY]: url });
        srijanConnectionUrl = url;
        srijanConnectionStatus = url ? "connecting" : "not_configured";
        log("SRIJAN_CONFIG_SAVED", { url: url || "<not configured>" });

        if (offscreenPort) {
          try {
            offscreenPort.postMessage({ type: "WS_SET_URL", data: url });
          } catch (error) {
            log("Failed to update Srijan URL in offscreen bridge:", error);
          }
        }

        return { success: true, url, status: srijanConnectionStatus };
      })().then(sendResponse).catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.type === "RECONNECT_SRIJAN") {
      if (!offscreenPort) {
        sendResponse({ success: false, error: "Srijan offscreen bridge is not connected yet." });
        return true;
      }
      try {
        offscreenPort.postMessage({ type: "WS_RECONNECT" });
        srijanConnectionStatus = srijanConnectionUrl ? "connecting" : "not_configured";
        sendResponse({ success: true, status: srijanConnectionStatus });
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    if (message.type === "DEBUG_LOCAL_SERVER_HEALTH") {
      void checkLocalServerHealth().then(sendResponse);
      return true;
    }

    if (message.type === "DEBUG_INITIAL_CONTEXT") {
      const prompt = typeof message.prompt === "string" ? message.prompt : "Debug initial context";
      void debugInitialContext(prompt).then(sendResponse).catch((error) => {
        sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
      });
      return true;
    }

    if (message.type === "DEBUG_NATIVE_HOST_PING") {
      void debugNativeHostPing().then(sendResponse);
      return true;
    }

    if (message.type === "DEBUG_CONTENT_PING") {
      void debugContentPing().then(sendResponse);
      return true;
    }

    if (
      message.type ===
      "START_AGENT"
    ) {
      const prompt =
        typeof message.prompt ===
        "string"
          ? message.prompt
          : "";

      void startAgent(
        prompt
      )
        .then(sendResponse)
        .catch(
          (error) => {
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        );

      return true;
    }

    if (
      message.type ===
      "GET_CHAT_MESSAGES"
    ) {
      void getChatMessages()
        .then(
          (messages) => {
            sendResponse({
              success: true,
              messages,
            });
          }
        )
        .catch(
          (error) => {
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        );

      return true;
    }

    if (
      message.type ===
      "CLEAR_CHAT"
    ) {
      void saveChatMessages(
        []
      )
        .then(() => {
          sendResponse({
            success: true,
          });
        })
        .catch(
          (error) => {
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        );

      return true;
    }

    if (
      message.type ===
      "LOCAL_SCREENSHOT_TEST"
    ) {
      void localScreenshotTest()
        .then(sendResponse)
        .catch(
          (error) => {
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        );

      return true;
    }

    if (
      message.type ===
      "DEMO_ACTION"
    ) {
      void demoAction()
        .then(sendResponse)
        .catch(
          (error) => {
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        );

      return true;
    }

    if (
      message.type ===
      "LOCAL_CONTENT_ACTION"
    ) {
      void (async () => {
        const activeTab =
          await getActiveTab();

        if (
          !activeTab ||
          typeof activeTab.id !==
            "number"
        ) {
          return {
            success: false,
            error:
              "No active browser tab found",
          };
        }

        const action =
          message.action as ActionPayload;

        if (
          !validateAction(
            action
          )
        ) {
          return {
            success: false,
            error:
              "Invalid action",
          };
        }

        await waitForTabReady(
          activeTab.id
        );

        await ensureContentScript(
          activeTab.id
        );

        return executeContentAction(
          action,
          activeTab.id
        );
      })()
        .then(sendResponse)
        .catch(
          (error) => {
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        );

      return true;
    }
  }
);


registerOffscreenListener();
void setupOffscreenBridge();
startLocalServerHost();
chrome.runtime.onStartup.addListener(startLocalServerHost);
chrome.runtime.onInstalled.addListener(startLocalServerHost);

log(
  "Background service worker started"
);