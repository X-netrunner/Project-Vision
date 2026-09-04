document.documentElement.style.width = "360px";
document.documentElement.style.height = "520px";
document.body.style.width = "360px";
document.body.style.height = "520px";
const storage = {
    get: (key, cb) => {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            chrome.storage.local.get([key], (res) => cb(res[key] ?? null));
        }
        else {
            cb(localStorage.getItem(key));
        }
    },
    set: (key, val) => {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            chrome.storage.local.set({ [key]: val });
        }
        else {
            localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val));
        }
    }
};
document.addEventListener("DOMContentLoaded", () => {
    // Navigation & Dropdown elements
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsDropdown = document.getElementById("settingsDropdown");
    // Theme controls
    const themeToggleRow = document.getElementById("themeToggleRow");
    const themeSwitchTrack = document.getElementById("themeSwitchTrack");
    const themeModeText = document.getElementById("themeModeText");
    // ngrok / Server setup controls
    const ngrokToggleRow = document.getElementById("ngrokToggleRow");
    const ngrokArrow = document.getElementById("ngrokArrow");
    const ngrokPanel = document.getElementById("ngrokPanel");
    const srijanUrl = document.getElementById("srijanUrl");
    const srijanUrlElement = document.getElementById("srijanUrlElement");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const urlSavedStatus = document.getElementById("urlSavedStatus");
    const srijanConnStatus = document.getElementById("srijanConnStatus");
    // HUD & Execution indicators
    const statusDot = document.getElementById("statusDot");
    const statusLabel = document.getElementById("statusLabel");
    const pauseBtn = document.getElementById("pauseBtn");
    const abortBtn = document.getElementById("abortBtn");
    // Chat stream elements
    const contentArea = document.getElementById("contentArea");
    const chatThread = document.getElementById("chatThread");
    const planSection = document.getElementById("planSection");
    const goalTitle = document.getElementById("goalTitle");
    const stepList = document.getElementById("stepList");
    const taskCount = document.getElementById("taskCount");
    const promptInput = document.getElementById("promptInput");
    const sendBtn = document.getElementById("sendBtn");
    /* -------------------------------------------------------------
       1. Dropdown and Flyout Toggles
    ------------------------------------------------------------- */
    settingsBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        settingsDropdown?.classList.toggle("active");
    });
    settingsDropdown?.addEventListener("click", (e) => {
        e.stopPropagation();
    });
    document.addEventListener("click", () => {
        settingsDropdown?.classList.remove("active");
    });
    ngrokToggleRow?.addEventListener("click", (e) => {
        e.stopPropagation();
        const isExpanded = ngrokPanel?.classList.toggle("expanded");
        if (ngrokArrow) {
            ngrokArrow.textContent = isExpanded ? "▼" : "▶";
        }
    });
    /* -------------------------------------------------------------
       2. Theme Configuration (Default: Dark, Toggled ON: Light)
    ------------------------------------------------------------- */
    function applyTheme(isLight) {
        const themeName = isLight ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", themeName);
        if (themeSwitchTrack) {
            themeSwitchTrack.classList.toggle("on", isLight);
        }
        if (themeModeText) {
            themeModeText.textContent = isLight ? "On (Light)" : "Off (Default Dark)";
        }
        storage.set("isLightMode", isLight);
    }
    themeToggleRow?.addEventListener("click", () => {
        const isCurrentlyLight = document.documentElement.getAttribute("data-theme") === "light";
        applyTheme(!isCurrentlyLight);
    });
    storage.get("isLightMode", (saved) => {
        applyTheme(saved === true || saved === "true");
    });
    /* -------------------------------------------------------------
       3. Dual Connection Health Check (app.py & ngrok)
          - GREEN:  Both Varun's app.py and ngrok are connected.
          - YELLOW: Only one of the two services is connected.
          - RED:    Neither is connected / offline.
    ------------------------------------------------------------- */
    let isAppPyOnline = false;
    let isNgrokOnline = false;
    let activeWs = null;
    let healthPollInterval = null;
    function updateStatusIndicator() {
        if (!statusDot || !statusLabel)
            return;
        if (isAppPyOnline && isNgrokOnline) {
            statusDot.className = "pulse-dot";
            statusDot.style.background = "var(--accent-emerald)";
            statusDot.style.boxShadow = "0 0 5px var(--accent-emerald)";
            statusLabel.textContent = "READY";
            statusLabel.style.color = "var(--accent-emerald)";
        }
        else if (isAppPyOnline || isNgrokOnline) {
            statusDot.className = "pulse-dot waiting";
            statusDot.style.background = "var(--accent-amber)";
            statusDot.style.boxShadow = "0 0 5px var(--accent-amber)";
            statusLabel.textContent = isAppPyOnline ? "NO NGROK" : "NO LOCAL";
            statusLabel.style.color = "var(--accent-amber)";
        }
        else {
            statusDot.className = "pulse-dot";
            statusDot.style.background = "var(--accent-rose)";
            statusDot.style.boxShadow = "0 0 5px var(--accent-rose)";
            statusLabel.textContent = "OFFLINE";
            statusLabel.style.color = "var(--accent-rose)";
        }
    }
    async function checkAppPyConnection() {
        const localPorts = [5000, 8000, 8080];
        for (const port of localPorts) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 1200);
                const res = await fetch(`http://127.0.0.1:${port}/health`, {
                    method: "GET",
                    signal: controller.signal
                }).catch(() => null);
                clearTimeout(timeoutId);
                if (res && (res.ok || res.status === 404)) {
                    return true;
                }
            }
            catch {
                // Fallback to the next local port candidate
            }
        }
        return false;
    }
    function checkNgrokSocket(url) {
        if (!url) {
            isNgrokOnline = false;
            if (srijanConnStatus) {
                srijanConnStatus.textContent = "NO URL SPECIFIED";
                srijanConnStatus.style.color = "var(--accent-amber)";
            }
            updateStatusIndicator();
            return;
        }
        try {
            if (activeWs) {
                activeWs.onopen = null;
                activeWs.onerror = null;
                activeWs.onclose = null;
                activeWs.close();
            }
            activeWs = new WebSocket(url);
            activeWs.onopen = () => {
                isNgrokOnline = true;
                if (srijanConnStatus) {
                    srijanConnStatus.textContent = "CONNECTED";
                    srijanConnStatus.style.color = "var(--accent-emerald)";
                }
                updateStatusIndicator();
            };
            activeWs.onerror = () => {
                isNgrokOnline = false;
                if (srijanConnStatus) {
                    srijanConnStatus.textContent = "CONNECTION ERROR";
                    srijanConnStatus.style.color = "var(--accent-rose)";
                }
                updateStatusIndicator();
            };
            activeWs.onclose = () => {
                isNgrokOnline = false;
                if (srijanConnStatus) {
                    srijanConnStatus.textContent = "CLOSED — reconnecting...";
                    srijanConnStatus.style.color = "var(--accent-amber)";
                }
                updateStatusIndicator();
            };
        }
        catch {
            isNgrokOnline = false;
            if (srijanConnStatus) {
                srijanConnStatus.textContent = "FAILED TO CONNECT";
                srijanConnStatus.style.color = "var(--accent-rose)";
            }
            updateStatusIndicator();
        }
    }
    async function performFullHealthCheck() {
        isAppPyOnline = await checkAppPyConnection();
        const wsUrl = srijanUrl?.value.trim() || srijanUrl?.getAttribute("placeholder") || "";
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
            checkNgrokSocket(wsUrl);
        }
        updateStatusIndicator();
    }
    storage.get("srijanWsUrl", (savedUrl) => {
        if (savedUrl && srijanUrl) {
            srijanUrl.value = savedUrl;
        }
        performFullHealthCheck();
        healthPollInterval = window.setInterval(performFullHealthCheck, 5000);
    });
    srijanUrlElement?.addEventListener("click", () => {
        const val = srijanUrl?.value.trim() || srijanUrl?.getAttribute("placeholder") || "";
        if (!val)
            return;
        storage.set("srijanWsUrl", val);
        if (urlSavedStatus) {
            urlSavedStatus.textContent = "URL saved ✓";
            setTimeout(() => {
                if (urlSavedStatus)
                    urlSavedStatus.textContent = "URL saved";
            }, 2000);
        }
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({ action: "UPDATE_SRIJAN_URL", url: val }).catch(() => { });
        }
        checkNgrokSocket(val);
    });
    reconnectBtn?.addEventListener("click", () => {
        if (srijanConnStatus) {
            srijanConnStatus.textContent = "Connecting...";
            srijanConnStatus.style.color = "var(--accent-cyan)";
        }
        const val = srijanUrl?.value.trim() || srijanUrl?.getAttribute("placeholder") || "";
        checkNgrokSocket(val);
    });
    /* -------------------------------------------------------------
       4. Chat Messaging & Blueprint Generation
    ------------------------------------------------------------- */
    function appendMessage(text, sender = "user") {
        if (!chatThread || !contentArea)
            return;
        const bubble = document.createElement("div");
        bubble.className = `chat-msg ${sender}`;
        bubble.textContent = text;
        chatThread.appendChild(bubble);
        contentArea.scrollTop = contentArea.scrollHeight;
    }
    function dispatchMessage() {
        const text = promptInput?.value.trim();
        if (!text)
            return;
        appendMessage(text, "user");
        if (promptInput)
            promptInput.value = "";
        if (statusLabel)
            statusLabel.textContent = "PLANNING...";
        if (statusDot) {
            statusDot.className = "pulse-dot waiting";
            statusDot.style.background = "var(--accent-amber)";
        }
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({ action: "USER_PROMPT", prompt: text }).catch(() => { });
        }
        setTimeout(() => {
            appendMessage(`Analyzing objective: "${text}"... Blueprint generated below.`, "agent");
            if (planSection)
                planSection.style.display = "block";
            if (goalTitle)
                goalTitle.textContent = `Goal: ${text}`;
            if (taskCount)
                taskCount.textContent = "3 Tasks";
            if (statusLabel)
                statusLabel.textContent = "RUNNING";
            if (statusDot) {
                statusDot.className = "pulse-dot";
                statusDot.style.background = "var(--accent-emerald)";
            }
            if (pauseBtn)
                pauseBtn.disabled = false;
            if (abortBtn)
                abortBtn.disabled = false;
            if (stepList) {
                stepList.innerHTML = `
          <li class="task-item running"><span class="item-icon">●</span><span>Inspecting DOM tree & target elements</span></li>
          <li class="task-item pending"><span class="item-icon">○</span><span>Synthesizing parameters and comparing state</span></li>
          <li class="task-item pending"><span class="item-icon">○</span><span>Execute browser interactions</span></li>
        `;
            }
            if (contentArea)
                contentArea.scrollTop = contentArea.scrollHeight;
        }, 450);
    }
    sendBtn?.addEventListener("click", dispatchMessage);
    promptInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            dispatchMessage();
        }
    });
    abortBtn?.addEventListener("click", () => {
        if (statusLabel)
            statusLabel.textContent = "ABORTED";
        if (pauseBtn)
            pauseBtn.disabled = true;
        if (abortBtn)
            abortBtn.disabled = true;
        appendMessage("Pipeline execution halted by user.", "agent");
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({ action: "ABORT" }).catch(() => { });
        }
    });
    window.addEventListener("unload", () => {
        if (healthPollInterval !== null) {
            clearInterval(healthPollInterval);
        }
        if (activeWs) {
            activeWs.close();
        }
    });
});
export {};
