import { validateAction } from "./actions/validator.js";
import { executeContentAction } from "./actions/executor.js";
/*
 * ============================================================
 * EXISTING SERVER CONNECTIONS
 * ============================================================
 */
const SRIJAN_WS_URL = "ws://10.67.21.46:8001/ws";
const VARUN_WS_URL = "ws://127.0.0.1:8000/ws";
/*
 * ============================================================
 * WEBSOCKETS
 * ============================================================
 */
let srijanSocket = null;
let varunSocket = null;
let srijanReconnectTimer = null;
let varunReconnectTimer = null;
let srijanReconnecting = false;
let varunReconnecting = false;
/*
 * ============================================================
 * CHAT STORAGE
 * ============================================================
 */
const CHAT_STORAGE_KEY = "projectVisionChatMessages";
const MAX_CHAT_MESSAGES = 100;
async function getChatMessages() {
    const stored = await chrome.storage.local.get(CHAT_STORAGE_KEY);
    const messages = stored[CHAT_STORAGE_KEY];
    if (!Array.isArray(messages)) {
        return [];
    }
    return messages;
}
async function saveChatMessages(messages) {
    const trimmed = messages.slice(-MAX_CHAT_MESSAGES);
    await chrome.storage.local.set({
        [CHAT_STORAGE_KEY]: trimmed,
    });
}
async function addChatMessage(message) {
    const messages = await getChatMessages();
    messages.push(message);
    await saveChatMessages(messages);
    try {
        await chrome.runtime.sendMessage({
            type: "CHAT_MESSAGE",
            message,
        });
    }
    catch {
        // Popup may not be open.
    }
}
function createChatMessage(sender, options) {
    return {
        id: crypto.randomUUID(),
        sender,
        timestamp: Date.now(),
        ...options,
    };
}
/*
 * ============================================================
 * LOGGING
 * ============================================================
 */
function log(...args) {
    console.log("[Project-Vision]", ...args);
}
/*
 * ============================================================
 * SRIJAN SOCKET
 * ============================================================
 */
function sendToSrijan(message) {
    if (!srijanSocket ||
        srijanSocket.readyState !==
            WebSocket.OPEN) {
        log("Srijan WebSocket is not connected");
        return false;
    }
    try {
        srijanSocket.send(JSON.stringify(message));
        return true;
    }
    catch (error) {
        log("Failed to send message to Srijan:", error);
        return false;
    }
}
function connectToSrijan() {
    if (srijanSocket &&
        (srijanSocket.readyState ===
            WebSocket.OPEN ||
            srijanSocket.readyState ===
                WebSocket.CONNECTING)) {
        return;
    }
    if (srijanReconnecting) {
        return;
    }
    srijanReconnecting = true;
    log("Connecting to Srijan:", SRIJAN_WS_URL);
    try {
        const socket = new WebSocket(SRIJAN_WS_URL);
        srijanSocket =
            socket;
        socket.onopen = () => {
            srijanReconnecting = false;
            log("Connected to Srijan");
            void addChatMessage(createChatMessage("system", {
                text: "Connected to Srijan.",
                type: "CONNECTION_STATUS",
            }));
        };
        socket.onmessage = (event) => {
            void handleSrijanMessage(event.data);
        };
        socket.onerror = (event) => {
            log("Srijan WebSocket error:", event);
        };
        socket.onclose = () => {
            srijanReconnecting = false;
            if (srijanSocket === socket) {
                srijanSocket = null;
            }
            log("Srijan WebSocket closed");
            void addChatMessage(createChatMessage("system", {
                text: "Disconnected from Srijan. Reconnecting...",
                type: "CONNECTION_STATUS",
            }));
            scheduleSrijanReconnect();
        };
    }
    catch (error) {
        srijanReconnecting = false;
        log("Failed to connect to Srijan:", error);
        scheduleSrijanReconnect();
    }
}
function scheduleSrijanReconnect() {
    if (srijanReconnectTimer !== null) {
        return;
    }
    srijanReconnectTimer =
        setTimeout(() => {
            srijanReconnectTimer = null;
            connectToSrijan();
        }, 3000);
}
/*
 * ============================================================
 * VARUN SOCKET
 * ============================================================
 *
 * IMPORTANT:
 * RAW_SCREENSHOT goes ONLY to Varun.
 * REDACTED_SCREENSHOT comes back from Varun
 * and is then forwarded to Srijan.
 */
function sendToVarun(message) {
    if (!varunSocket ||
        varunSocket.readyState !==
            WebSocket.OPEN) {
        log("Varun WebSocket is not connected");
        return false;
    }
    try {
        varunSocket.send(JSON.stringify(message));
        return true;
    }
    catch (error) {
        log("Failed to send message to Varun:", error);
        return false;
    }
}
function connectToVarun() {
    if (varunSocket &&
        (varunSocket.readyState ===
            WebSocket.OPEN ||
            varunSocket.readyState ===
                WebSocket.CONNECTING)) {
        return;
    }
    if (varunReconnecting) {
        return;
    }
    varunReconnecting = true;
    log("Connecting to Varun:", VARUN_WS_URL);
    try {
        const socket = new WebSocket(VARUN_WS_URL);
        varunSocket =
            socket;
        socket.onopen = () => {
            varunReconnecting = false;
            log("Connected to Varun");
            void addChatMessage(createChatMessage("system", {
                text: "Connected to Varun.",
                type: "CONNECTION_STATUS",
            }));
        };
        socket.onmessage = (event) => {
            void handleVarunMessage(event.data);
        };
        socket.onerror = (event) => {
            log("Varun WebSocket error:", event);
        };
        socket.onclose = () => {
            varunReconnecting = false;
            if (varunSocket === socket) {
                varunSocket = null;
            }
            log("Varun WebSocket closed");
            void addChatMessage(createChatMessage("system", {
                text: "Disconnected from Varun. Reconnecting...",
                type: "CONNECTION_STATUS",
            }));
            scheduleVarunReconnect();
        };
    }
    catch (error) {
        varunReconnecting = false;
        log("Failed to connect to Varun:", error);
        scheduleVarunReconnect();
    }
}
function scheduleVarunReconnect() {
    if (varunReconnectTimer !== null) {
        return;
    }
    varunReconnectTimer =
        setTimeout(() => {
            varunReconnectTimer = null;
            connectToVarun();
        }, 3000);
}
/*
 * ============================================================
 * TAB HELPERS
 * ============================================================
 */
async function getActiveTab() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tabs[0] ?? null;
}
async function waitForTabReady(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
        return;
    }
    await new Promise((resolve) => {
        const listener = (changedTabId, changeInfo) => {
            if (changedTabId === tabId &&
                changeInfo.status ===
                    "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}
async function ensureContentScript(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, {
            type: "PING",
        });
        if (response &&
            response.success === true) {
            return;
        }
    }
    catch {
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
/*
 * ============================================================
 * SCREENSHOT
 * ============================================================
 */
async function captureScreenshot(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? "";
    if (url.startsWith("chrome://") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("edge://")) {
        throw new Error("Cannot capture screenshots on this browser page.");
    }
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab({
            format: "jpeg",
            quality: 90,
        }, (dataUrl) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }
            if (!dataUrl) {
                reject(new Error("Screenshot capture returned no data."));
                return;
            }
            const prefix = "data:image/jpeg;base64,";
            const image = dataUrl.startsWith(prefix)
                ? dataUrl.slice(prefix.length)
                : dataUrl;
            resolve(image);
        });
    });
}
/*
 * ============================================================
 * SCREENSHOT -> VARUN
 * ============================================================
 */
async function sendRawScreenshotToVarun(requestId, tabId, stepIndex, actionResult) {
    try {
        const image = await captureScreenshot(tabId);
        const message = {
            type: "RAW_SCREENSHOT",
            request_id: requestId,
            tab_id: tabId,
            step_index: stepIndex,
            image,
            action_result: actionResult,
        };
        /*
         * IMPORTANT:
         *
         * This is the ONLY place the raw screenshot
         * leaves the extension.
         *
         * It goes to Varun, NOT Srijan.
         */
        const sent = sendToVarun(message);
        if (!sent) {
            sendErrorToSrijan(requestId, "Varun server is not connected");
        }
        return sent;
    }
    catch (error) {
        sendErrorToSrijan(requestId, error instanceof Error
            ? error.message
            : String(error));
        return false;
    }
}
/*
 * ============================================================
 * VARUN -> SRIJAN
 * ============================================================
 */
async function handleVarunMessage(rawData) {
    try {
        let parsed;
        if (typeof rawData === "string") {
            parsed =
                JSON.parse(rawData);
        }
        else {
            parsed =
                rawData;
        }
        const packet = parsed;
        /*
         * Varun successfully redacted the screenshot.
         *
         * ONLY NOW does the screenshot get forwarded
         * to Srijan.
         */
        if (packet?.type ===
            "REDACTED_SCREENSHOT") {
            const redacted = parsed;
            await addChatMessage(createChatMessage("system", {
                type: "REDACTED_SCREENSHOT",
                text: "Varun returned a redacted screenshot.",
                image: redacted.image,
                raw: parsed,
            }));
            const sent = sendToSrijan(redacted);
            if (!sent) {
                log("Could not forward redacted screenshot to Srijan.");
            }
            return;
        }
        /*
         * Varun error.
         */
        if (packet?.type ===
            "ERROR") {
            await addChatMessage(createChatMessage("system", {
                type: "ERROR",
                raw: parsed,
                text: typeof packet.error ===
                    "string"
                    ? packet.error
                    : "Varun server error",
            }));
            /*
             * Preserve existing ERROR structure
             * when forwarding to Srijan.
             */
            sendToSrijan({
                type: "ERROR",
                ...(typeof packet.request_id ===
                    "string"
                    ? {
                        request_id: packet.request_id,
                    }
                    : {}),
                error: typeof packet.error ===
                    "string"
                    ? packet.error
                    : "Varun server error",
            });
            return;
        }
        /*
         * Unknown Varun JSON.
         */
        await addChatMessage(createChatMessage("system", {
            type: typeof packet?.type ===
                "string"
                ? packet.type
                : "VARUN_JSON",
            raw: parsed,
            text: JSON.stringify(parsed, null, 2),
        }));
    }
    catch (error) {
        const errorText = error instanceof Error
            ? error.message
            : String(error);
        log("Failed to process Varun JSON:", error);
        await addChatMessage(createChatMessage("system", {
            type: "VARUN_JSON_PARSE_ERROR",
            text: `Failed to process Varun JSON: ${errorText}`,
        }));
        sendErrorToSrijan(undefined, errorText);
    }
}
/*
 * ============================================================
 * SRIJAN MESSAGES
 * ============================================================
 */
function sendActionResultToSrijan(requestId, actionId, result) {
    const message = {
        type: "ACTION_RESULT",
        request_id: requestId,
        action_id: actionId,
        result,
    };
    return sendToSrijan(message);
}
function sendErrorToSrijan(requestId, error) {
    const message = {
        type: "ERROR",
        ...(requestId
            ? {
                request_id: requestId,
            }
            : {}),
        error,
    };
    return sendToSrijan(message);
}
function sendUserPromptToSrijan(requestId, prompt) {
    const message = {
        type: "USER_PROMPT",
        request_id: requestId,
        prompt,
    };
    return sendToSrijan(message);
}
async function handleSrijanMessage(rawData) {
    try {
        let parsed;
        if (typeof rawData === "string") {
            parsed =
                JSON.parse(rawData);
        }
        else {
            parsed =
                rawData;
        }
        const packet = parsed;
        /*
         * Srijan tells extension what action to execute.
         */
        if (packet?.type ===
            "AGENT_ACTION") {
            await addChatMessage(createChatMessage("server", {
                type: "AGENT_ACTION",
                raw: parsed,
                text: `Agent action: ${String(packet.action?.action ??
                    "unknown")}`,
            }));
            await executeAgentAction(parsed);
            return;
        }
        /*
         * Srijan ERROR.
         */
        if (packet?.type ===
            "ERROR") {
            await addChatMessage(createChatMessage("server", {
                type: "ERROR",
                raw: parsed,
                text: typeof packet.error ===
                    "string"
                    ? packet.error
                    : "Server error",
            }));
            return;
        }
        /*
         * Display any other JSON received
         * from Srijan in the UI.
         */
        await addChatMessage(createChatMessage("server", {
            type: typeof packet?.type ===
                "string"
                ? packet.type
                : "JSON",
            raw: parsed,
            text: JSON.stringify(parsed, null, 2),
        }));
    }
    catch (error) {
        const errorText = error instanceof Error
            ? error.message
            : String(error);
        log("Failed to process Srijan JSON:", error);
        await addChatMessage(createChatMessage("system", {
            type: "JSON_PARSE_ERROR",
            text: `Failed to process server JSON: ${errorText}`,
        }));
        sendErrorToSrijan(undefined, errorText);
    }
}
/*
 * ============================================================
 * BACKGROUND BROWSER ACTIONS
 * ============================================================
 */
async function executeBackgroundAction(action, tabId) {
    try {
        switch (action.action) {
            case "open_tab": {
                if (!action.url) {
                    return {
                        success: false,
                        action: action.action,
                        step_index: action.step_index,
                        tab_id: tabId,
                        error: "URL is required",
                    };
                }
                const newTab = await chrome.tabs.create({
                    url: action.url,
                });
                return {
                    success: true,
                    action: action.action,
                    step_index: action.step_index,
                    tab_id: newTab.id,
                };
            }
            case "navigate": {
                if (!action.url) {
                    return {
                        success: false,
                        action: action.action,
                        step_index: action.step_index,
                        tab_id: tabId,
                        error: "URL is required",
                    };
                }
                await chrome.tabs.update(tabId, {
                    url: action.url,
                });
                return {
                    success: true,
                    action: action.action,
                    step_index: action.step_index,
                    tab_id: tabId,
                };
            }
            case "search": {
                if (!action.query) {
                    return {
                        success: false,
                        action: action.action,
                        step_index: action.step_index,
                        tab_id: tabId,
                        error: "Search query is required",
                    };
                }
                const url = "https://duckduckgo.com/?q=" +
                    encodeURIComponent(action.query);
                await chrome.tabs.update(tabId, {
                    url,
                });
                return {
                    success: true,
                    action: action.action,
                    step_index: action.step_index,
                    tab_id: tabId,
                };
            }
            case "close_tab": {
                await chrome.tabs.remove(tabId);
                return {
                    success: true,
                    action: action.action,
                    step_index: action.step_index,
                    tab_id: tabId,
                };
            }
            case "switch_tab": {
                if (typeof action.tab_id !==
                    "number") {
                    return {
                        success: false,
                        action: action.action,
                        step_index: action.step_index,
                        tab_id: tabId,
                        error: "tab_id is required",
                    };
                }
                await chrome.tabs.update(action.tab_id, {
                    active: true,
                });
                return {
                    success: true,
                    action: action.action,
                    step_index: action.step_index,
                    tab_id: action.tab_id,
                };
            }
            default:
                return {
                    success: false,
                    action: action.action,
                    step_index: action.step_index,
                    tab_id: tabId,
                    error: "Unsupported background action",
                };
        }
    }
    catch (error) {
        return {
            success: false,
            action: action.action,
            step_index: action.step_index,
            tab_id: tabId,
            error: error instanceof Error
                ? error.message
                : String(error),
        };
    }
}
/*
 * ============================================================
 * EXECUTE AGENT ACTION
 * ============================================================
 */
async function executeAgentAction(message) {
    const action = message.action;
    if (!validateAction(action)) {
        sendErrorToSrijan(message.request_id, "Invalid AGENT_ACTION payload");
        return;
    }
    let tabId = message.tab_id ??
        action.tab_id;
    if (typeof tabId !== "number") {
        const activeTab = await getActiveTab();
        if (!activeTab ||
            typeof activeTab.id !==
                "number") {
            sendErrorToSrijan(message.request_id, "No active browser tab found");
            return;
        }
        tabId =
            activeTab.id;
    }
    try {
        await waitForTabReady(tabId);
    }
    catch (error) {
        sendErrorToSrijan(message.request_id, error instanceof Error
            ? error.message
            : String(error));
        return;
    }
    let result;
    const backgroundActions = new Set([
        "open_tab",
        "navigate",
        "search",
        "close_tab",
        "switch_tab",
    ]);
    if (backgroundActions.has(action.action)) {
        result =
            await executeBackgroundAction(action, tabId);
    }
    else {
        try {
            await ensureContentScript(tabId);
            result =
                await executeContentAction(action, tabId);
        }
        catch (error) {
            result = {
                success: false,
                action: action.action,
                step_index: action.step_index,
                tab_id: tabId,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            };
        }
    }
    /*
     * Existing ACTION_RESULT -> Srijan.
     */
    sendActionResultToSrijan(message.request_id, message.action_id, result);
    /*
     * IMPORTANT:
     *
     * Screenshot is now sent to Varun,
     * NOT directly to Srijan.
     */
    if (result.success &&
        !message.is_last_step) {
        await sendRawScreenshotToVarun(message.request_id, tabId, action.step_index, result);
    }
}
/*
 * ============================================================
 * START AGENT
 * ============================================================
 */
async function startAgent(prompt) {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
        return {
            success: false,
            error: "Prompt cannot be empty",
        };
    }
    const requestId = crypto.randomUUID();
    await addChatMessage(createChatMessage("user", {
        type: "USER_PROMPT",
        text: cleanPrompt,
    }));
    /*
     * Existing/new prompt packet to Srijan.
     */
    const promptSent = sendUserPromptToSrijan(requestId, cleanPrompt);
    if (!promptSent) {
        await addChatMessage(createChatMessage("system", {
            text: "Could not send prompt: Srijan server is not connected.",
            type: "CONNECTION_ERROR",
        }));
        return {
            success: false,
            error: "Srijan server is not connected",
        };
    }
    const activeTab = await getActiveTab();
    if (!activeTab ||
        typeof activeTab.id !==
            "number") {
        return {
            success: false,
            error: "No active browser tab found",
        };
    }
    /*
     * Initial screenshot also goes to Varun.
     */
    const screenshotSent = await sendRawScreenshotToVarun(requestId, activeTab.id, 0, null);
    if (!screenshotSent) {
        await addChatMessage(createChatMessage("system", {
            text: "Prompt was sent, but the initial screenshot could not be sent to Varun.",
            type: "SCREENSHOT_ERROR",
        }));
        return {
            success: false,
            error: "Prompt was sent, but initial screenshot could not be sent to Varun",
        };
    }
    return {
        success: true,
    };
}
/*
 * ============================================================
 * LOCAL SCREENSHOT TEST
 * ============================================================
 */
async function localScreenshotTest() {
    const activeTab = await getActiveTab();
    if (!activeTab ||
        typeof activeTab.id !==
            "number") {
        return {
            success: false,
            error: "No active browser tab found",
        };
    }
    const requestId = crypto.randomUUID();
    const sent = await sendRawScreenshotToVarun(requestId, activeTab.id, 0, null);
    return sent
        ? {
            success: true,
        }
        : {
            success: false,
            error: "Failed to send screenshot to Varun",
        };
}
/*
 * ============================================================
 * DEMO ACTION
 * ============================================================
 */
async function demoAction() {
    const activeTab = await getActiveTab();
    if (!activeTab ||
        typeof activeTab.id !==
            "number") {
        return {
            success: false,
            error: "No active browser tab found",
        };
    }
    const requestId = crypto.randomUUID();
    const actionId = crypto.randomUUID();
    const action = {
        action: "navigate",
        url: "https://www.google.com",
        step_index: 0,
        is_last_step: true,
    };
    const message = {
        type: "AGENT_ACTION",
        request_id: requestId,
        action_id: actionId,
        tab_id: activeTab.id,
        step_index: 0,
        action,
        is_last_step: true,
    };
    await executeAgentAction(message);
    return {
        success: true,
    };
}
/*
 * ============================================================
 * RUNTIME MESSAGES
 * ============================================================
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message ||
        typeof message !==
            "object") {
        return;
    }
    if (message.type ===
        "START_AGENT") {
        const prompt = typeof message.prompt ===
            "string"
            ? message.prompt
            : "";
        void startAgent(prompt)
            .then(sendResponse)
            .catch((error) => {
            sendResponse({
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            });
        });
        return true;
    }
    if (message.type ===
        "GET_CHAT_MESSAGES") {
        void getChatMessages()
            .then((messages) => {
            sendResponse({
                success: true,
                messages,
            });
        })
            .catch((error) => {
            sendResponse({
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            });
        });
        return true;
    }
    if (message.type ===
        "CLEAR_CHAT") {
        void saveChatMessages([])
            .then(() => {
            sendResponse({
                success: true,
            });
        })
            .catch((error) => {
            sendResponse({
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            });
        });
        return true;
    }
    if (message.type ===
        "LOCAL_SCREENSHOT_TEST") {
        void localScreenshotTest()
            .then(sendResponse)
            .catch((error) => {
            sendResponse({
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            });
        });
        return true;
    }
    if (message.type ===
        "DEMO_ACTION") {
        void demoAction()
            .then(sendResponse)
            .catch((error) => {
            sendResponse({
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            });
        });
        return true;
    }
    if (message.type ===
        "LOCAL_CONTENT_ACTION") {
        void (async () => {
            const activeTab = await getActiveTab();
            if (!activeTab ||
                typeof activeTab.id !==
                    "number") {
                return {
                    success: false,
                    error: "No active browser tab found",
                };
            }
            const action = message.action;
            if (!validateAction(action)) {
                return {
                    success: false,
                    error: "Invalid action",
                };
            }
            await waitForTabReady(activeTab.id);
            await ensureContentScript(activeTab.id);
            return executeContentAction(action, activeTab.id);
        })()
            .then(sendResponse)
            .catch((error) => {
            sendResponse({
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            });
        });
        return true;
    }
});
/*
 * ============================================================
 * STARTUP
 * ============================================================
 */
connectToSrijan();
connectToVarun();
log("Background service worker started");
