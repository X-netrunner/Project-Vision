const messagesElement = document.getElementById("messages");
const promptElement = document.getElementById("prompt");
const sendButton = document.getElementById("send");
const clearButton = document.getElementById("clear");
const statusElement = document.getElementById("status");
const screenshotButton = document.getElementById("screenshot");
const demoButton = document.getElementById("demo");
const debugToggle = document.getElementById("debug-toggle");
const debugPanel = document.getElementById("debug-panel");
const debugHealthButton = document.getElementById("debug-health");
const debugContextButton = document.getElementById("debug-context");
const debugPingButton = document.getElementById("debug-ping");
const debugActionButton = document.getElementById("debug-action");
const debugVerbose = document.getElementById("debug-verbose");
const srijanUrlElement = document.getElementById("srijan-url");
const srijanSaveButton = document.getElementById("srijan-save");
const srijanReconnectButton = document.getElementById("srijan-reconnect");
const srijanConfigStatus = document.getElementById("srijan-config-status");
const srijanConnectionStatus = document.getElementById("srijan-connection-status");
let savedSrijanUrl = "";
let currentSrijanStatus = "not_configured";
function renderSrijanConnectionState() {
    const enteredUrl = srijanUrlElement.value.trim();
    const isConfigured = !!savedSrijanUrl;
    const isDirty = enteredUrl !== savedSrijanUrl;
    if (!isConfigured) {
        srijanConfigStatus.textContent = isDirty && enteredUrl
            ? "URL entered — click Save URL"
            : "URL not configured";
        srijanConfigStatus.dataset.state = isDirty && enteredUrl ? "dirty" : "empty";
    }
    else if (isDirty) {
        srijanConfigStatus.textContent = "Unsaved URL change";
        srijanConfigStatus.dataset.state = "dirty";
    }
    else {
        srijanConfigStatus.textContent = "URL saved";
        srijanConfigStatus.dataset.state = "saved";
    }
    const labels = {
        not_configured: "Connection: NOT CONFIGURED",
        invalid_url: "Connection: INVALID URL",
        connecting: "Connection: CONNECTING…",
        open: "Connection: CONNECTED",
        closed: "Connection: CLOSED — reconnecting…",
        error: "Connection: ERROR — check extension console",
    };
    srijanConnectionStatus.textContent = labels[currentSrijanStatus] ?? `Connection: ${currentSrijanStatus.toUpperCase()}`;
    srijanConnectionStatus.dataset.state = currentSrijanStatus;
}
function updateSrijanStatus(status, url) {
    currentSrijanStatus = status;
    if (typeof url === "string" && url !== savedSrijanUrl) {
        // Do not overwrite a URL the user is currently editing.
    }
    renderSrijanConnectionState();
}
function setStatus(text) {
    statusElement.textContent =
        text;
}
function createBubble(message) {
    const wrapper = document.createElement("div");
    wrapper.className =
        `message-row ${message.sender}`;
    const bubble = document.createElement("div");
    bubble.className =
        "message-bubble";
    /*
     * Sender label.
     */
    if (message.sender !==
        "user") {
        const label = document.createElement("div");
        label.className =
            "message-label";
        if (message.sender ===
            "server") {
            label.textContent =
                "Srijan";
        }
        else {
            label.textContent =
                "System";
        }
        bubble.appendChild(label);
    }
    /*
     * Human-readable text.
     */
    if (message.text) {
        const text = document.createElement("div");
        text.className =
            "message-text";
        text.textContent =
            message.text;
        bubble.appendChild(text);
    }
    /*
     * Screenshot.
     *
     * This is displayed if the received
     * packet contains an image.
     */
    if (message.image) {
        const image = document.createElement("img");
        image.className =
            "screenshot";
        image.src =
            message.image.startsWith("data:")
                ? message.image
                : `data:image/jpeg;base64,${message.image}`;
        image.alt =
            "Browser screenshot";
        bubble.appendChild(image);
    }
    /*
     * JSON display.
     *
     * The ORIGINAL JSON is displayed,
     * not modified.
     */
    if (message.raw !==
        undefined &&
        message.type !==
            "AGENT_ACTION") {
        const details = document.createElement("details");
        details.className =
            "json-details";
        const summary = document.createElement("summary");
        summary.textContent =
            "View JSON";
        const pre = document.createElement("pre");
        pre.textContent =
            JSON.stringify(message.raw, null, 2);
        details.appendChild(summary);
        details.appendChild(pre);
        bubble.appendChild(details);
    }
    /*
     * Agent action JSON can also be viewed.
     */
    if (message.type ===
        "AGENT_ACTION" &&
        message.raw !==
            undefined) {
        const details = document.createElement("details");
        details.className =
            "json-details";
        const summary = document.createElement("summary");
        summary.textContent =
            "View action JSON";
        const pre = document.createElement("pre");
        pre.textContent =
            JSON.stringify(message.raw, null, 2);
        details.appendChild(summary);
        details.appendChild(pre);
        bubble.appendChild(details);
    }
    wrapper.appendChild(bubble);
    return wrapper;
}
function renderMessages(messages) {
    messagesElement.innerHTML =
        "";
    for (const message of messages) {
        messagesElement.appendChild(createBubble(message));
    }
    scrollToBottom();
}
function appendMessage(message) {
    messagesElement.appendChild(createBubble(message));
    scrollToBottom();
}
function scrollToBottom() {
    messagesElement.scrollTop =
        messagesElement.scrollHeight;
}
async function loadSrijanConfig() {
    try {
        const response = await chrome.runtime.sendMessage({ type: "GET_SRIJAN_CONFIG" });
        savedSrijanUrl = typeof response?.url === "string" ? response.url.trim() : "";
        srijanUrlElement.value = savedSrijanUrl;
        currentSrijanStatus = typeof response?.status === "string"
            ? response.status
            : (savedSrijanUrl ? "connecting" : "not_configured");
        renderSrijanConnectionState();
        if (savedSrijanUrl) {
            setStatus("Srijan URL loaded. Waiting for connection status…");
        }
    }
    catch (error) {
        currentSrijanStatus = "invalid_url";
        renderSrijanConnectionState();
        setStatus(error instanceof Error ? error.message : String(error));
    }
}
async function saveSrijanConfig() {
    const url = srijanUrlElement.value.trim();
    srijanSaveButton.disabled = true;
    try {
        const response = await chrome.runtime.sendMessage({ type: "SET_SRIJAN_CONFIG", url });
        if (response?.success) {
            savedSrijanUrl = typeof response.url === "string" ? response.url.trim() : "";
            srijanUrlElement.value = savedSrijanUrl;
            currentSrijanStatus = savedSrijanUrl ? "connecting" : "not_configured";
            renderSrijanConnectionState();
            setStatus(savedSrijanUrl
                ? "Srijan URL saved. Connecting…"
                : "Srijan URL cleared.");
            await chrome.runtime.sendMessage({ type: "RECONNECT_SRIJAN" });
        }
        else {
            setStatus(response?.error ?? "Could not save Srijan URL.");
            currentSrijanStatus = "invalid_url";
            renderSrijanConnectionState();
        }
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
    }
    finally {
        srijanSaveButton.disabled = false;
    }
}
async function reconnectSrijan() {
    const enteredUrl = srijanUrlElement.value.trim();
    if (enteredUrl !== savedSrijanUrl) {
        setStatus("Save the URL first, then reconnect.");
        renderSrijanConnectionState();
        return;
    }
    currentSrijanStatus = savedSrijanUrl ? "connecting" : "not_configured";
    renderSrijanConnectionState();
    try {
        const response = await chrome.runtime.sendMessage({ type: "RECONNECT_SRIJAN" });
        setStatus(response?.success === false ? (response.error ?? "Reconnect failed.") : "Srijan reconnect requested.");
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
    }
}
async function loadMessages() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: "GET_CHAT_MESSAGES",
        });
        if (!response?.success) {
            setStatus("Could not load chat.");
            return;
        }
        renderMessages(response.messages ?? []);
    }
    catch (error) {
        setStatus(error instanceof Error
            ? error.message
            : String(error));
    }
}
async function sendPrompt() {
    const prompt = promptElement.value.trim();
    if (!prompt) {
        return;
    }
    promptElement.value =
        "";
    sendButton.disabled =
        true;
    setStatus("Sending to Srijan...");
    try {
        const response = await chrome.runtime.sendMessage({
            type: "START_AGENT",
            prompt,
        });
        if (response?.success) {
            setStatus("Agent running...");
        }
        else {
            setStatus(response?.error ??
                "Failed to start agent.");
        }
    }
    catch (error) {
        setStatus(error instanceof Error
            ? error.message
            : String(error));
    }
    finally {
        sendButton.disabled =
            false;
        promptElement.focus();
    }
}
async function clearChat() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: "CLEAR_CHAT",
        });
        if (response?.success) {
            messagesElement.innerHTML =
                "";
            setStatus("Chat cleared.");
        }
    }
    catch (error) {
        setStatus(error instanceof Error
            ? error.message
            : String(error));
    }
}
async function testScreenshot() {
    setStatus("Capturing screenshot...");
    try {
        const response = await chrome.runtime.sendMessage({
            type: "LOCAL_SCREENSHOT_TEST",
        });
        if (response?.success) {
            setStatus("Screenshot sent.");
        }
        else {
            setStatus(response?.error ??
                "Screenshot failed.");
        }
    }
    catch (error) {
        setStatus(error instanceof Error
            ? error.message
            : String(error));
    }
}
async function runDemo() {
    setStatus("Running demo...");
    try {
        const response = await chrome.runtime.sendMessage({
            type: "DEMO_ACTION",
        });
        if (response?.success) {
            setStatus("Demo executed.");
        }
        else {
            setStatus(response?.error ??
                "Demo failed.");
        }
    }
    catch (error) {
        setStatus(error instanceof Error
            ? error.message
            : String(error));
    }
}
async function debugRequest(type, extra = {}) {
    setStatus(`Debug: ${type}...`);
    try {
        const response = await chrome.runtime.sendMessage({ type, ...extra });
        if (debugVerbose.checked) {
            appendMessage({
                id: crypto.randomUUID(),
                sender: "system",
                timestamp: Date.now(),
                type: "DEBUG_RESULT",
                text: JSON.stringify(response, null, 2),
                raw: response,
            });
        }
        setStatus(response?.success
            ? `Debug: ${type} passed.`
            : `Debug: ${response?.error ?? "failed"}`);
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
    }
}
srijanUrlElement.addEventListener("input", () => {
    renderSrijanConnectionState();
});
srijanSaveButton.addEventListener("click", () => {
    void saveSrijanConfig();
});
srijanReconnectButton.addEventListener("click", () => {
    void reconnectSrijan();
});
debugToggle.addEventListener("click", () => {
    debugPanel.hidden = !debugPanel.hidden;
});
debugHealthButton.addEventListener("click", () => {
    void debugRequest("DEBUG_LOCAL_SERVER_HEALTH");
});
debugContextButton.addEventListener("click", () => {
    void debugRequest("DEBUG_INITIAL_CONTEXT", {
        prompt: "Debug test: send the current page context with its initial screenshot.",
    });
});
debugPingButton.addEventListener("click", () => {
    void debugRequest("DEBUG_NATIVE_HOST_PING");
});
debugActionButton.addEventListener("click", () => {
    void debugRequest("DEBUG_CONTENT_PING");
});
/*
 * New JSON message from background.
 */
chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SRIJAN_STATUS") {
        updateSrijanStatus(typeof message.status === "string" ? message.status : "unknown", typeof message.url === "string" ? message.url : undefined);
        return;
    }
    if (message?.type !==
        "CHAT_MESSAGE") {
        return;
    }
    const chatMessage = message.message;
    appendMessage(chatMessage);
    if (chatMessage.type ===
        "CONNECTION_STATUS") {
        setStatus(chatMessage.text ??
            "");
    }
});
/*
 * Enter = send.
 * Shift + Enter = newline.
 */
promptElement.addEventListener("keydown", (event) => {
    if (event.key === "Enter" &&
        !event.shiftKey) {
        event.preventDefault();
        void sendPrompt();
    }
});
sendButton.addEventListener("click", () => {
    void sendPrompt();
});
clearButton.addEventListener("click", () => {
    void clearChat();
});
screenshotButton.addEventListener("click", () => {
    void testScreenshot();
});
demoButton.addEventListener("click", () => {
    void runDemo();
});
void loadMessages();
void loadSrijanConfig();
promptElement.focus();
export {};
