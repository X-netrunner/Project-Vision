"use strict";
console.log("[BG] Project Vision background worker active");
const BACKEND_WS_URL = "ws://127.0.0.1:8000/ws";
let backendSocket = null;
let backendConnecting = false;
function connectBackend() {
    if (backendSocket?.readyState ===
        WebSocket.OPEN) {
        return;
    }
    if (backendConnecting) {
        return;
    }
    backendConnecting = true;
    console.log("[BG] Connecting to backend:", BACKEND_WS_URL);
    try {
        const socket = new WebSocket(BACKEND_WS_URL);
        backendSocket =
            socket;
        socket.onopen = () => {
            backendConnecting =
                false;
            console.log("[BG] Backend connected");
        };
        socket.onmessage = (event) => {
            handleBackendMessage(event.data);
        };
        socket.onerror = (error) => {
            console.error("[BG] Backend WebSocket error:", error);
        };
        socket.onclose = () => {
            backendConnecting =
                false;
            backendSocket =
                null;
            console.log("[BG] Backend disconnected");
            setTimeout(connectBackend, 3000);
        };
    }
    catch (error) {
        backendConnecting =
            false;
        console.error("[BG] Backend connection failed:", error);
    }
}
function sendToBackend(message) {
    if (backendSocket?.readyState !==
        WebSocket.OPEN) {
        console.error("[BG] Backend is not connected");
        connectBackend();
        return false;
    }
    backendSocket.send(JSON.stringify(message));
    return true;
}
async function handleBackendMessage(rawMessage) {
    let message = null;
    try {
        if (typeof rawMessage !== "string") {
            console.error("[BG] Backend message is not text");
            return;
        }
        const parsed = JSON.parse(rawMessage);
        if (!parsed ||
            parsed.type !==
                "ACTION_COORDINATES") {
            console.log("[BG] Ignoring backend message:", parsed);
            return;
        }
        message =
            parsed;
        await handleAction(message);
    }
    catch (error) {
        console.error("[BG] Invalid backend message:", error);
        if (message) {
            const result = {
                type: "ACTION_RESULT",
                request_id: message.request_id,
                action_id: message.action_id,
                payload: {
                    success: false,
                    action: message.payload.action,
                    step_index: message.payload.step_index,
                    error: error instanceof Error
                        ? error.message
                        : String(error)
                }
            };
            sendToBackend(result);
        }
    }
}
async function ensureContentScript(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: "PING"
        });
        return;
    }
    catch {
    }
    await chrome.scripting.executeScript({
        target: {
            tabId
        },
        files: [
            "dist/cs.js"
        ]
    });
}
async function handleAction(message) {
    const action = message.payload.action;
    try {
        if (action === "open_tab") {
            await handleOpenTab(message);
            return;
        }
        if (action === "navigate") {
            await handleNavigate(message);
            return;
        }
        if (action === "search") {
            await handleSearch(message);
            return;
        }
        if (action === "close_tab") {
            await handleCloseTab(message);
            return;
        }
        if (action === "switch_tab") {
            await handleSwitchTab(message);
            return;
        }
        const tabId = await resolveTabId(message);
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, message);
    }
    catch (error) {
        const result = {
            type: "ACTION_RESULT",
            request_id: message.request_id,
            action_id: message.action_id,
            payload: {
                success: false,
                action: message.payload.action,
                step_index: message.payload.step_index,
                error: error instanceof Error
                    ? error.message
                    : String(error)
            }
        };
        sendToBackend(result);
    }
}
async function resolveTabId(message) {
    if (typeof message.tabId ===
        "number") {
        return message.tabId;
    }
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });
    const tab = tabs[0];
    if (!tab?.id) {
        throw new Error("No active tab found");
    }
    return tab.id;
}
async function handleOpenTab(message) {
    const url = message.payload.url;
    const tab = await chrome.tabs.create({
        url
    });
    const result = {
        type: "ACTION_RESULT",
        request_id: message.request_id,
        action_id: message.action_id,
        payload: {
            success: true,
            action: "open_tab",
            step_index: message.payload.step_index,
            tab_id: tab.id
        }
    };
    sendToBackend(result);
    chrome.runtime.sendMessage(result);
}
async function handleNavigate(message) {
    const tabId = await resolveTabId(message);
    await chrome.tabs.update(tabId, {
        url: message.payload.url
    });
    const result = {
        type: "ACTION_RESULT",
        request_id: message.request_id,
        action_id: message.action_id,
        payload: {
            success: true,
            action: "navigate",
            step_index: message.payload.step_index,
            tab_id: tabId
        }
    };
    sendToBackend(result);
    chrome.runtime.sendMessage(result);
}
async function handleSearch(message) {
    const query = message.payload.query;
    const url = "https://duckduckgo.com/?q=" +
        encodeURIComponent(query);
    const tab = await chrome.tabs.create({
        url
    });
    const result = {
        type: "ACTION_RESULT",
        request_id: message.request_id,
        action_id: message.action_id,
        payload: {
            success: true,
            action: "search",
            step_index: message.payload.step_index,
            tab_id: tab.id
        }
    };
    sendToBackend(result);
    chrome.runtime.sendMessage(result);
}
async function handleCloseTab(message) {
    const tabId = await resolveTabId(message);
    await chrome.tabs.remove(tabId);
    const result = {
        type: "ACTION_RESULT",
        request_id: message.request_id,
        action_id: message.action_id,
        payload: {
            success: true,
            action: "close_tab",
            step_index: message.payload.step_index,
            tab_id: tabId
        }
    };
    sendToBackend(result);
    chrome.runtime.sendMessage(result);
}
async function handleSwitchTab(message) {
    const tabId = message.payload.tab_id;
    await chrome.tabs.update(tabId, {
        active: true
    });
    const result = {
        type: "ACTION_RESULT",
        request_id: message.request_id,
        action_id: message.action_id,
        payload: {
            success: true,
            action: "switch_tab",
            step_index: message.payload.step_index,
            tab_id: tabId
        }
    };
    sendToBackend(result);
    chrome.runtime.sendMessage(result);
}
async function captureAndRedact(tabId) {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab({
            format: "jpeg",
            quality: 90
        });
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, {
            action: "PROCESS_IMAGE",
            imageUri: dataUrl
        });
    }
    catch (error) {
        console.error("[BG] Screenshot failed:", error);
    }
}
chrome.runtime.onMessage.addListener((message) => {
    if ("action" in message &&
        message.action ===
            "Start_Redact") {
        captureAndRedact(message.tabId);
        return;
    }
    if ("action" in message &&
        message.action ===
            "REDACTION_COMPLETE") {
        const requestId = `req-${Date.now()}`;
        const sendScreenshot = async () => {
            const tabs = await chrome.tabs.query({
                active: true,
                currentWindow: true
            });
            const tab = tabs[0];
            if (!tab?.id) {
                return;
            }
            const screenshot = {
                type: "SCREENSHOT",
                request_id: requestId,
                tab_id: tab.id,
                image: message.sanitizedUri
            };
            sendToBackend(screenshot);
            chrome.runtime.sendMessage({
                action: "SHOW_PREVIEW",
                sanitizedUri: message.sanitizedUri
            });
        };
        sendScreenshot();
        return;
    }
    if ("type" in message &&
        message.type ===
            "ACTION_COORDINATES") {
        handleAction(message);
        return;
    }
    if ("type" in message &&
        message.type ===
            "ACTION_RESULT") {
        sendToBackend(message);
        chrome.runtime.sendMessage(message);
        return;
    }
});
connectBackend();
