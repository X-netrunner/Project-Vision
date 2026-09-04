const CHAT_STORAGE_KEY = "vision_chat_history";
document.documentElement.style.width = "360px";
document.documentElement.style.height = "520px";
document.addEventListener("DOMContentLoaded", () => {
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsDropdown = document.getElementById("settingsDropdown");
    const controlsToggleRow = document.getElementById("controlsToggleRow");
    const controlsArrow = document.getElementById("controlsArrow");
    const controlsPanel = document.getElementById("controlsPanel");
    const clearChatBtn = document.getElementById("clearChatBtn");
    const themeToggleRow = document.getElementById("themeToggleRow");
    const themeSwitchTrack = document.getElementById("themeSwitchTrack");
    const themeModeText = document.getElementById("themeModeText");
    const ngrokToggleRow = document.getElementById("ngrokToggleRow");
    const ngrokArrow = document.getElementById("ngrokArrow");
    const ngrokPanel = document.getElementById("ngrokPanel");
    const srijanUrlElement = document.getElementById("srijanUrl");
    const srijanSaveButton = document.getElementById("srijanUrlElement");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const urlSavedStatus = document.getElementById("urlSavedStatus");
    const srijanConnStatus = document.getElementById("srijanConnStatus");
    const statusDot = document.getElementById("statusDot");
    const statusLabel = document.getElementById("statusLabel");
    const contentArea = document.getElementById("contentArea");
    const chatThread = document.getElementById("chatThread");
    const promptInput = document.getElementById("promptInput");
    const sendBtn = document.getElementById("sendBtn");
    let savedSrijanUrl = "";
    let currentSrijanStatus = "not_configured";
    let chatHistory = [];
    function storageGet(key) {
        return new Promise((resolve) => {
            if (typeof chrome !== "undefined" &&
                chrome.storage?.local) {
                chrome.storage.local.get([key], (result) => {
                    resolve(result[key] ?? null);
                });
                return;
            }
            try {
                const value = localStorage.getItem(key);
                resolve(value
                    ? JSON.parse(value)
                    : null);
            }
            catch {
                resolve(null);
            }
        });
    }
    function storageSet(key, value) {
        return new Promise((resolve) => {
            if (typeof chrome !== "undefined" &&
                chrome.storage?.local) {
                chrome.storage.local.set({ [key]: value }, () => resolve());
                return;
            }
            try {
                localStorage.setItem(key, JSON.stringify(value));
            }
            catch {
                // Ignore storage failures.
            }
            resolve();
        });
    }
    function setStatus(text, state = "ready") {
        if (!statusLabel ||
            !statusDot) {
            return;
        }
        statusLabel.textContent =
            text.toUpperCase();
        statusDot.className =
            "pulse-dot";
        if (state === "ready") {
            statusDot.style.background =
                "var(--accent-emerald)";
        }
        else if (state === "running") {
            statusDot.style.background =
                "var(--accent-violet)";
        }
        else if (state === "waiting") {
            statusDot.classList.add("waiting");
            statusDot.style.background =
                "var(--accent-amber)";
        }
        else {
            statusDot.classList.add("error");
            statusDot.style.background =
                "var(--accent-rose)";
        }
    }
    /*
     * SETTINGS MENU
     */
    settingsBtn?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        settingsDropdown?.classList.toggle("active");
    });
    settingsDropdown?.addEventListener("click", (event) => {
        event.stopPropagation();
    });
    document.addEventListener("click", () => {
        settingsDropdown?.classList.remove("active");
    });
    controlsToggleRow?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const expanded = controlsPanel?.classList.toggle("expanded");
        if (controlsArrow) {
            controlsArrow.textContent =
                expanded
                    ? "▼"
                    : "▶";
        }
    });
    ngrokToggleRow?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const expanded = ngrokPanel?.classList.toggle("expanded");
        if (ngrokArrow) {
            ngrokArrow.textContent =
                expanded
                    ? "▼"
                    : "▶";
        }
    });
    /*
     * THEME
     */
    function applyTheme(isLight) {
        const theme = isLight
            ? "light"
            : "dark";
        document.documentElement.setAttribute("data-theme", theme);
        themeSwitchTrack?.classList.toggle("on", isLight);
        if (themeModeText) {
            themeModeText.textContent =
                isLight
                    ? "On (Light)"
                    : "Off (Default Dark)";
        }
        void storageSet("isLightMode", isLight);
    }
    themeToggleRow?.addEventListener("click", () => {
        const isLight = document.documentElement.getAttribute("data-theme") === "light";
        applyTheme(!isLight);
    });
    void storageGet("isLightMode").then((savedTheme) => {
        applyTheme(savedTheme === true);
    });
    /*
     * SRIJAN CONNECTION
     */
    function renderSrijanConnectionState() {
        if (!srijanUrlElement) {
            return;
        }
        const enteredUrl = srijanUrlElement.value.trim();
        const isConfigured = Boolean(savedSrijanUrl);
        const isDirty = enteredUrl !== savedSrijanUrl;
        if (urlSavedStatus) {
            if (!isConfigured) {
                if (isDirty &&
                    enteredUrl) {
                    urlSavedStatus.textContent =
                        "URL entered — click Save URL";
                }
                else {
                    urlSavedStatus.textContent =
                        "URL not configured";
                }
                urlSavedStatus.style.color =
                    "var(--accent-amber)";
            }
            else if (isDirty) {
                urlSavedStatus.textContent =
                    "Unsaved URL change";
                urlSavedStatus.style.color =
                    "var(--accent-amber)";
            }
            else {
                urlSavedStatus.textContent =
                    "URL saved ✓";
                urlSavedStatus.style.color =
                    "var(--accent-emerald)";
            }
        }
        const labels = {
            not_configured: "NOT CONFIGURED",
            invalid_url: "INVALID URL",
            connecting: "CONNECTING…",
            open: "CONNECTED",
            closed: "CLOSED",
            error: "ERROR"
        };
        if (srijanConnStatus) {
            srijanConnStatus.textContent =
                labels[currentSrijanStatus] ??
                    currentSrijanStatus.toUpperCase();
            if (currentSrijanStatus ===
                "open") {
                srijanConnStatus.style.color =
                    "var(--accent-emerald)";
                setStatus("Ready", "ready");
            }
            else if (currentSrijanStatus ===
                "connecting") {
                srijanConnStatus.style.color =
                    "var(--accent-cyan)";
                setStatus("Connecting", "waiting");
            }
            else if (currentSrijanStatus ===
                "not_configured") {
                srijanConnStatus.style.color =
                    "var(--accent-amber)";
                setStatus("Offline", "waiting");
            }
            else {
                srijanConnStatus.style.color =
                    "var(--accent-rose)";
                setStatus("Offline", "error");
            }
        }
    }
    function updateSrijanStatus(status, url) {
        currentSrijanStatus =
            status;
        /*
         * Only populate the URL automatically
         * if the user has not already configured one.
         */
        if (typeof url === "string" &&
            !savedSrijanUrl) {
            savedSrijanUrl =
                url.trim();
            if (srijanUrlElement) {
                srijanUrlElement.value =
                    savedSrijanUrl;
            }
        }
        renderSrijanConnectionState();
    }
    async function loadSrijanConfig() {
        try {
            const response = await chrome.runtime.sendMessage({
                type: "GET_SRIJAN_CONFIG"
            });
            savedSrijanUrl =
                typeof response?.url === "string"
                    ? response.url.trim()
                    : "";
            if (srijanUrlElement) {
                srijanUrlElement.value =
                    savedSrijanUrl;
            }
            currentSrijanStatus =
                typeof response?.status === "string"
                    ? response.status
                    : savedSrijanUrl
                        ? "connecting"
                        : "not_configured";
            renderSrijanConnectionState();
        }
        catch {
            currentSrijanStatus =
                "error";
            renderSrijanConnectionState();
        }
    }
    async function saveSrijanConfig() {
        if (!srijanUrlElement) {
            return;
        }
        const url = srijanUrlElement.value.trim();
        if (srijanSaveButton) {
            srijanSaveButton.disabled =
                true;
        }
        try {
            const response = await chrome.runtime.sendMessage({
                type: "SET_SRIJAN_CONFIG",
                url
            });
            if (response?.success) {
                savedSrijanUrl =
                    typeof response.url ===
                        "string"
                        ? response.url.trim()
                        : "";
                srijanUrlElement.value =
                    savedSrijanUrl;
                currentSrijanStatus =
                    savedSrijanUrl
                        ? "connecting"
                        : "not_configured";
                renderSrijanConnectionState();
                await chrome.runtime.sendMessage({
                    type: "RECONNECT_SRIJAN"
                });
            }
            else {
                currentSrijanStatus =
                    "invalid_url";
                renderSrijanConnectionState();
            }
        }
        catch {
            currentSrijanStatus =
                "error";
            renderSrijanConnectionState();
        }
        finally {
            if (srijanSaveButton) {
                srijanSaveButton.disabled =
                    false;
            }
        }
    }
    async function reconnectSrijan() {
        if (!srijanUrlElement) {
            return;
        }
        const enteredUrl = srijanUrlElement.value.trim();
        if (enteredUrl !== savedSrijanUrl) {
            setStatus("Save URL first", "waiting");
            renderSrijanConnectionState();
            return;
        }
        currentSrijanStatus =
            savedSrijanUrl
                ? "connecting"
                : "not_configured";
        renderSrijanConnectionState();
        try {
            await chrome.runtime.sendMessage({
                type: "RECONNECT_SRIJAN"
            });
        }
        catch {
            currentSrijanStatus =
                "error";
            renderSrijanConnectionState();
        }
    }
    srijanUrlElement?.addEventListener("input", renderSrijanConnectionState);
    srijanSaveButton?.addEventListener("click", () => {
        void saveSrijanConfig();
    });
    reconnectBtn?.addEventListener("click", () => {
        void reconnectSrijan();
    });
    /*
     * CHAT RENDERING
     */
    function scrollToBottom() {
        if (contentArea) {
            contentArea.scrollTop =
                contentArea.scrollHeight;
        }
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
         * This displays the exact screenshot
         * received from the backend.
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
         * JSON payload.
         *
         * Keep the original raw payload.
         */
        if (message.raw !==
            undefined) {
            const details = document.createElement("details");
            details.className =
                "json-details";
            const summary = document.createElement("summary");
            summary.textContent =
                message.type ===
                    "AGENT_ACTION"
                    ? "View action JSON"
                    : "View JSON";
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
        if (!chatThread) {
            return;
        }
        chatThread.innerHTML =
            "";
        for (const message of messages) {
            chatThread.appendChild(createBubble(message));
        }
        scrollToBottom();
    }
    async function saveChatMemory() {
        await storageSet(CHAT_STORAGE_KEY, chatHistory);
    }
    function hasMessage(message) {
        return chatHistory.some((existingMessage) => existingMessage.id ===
            message.id);
    }
    function appendChatMessage(message, persist = true) {
        /*
         * Prevent duplicate messages.
         */
        if (hasMessage(message)) {
            return;
        }
        chatHistory.push(message);
        if (chatThread) {
            chatThread.appendChild(createBubble(message));
        }
        scrollToBottom();
        if (persist) {
            void saveChatMemory();
        }
    }
    function createDefaultMessage() {
        return {
            id: crypto.randomUUID(),
            sender: "system",
            timestamp: Date.now(),
            type: "SYSTEM",
            text: "Agent Ready. Enter instructions below to dispatch browser directives."
        };
    }
    /*
     * FIRST LOAD CHAT FROM BACKGROUND.
     *
     * bg.ts remains the primary source of
     * truth for the chat history.
     */
    async function loadMessages() {
        try {
            const response = await chrome.runtime.sendMessage({
                type: "GET_CHAT_MESSAGES"
            });
            if (response?.success &&
                Array.isArray(response.messages)) {
                chatHistory =
                    response.messages;
                /*
                 * Fall back to local storage only
                 * if background history is empty.
                 */
                if (chatHistory.length === 0) {
                    const localMessages = await storageGet(CHAT_STORAGE_KEY);
                    if (Array.isArray(localMessages) &&
                        localMessages.length > 0) {
                        chatHistory =
                            localMessages;
                    }
                }
                /*
                 * Add the default system message
                 * only if there is absolutely
                 * no existing history.
                 */
                if (chatHistory.length === 0) {
                    chatHistory = [
                        createDefaultMessage()
                    ];
                }
                renderMessages(chatHistory);
                await saveChatMemory();
                return;
            }
            throw new Error(response?.error ??
                "Could not load chat.");
        }
        catch {
            /*
             * Background unavailable.
             * Recover from local memory.
             */
            const localMessages = await storageGet(CHAT_STORAGE_KEY);
            if (Array.isArray(localMessages) &&
                localMessages.length > 0) {
                chatHistory =
                    localMessages;
            }
            else {
                chatHistory = [
                    createDefaultMessage()
                ];
            }
            renderMessages(chatHistory);
        }
    }
    /*
     * PROMPT DISPATCH
     */
    async function sendPrompt() {
        if (!promptInput) {
            return;
        }
        const prompt = promptInput.value.trim();
        if (!prompt) {
            return;
        }
        promptInput.value =
            "";
        if (sendBtn) {
            sendBtn.disabled =
                true;
        }
        setStatus("Executing", "running");
        try {
            const response = await chrome.runtime.sendMessage({
                type: "START_AGENT",
                prompt
            });
            if (response?.success) {
                setStatus("Agent running", "running");
            }
            else {
                setStatus(response?.error ??
                    "Failed to start agent", "error");
            }
        }
        catch (error) {
            setStatus(error instanceof Error
                ? error.message
                : "Error", "error");
        }
        finally {
            if (sendBtn) {
                sendBtn.disabled =
                    false;
            }
            promptInput.focus();
        }
    }
    sendBtn?.addEventListener("click", () => {
        void sendPrompt();
    });
    promptInput?.addEventListener("keydown", (event) => {
        if (event.key ===
            "Enter" &&
            !event.shiftKey) {
            event.preventDefault();
            void sendPrompt();
        }
    });
    /*
     * CLEAR CHAT
     */
    clearChatBtn?.addEventListener("click", () => {
        void clearChat();
    });
    async function clearChat() {
        try {
            const response = await chrome.runtime.sendMessage({
                type: "CLEAR_CHAT"
            });
            if (response?.success === false) {
                setStatus(response.error ??
                    "Could not clear chat", "error");
                return;
            }
        }
        catch {
            /*
             * Still clear local memory if the
             * background is temporarily unavailable.
             */
        }
        chatHistory =
            [
                createDefaultMessage()
            ];
        await saveChatMemory();
        renderMessages(chatHistory);
        setStatus("Chat cleared", "ready");
    }
    /*
     * BACKGROUND EVENTS
     */
    if (typeof chrome !==
        "undefined" &&
        chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message) => {
            if (!message ||
                typeof message !==
                    "object") {
                return;
            }
            const packet = message;
            if (packet.type ===
                "SRIJAN_STATUS") {
                updateSrijanStatus(typeof packet.status ===
                    "string"
                    ? packet.status
                    : "unknown", typeof packet.url ===
                    "string"
                    ? packet.url
                    : undefined);
                return;
            }
            if (packet.type !==
                "CHAT_MESSAGE" ||
                !packet.message) {
                return;
            }
            const chatMessage = packet.message;
            /*
             * IMPORTANT:
             *
             * Persist incoming backend messages.
             * This includes screenshots,
             * JSON payloads and agent actions.
             */
            appendChatMessage(chatMessage, true);
            if (chatMessage.type ===
                "CONNECTION_STATUS") {
                setStatus(chatMessage.text ??
                    "Connection update", "waiting");
            }
            else if (chatMessage.type ===
                "CONNECTION_ERROR" ||
                chatMessage.type ===
                    "VARUN_ERROR") {
                setStatus("Error", "error");
            }
            else if (chatMessage.type ===
                "AGENT_ACTION") {
                setStatus("Action executed", "ready");
            }
        });
    }
    /*
     * INITIALIZE
     */
    void loadMessages();
    void loadSrijanConfig();
    promptInput?.focus();
});
export {};
