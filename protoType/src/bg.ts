import type {
  AgentActionMessage,
  ActionPayload,
  ActionResult,
  ActionResultMessage,
  RawScreenshotMessage,
  RedactedScreenshotMessage,
  SrijanMessage,
  VarunMessage
} from "./actions/types";

import { validateAction } from "./actions/validator.js";
import { executeContentAction } from "./actions/executor.js";

const SRIJAN_WS_URL =
  "ws://127.0.0.1:8001/ws";

const VARUN_WS_URL =
  "ws://127.0.0.1:8000/ws";

let srijanSocket:
  WebSocket | null = null;

let varunSocket:
  WebSocket | null = null;

let srijanReconnectTimer:
  ReturnType<typeof setTimeout> | null =
    null;

let varunReconnectTimer:
  ReturnType<typeof setTimeout> | null =
    null;

function createRequestId(): string {
  return crypto.randomUUID();
}

function connectSrijan(): void {
  if (
    srijanSocket &&
    (
      srijanSocket.readyState ===
        WebSocket.OPEN ||
      srijanSocket.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    return;
  }

  console.log(
    "[Project-Vision] Connecting to Srijan"
  );

  srijanSocket =
    new WebSocket(
      SRIJAN_WS_URL
    );

  srijanSocket.onopen = () => {
    console.log(
      "[Project-Vision] Connected to Srijan"
    );

    if (
      srijanReconnectTimer
    ) {
      clearTimeout(
        srijanReconnectTimer
      );

      srijanReconnectTimer =
        null;
    }
  };

  srijanSocket.onmessage = (
    event
  ) => {
    handleSrijanMessage(
      event.data
    );
  };

  srijanSocket.onerror = (
    error
  ) => {
    console.error(
      "[Project-Vision] Srijan WebSocket error",
      error
    );
  };

  srijanSocket.onclose = () => {
    console.log(
      "[Project-Vision] Srijan disconnected"
    );

    srijanSocket = null;

    scheduleSrijanReconnect();
  };
}

function connectVarun(): void {
  if (
    varunSocket &&
    (
      varunSocket.readyState ===
        WebSocket.OPEN ||
      varunSocket.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    return;
  }

  console.log(
    "[Project-Vision] Connecting to Varun"
  );

  varunSocket =
    new WebSocket(
      VARUN_WS_URL
    );

  varunSocket.onopen = () => {
    console.log(
      "[Project-Vision] Connected to Varun"
    );

    if (
      varunReconnectTimer
    ) {
      clearTimeout(
        varunReconnectTimer
      );

      varunReconnectTimer =
        null;
    }
  };

  varunSocket.onmessage = (
    event
  ) => {
    handleVarunMessage(
      event.data
    );
  };

  varunSocket.onerror = (
    error
  ) => {
    console.error(
      "[Project-Vision] Varun WebSocket error",
      error
    );
  };

  varunSocket.onclose = () => {
    console.log(
      "[Project-Vision] Varun disconnected"
    );

    varunSocket = null;

    scheduleVarunReconnect();
  };
}

function scheduleSrijanReconnect(): void {
  if (
    srijanReconnectTimer
  ) {
    return;
  }

  srijanReconnectTimer =
    setTimeout(() => {
      srijanReconnectTimer =
        null;

      connectSrijan();
    }, 3000);
}

function scheduleVarunReconnect(): void {
  if (
    varunReconnectTimer
  ) {
    return;
  }

  varunReconnectTimer =
    setTimeout(() => {
      varunReconnectTimer =
        null;

      connectVarun();
    }, 3000);
}

function sendToSrijan(
  message: unknown
): void {
  if (
    !srijanSocket ||
    srijanSocket.readyState !==
      WebSocket.OPEN
  ) {
    console.error(
      "[Project-Vision] Srijan connection unavailable"
    );

    return;
  }

  srijanSocket.send(
    JSON.stringify(message)
  );
}

function sendToVarun(
  message: unknown
): void {
  if (
    !varunSocket ||
    varunSocket.readyState !==
      WebSocket.OPEN
  ) {
    console.error(
      "[Project-Vision] Varun connection unavailable"
    );

    return;
  }

  varunSocket.send(
    JSON.stringify(message)
  );
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs =
    await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

  if (
    !tabs[0] ||
    typeof tabs[0].id !==
      "number"
  ) {
    throw new Error(
      "No active tab"
    );
  }

  return tabs[0];
}

async function waitForTabReady(
  tabId: number,
  timeoutMs = 10000
): Promise<void> {
  const start =
    Date.now();

  while (
    Date.now() - start <
    timeoutMs
  ) {
    try {
      const tab =
        await chrome.tabs.get(
          tabId
        );

      if (
        tab.status ===
        "complete"
      ) {
        return;
      }
    } catch {
      throw new Error(
        "Tab no longer exists"
      );
    }

    await new Promise<void>(
      (resolve) => {
        setTimeout(
          resolve,
          100
        );
      }
    );
  }

  throw new Error(
    "Timed out waiting for tab"
  );
}

async function ensureContentScript(
  tabId: number
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      {
        type: "PING"
      }
    );

    return;
  } catch {
  }

  await chrome.scripting.executeScript({
    target: {
      tabId
    },
    files: [
      "dist/cs.js"
    ]
  });

  await new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        100
      );
    }
  );

  await chrome.tabs.sendMessage(
    tabId,
    {
      type: "PING"
    }
  );
}

async function captureScreenshotBase64(
  tabId: number
): Promise<string> {
  await chrome.tabs.update(
    tabId,
    {
      active: true
    }
  );

  await new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        200
      );
    }
  );

  const dataUrl =
    await chrome.tabs.captureVisibleTab({
      format: "jpeg",
      quality: 90
    });

  const commaIndex =
    dataUrl.indexOf(",");

  if (
    commaIndex === -1
  ) {
    throw new Error(
      "Invalid screenshot data"
    );
  }

  return dataUrl.slice(
    commaIndex + 1
  );
}

async function sendRawScreenshotToVarun(
  requestId: string,
  tabId: number,
  stepIndex: number,
  actionResult:
    ActionResult | null
): Promise<void> {
  const image =
    await captureScreenshotBase64(
      tabId
    );

  const message:
    RawScreenshotMessage = {
    type: "RAW_SCREENSHOT",
    request_id:
      requestId,
    tab_id:
      tabId,
    step_index:
      stepIndex,
    image,
    action_result:
      actionResult
  };

  sendToVarun(
    message
  );
}

function sendActionResultToSrijan(
  requestId: string,
  actionId: string,
  result: ActionResult
): void {
  const message:
    ActionResultMessage = {
    type:
      "ACTION_RESULT",
    request_id:
      requestId,
    action_id:
      actionId,
    result
  };

  sendToSrijan(
    message
  );
}

async function resolveTabId(
  message: AgentActionMessage
): Promise<number> {
  if (
    typeof message.tab_id ===
    "number"
  ) {
    return message.tab_id;
  }

  if (
    typeof message.action.tab_id ===
    "number"
  ) {
    return message.action.tab_id;
  }

  const tab =
    await getActiveTab();

  if (
    typeof tab.id !==
    "number"
  ) {
    throw new Error(
      "Active tab has no id"
    );
  }

  return tab.id;
}

async function executeBackgroundAction(
  action: ActionPayload,
  tabId: number
): Promise<ActionResult> {
  try {
    switch (action.action) {
      case "open_tab": {
        if (!action.url) {
          throw new Error(
            "open_tab requires url"
          );
        }

        const tab =
          await chrome.tabs.create({
            url: action.url,
            active: true
          });

        if (
          typeof tab.id !==
          "number"
        ) {
          throw new Error(
            "Could not create tab"
          );
        }

        await waitForTabReady(
          tab.id
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            tab.id
        };
      }

      case "navigate": {
        if (!action.url) {
          throw new Error(
            "navigate requires url"
          );
        }

        await chrome.tabs.update(
          tabId,
          {
            url: action.url,
            active: true
          }
        );

        await waitForTabReady(
          tabId
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            tabId
        };
      }

      case "search": {
        if (!action.query) {
          throw new Error(
            "search requires query"
          );
        }

        const url =
          "https://duckduckgo.com/?q=" +
          encodeURIComponent(
            action.query
          );

        const tab =
          await chrome.tabs.create({
            url,
            active: true
          });

        if (
          typeof tab.id !==
          "number"
        ) {
          throw new Error(
            "Could not create search tab"
          );
        }

        await waitForTabReady(
          tab.id
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            tab.id
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
            tabId
        };
      }

      case "switch_tab": {
        if (
          typeof action.tab_id !==
          "number"
        ) {
          throw new Error(
            "switch_tab requires tab_id"
          );
        }

        await chrome.tabs.update(
          action.tab_id,
          {
            active: true
          }
        );

        return {
          success: true,
          action:
            action.action,
          step_index:
            action.step_index,
          tab_id:
            action.tab_id
        };
      }

      default:
        throw new Error(
          "Action is not a background action"
        );
    }
  } catch (error) {
    return {
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
          : String(error)
    };
  }
}

async function executeAgentAction(
  message: AgentActionMessage
): Promise<void> {
  if (
  !validateAction(
    message.action
  )
) {
  sendToSrijan({
    type: "ERROR",
    request_id:
      message.request_id,
    error:
      "Invalid action received from Srijan"
  });

  return;
}

  let tabId: number;

  try {
    tabId =
      await resolveTabId(
        message
      );
  } catch (error) {
    sendActionResultToSrijan(
      message.request_id,
      message.action_id,
      {
        success: false,
        action:
          message.action.action,
        step_index:
          message.step_index,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      }
    );

    return;
  }

  const backgroundActions = [
    "open_tab",
    "navigate",
    "search",
    "close_tab",
    "switch_tab"
  ];

  const isBackgroundAction =
    backgroundActions.includes(
      message.action.action
    );

  let result:
    ActionResult;

  if (
    isBackgroundAction
  ) {
    result =
      await executeBackgroundAction(
        message.action,
        tabId
      );

    if (
      result.success &&
      typeof result.tab_id ===
        "number"
    ) {
      tabId =
        result.tab_id;
    }
  } else {
    try {
      await waitForTabReady(
        tabId
      );

      await ensureContentScript(
        tabId
      );

      result =
        await executeContentAction(
          message.action,
          tabId
        );
    } catch (error) {
      result = {
        success: false,
        action:
          message.action.action,
        step_index:
          message.step_index,
        tab_id:
          tabId,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      };
    }
  }

  sendActionResultToSrijan(
    message.request_id,
    message.action_id,
    result
  );

  if (
    !result.success
  ) {
    return;
  }

  if (
    message.action.is_last_step
  ) {
    return;
  }

  if (
    message.action.action ===
    "close_tab"
  ) {
    const tabs =
      await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

    const nextTab =
      tabs[0];

    if (
      !nextTab ||
      typeof nextTab.id !==
        "number"
    ) {
      return;
    }

    tabId =
      nextTab.id;
  }

  try {
    await sendRawScreenshotToVarun(
      message.request_id,
      tabId,
      message.step_index + 1,
      result
    );
  } catch (error) {
    sendActionResultToSrijan(
      message.request_id,
      message.action_id,
      {
        ...result,
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      }
    );
  }
}

function handleSrijanMessage(
  rawData: unknown
): void {
  try {
    const message =
      JSON.parse(
        String(rawData)
      ) as SrijanMessage;

    if (
      message.type ===
      "AGENT_ACTION"
    ) {
      void executeAgentAction(
        message
      );

      return;
    }

    if (
      message.type ===
      "ERROR"
    ) {
      console.error(
        "[Project-Vision] Srijan error:",
        message.error
      );
    }
  } catch (error) {
    console.error(
      "[Project-Vision] Invalid Srijan message",
      error
    );
  }
}

function handleVarunMessage(
  rawData: unknown
): void {
  try {
    const message =
      JSON.parse(
        String(rawData)
      ) as VarunMessage;

    if (
      message.type ===
      "REDACTED_SCREENSHOT"
    ) {
      const outgoing:
        RedactedScreenshotMessage =
        {
          type:
            "REDACTED_SCREENSHOT",
          request_id:
            message.request_id,
          tab_id:
            message.tab_id,
          step_index:
            message.step_index,
          image:
            message.image,
          action_result:
            message.action_result
        };

      sendToSrijan(
        outgoing
      );

      return;
    }

    if (
      message.type ===
      "ERROR"
    ) {
      console.error(
        "[Project-Vision] Varun error:",
        message.error
      );
    }
  } catch (error) {
    console.error(
      "[Project-Vision] Invalid Varun message",
      error
    );
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender,
    sendResponse
  ) => {
    if (
      !message ||
      typeof message !==
        "object"
    ) {
      return false;
    }

    const msg =
      message as {
        type?: string;
        action?: ActionPayload;
      };

    if (
      msg.type ===
      "START_AGENT"
    ) {
      void (async () => {
        try {
          const tab =
            await getActiveTab();

          if (
            typeof tab.id !==
              "number"
          ) {
            throw new Error(
              "Active tab has no id"
            );
          }

          await waitForTabReady(
            tab.id
          );

          const requestId =
            createRequestId();

          await sendRawScreenshotToVarun(
            requestId,
            tab.id,
            0,
            null
          );

          sendResponse({
            success: true,
            request_id:
              requestId,
            tab_id:
              tab.id
          });
        } catch (error) {
          sendResponse({
            success: false,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          });
        }
      })();

      return true;
    }

    if (
      msg.type ===
        "DEMO_ACTION" &&
      msg.action
    ) {
      const requestId =
        createRequestId();

      const actionMessage:
        AgentActionMessage =
        {
          type:
            "AGENT_ACTION",
          request_id:
            requestId,
          action_id:
            "popup-demo",
          step_index:
            msg.action.step_index,
          action:
            msg.action,
          is_last_step:
            msg.action.is_last_step
        };

      void executeAgentAction(
        actionMessage
      );

      sendResponse({
        success: true,
        request_id:
          requestId
      });

      return true;
    }

    return false;
  }
);

connectSrijan();
connectVarun();