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
  SrijanMessage,
  UserPromptMessage,
} from "./types.js";



const SRIJAN_WS_URL =
  "ws://127.0.0.1:8001/ws";



// const VARUN_WS_URL = "YOUR_EXISTING_VARUN_WS_URL";
// let varunSocket: WebSocket | null = null;



let offscreenPort:
  chrome.runtime.Port | null = null;

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



function sendToSrijan(
  message: unknown
): boolean {
  if (
    !offscreenPort
  ) {
    log(
      "Srijan WebSocket bridge is not connected"
    );

    return false;
  }

  try {
    offscreenPort.postMessage({
      type: "WS_SEND",
      data: JSON.stringify(message),
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
            log(
              "Srijan WebSocket status:",
              (msg as { status?: unknown })
                .status
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


/*
async function sendRawScreenshotToVarun(
  message: RawScreenshotMessage
): Promise<boolean> {
  if (
    !varunSocket ||
    varunSocket.readyState !== WebSocket.OPEN
  ) {
    return false;
  }

  varunSocket.send(
    JSON.stringify(message)
  );

  return true;
}
*/



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

async function sendRawScreenshotToSrijan(
  requestId: string,
  tabId: number,
  stepIndex: number,
  actionResult:
    ActionResult | null
): Promise<boolean> {
  try {
    const image =
      await captureScreenshot(
        tabId
      );

    const devicePixelRatio =
      await getDevicePixelRatio(
        tabId
      );

    const message:
      RawScreenshotMessage = {
      type: "RAW_SCREENSHOT",
      request_id:
        requestId,
      tab_id: tabId,
      step_index:
        stepIndex,
      image,
      action_result:
        actionResult,
      device_pixel_ratio:
        devicePixelRatio,
    };

   
    return sendToSrijan(
      message
    );

    
  } catch (error) {
    sendErrorToSrijan(
      requestId,
      error instanceof Error
        ? error.message
        : String(error)
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
      await sendRawScreenshotToSrijan(
        message.request_id,
        tabId,
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


  await addChatMessage(
    createChatMessage(
      "user",
      {
        type:
          "USER_PROMPT",
        text:
          cleanPrompt,
      }
    )
  );

  
  const promptSent =
    sendUserPromptToSrijan(
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

  const screenshotSent =
    await sendRawScreenshotToSrijan(
      requestId,
      activeTab.id,
      0,
      null
    );

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

log(
  "Background service worker started"
);