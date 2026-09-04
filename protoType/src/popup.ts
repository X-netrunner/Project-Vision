export {};

document.documentElement.style.width = "360px";
document.documentElement.style.height = "520px";
document.body.style.width = "360px";
document.body.style.height = "520px";

interface StorageCallback<T = any> {
  (value: T): void;
}

const storage = {
  get: (key: string, cb: StorageCallback): void => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get([key], (res: Record<string, any>) => cb(res[key] ?? null));
    } else {
      cb(localStorage.getItem(key));
    }
  },
  set: (key: string, val: any): void => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [key]: val });
    } else {
      localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val));
    }
  }
};

document.addEventListener("DOMContentLoaded", () => {
  // Navigation & Dropdown elements
  const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement | null;
  const settingsDropdown = document.getElementById("settingsDropdown") as HTMLDivElement | null;

  // Theme controls
  const themeToggleRow = document.getElementById("themeToggleRow") as HTMLDivElement | null;
  const themeSwitchTrack = document.getElementById("themeSwitchTrack") as HTMLDivElement | null;
  const themeModeText = document.getElementById("themeModeText") as HTMLSpanElement | null;

  // ngrok / Server setup controls
  const ngrokToggleRow = document.getElementById("ngrokToggleRow") as HTMLDivElement | null;
  const ngrokArrow = document.getElementById("ngrokArrow") as HTMLSpanElement | null;
  const ngrokPanel = document.getElementById("ngrokPanel") as HTMLDivElement | null;
  const srijanUrl = document.getElementById("srijanUrl") as HTMLInputElement | null;
  const srijanUrlElement = document.getElementById("srijanUrlElement") as HTMLButtonElement | null;
  const reconnectBtn = document.getElementById("reconnectBtn") as HTMLButtonElement | null;
  const urlSavedStatus = document.getElementById("urlSavedStatus") as HTMLSpanElement | null;
  const srijanConnStatus = document.getElementById("srijanConnStatus") as HTMLSpanElement | null;

  // HUD & Execution indicators
  const statusDot = document.getElementById("statusDot") as HTMLSpanElement | null;
  const statusLabel = document.getElementById("statusLabel") as HTMLSpanElement | null;
  const pauseBtn = document.getElementById("pauseBtn") as HTMLButtonElement | null;
  const abortBtn = document.getElementById("abortBtn") as HTMLButtonElement | null;

  // Chat stream elements
  const contentArea = document.getElementById("contentArea") as HTMLElement | null;
  const chatThread = document.getElementById("chatThread") as HTMLDivElement | null;
  const planSection = document.getElementById("planSection") as HTMLElement | null;
  const goalTitle = document.getElementById("goalTitle") as HTMLDivElement | null;
  const stepList = document.getElementById("stepList") as HTMLUListElement | null;
  const taskCount = document.getElementById("taskCount") as HTMLSpanElement | null;
  const promptInput = document.getElementById("promptInput") as HTMLInputElement | null;
  const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement | null;

  /* -------------------------------------------------------------
     1. Dropdown and Flyout Toggles
  ------------------------------------------------------------- */
  settingsBtn?.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    settingsDropdown?.classList.toggle("active");
  });

  settingsDropdown?.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
  });

  document.addEventListener("click", () => {
    settingsDropdown?.classList.remove("active");
  });

  ngrokToggleRow?.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    const isExpanded = ngrokPanel?.classList.toggle("expanded");
    if (ngrokArrow) {
      ngrokArrow.textContent = isExpanded ? "▼" : "▶";
    }
  });

  /* -------------------------------------------------------------
     2. Theme Configuration (Default: Dark, Toggled ON: Light)
  ------------------------------------------------------------- */
  function applyTheme(isLight: boolean): void {
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

  storage.get("isLightMode", (saved: any) => {
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
  let activeWs: WebSocket | null = null;
  let healthPollInterval: number | null = null;

  function updateStatusIndicator(): void {
    if (!statusDot || !statusLabel) return;

    if (isAppPyOnline && isNgrokOnline) {
      statusDot.className = "pulse-dot";
      statusDot.style.background = "var(--accent-emerald)";
      statusDot.style.boxShadow = "0 0 5px var(--accent-emerald)";
      statusLabel.textContent = "READY";
      statusLabel.style.color = "var(--accent-emerald)";
    } else if (isAppPyOnline || isNgrokOnline) {
      statusDot.className = "pulse-dot waiting";
      statusDot.style.background = "var(--accent-amber)";
      statusDot.style.boxShadow = "0 0 5px var(--accent-amber)";
      statusLabel.textContent = isAppPyOnline ? "NO NGROK" : "NO LOCAL";
      statusLabel.style.color = "var(--accent-amber)";
    } else {
      statusDot.className = "pulse-dot";
      statusDot.style.background = "var(--accent-rose)";
      statusDot.style.boxShadow = "0 0 5px var(--accent-rose)";
      statusLabel.textContent = "OFFLINE";
      statusLabel.style.color = "var(--accent-rose)";
    }
  }

  async function checkAppPyConnection(): Promise<boolean> {
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
      } catch {
        // Fallback to the next local port candidate
      }
    }
    return false;
  }

  function checkNgrokSocket(url: string): void {
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
    } catch {
      isNgrokOnline = false;
      if (srijanConnStatus) {
        srijanConnStatus.textContent = "FAILED TO CONNECT";
        srijanConnStatus.style.color = "var(--accent-rose)";
      }
      updateStatusIndicator();
    }
  }

  async function performFullHealthCheck(): Promise<void> {
    isAppPyOnline = await checkAppPyConnection();
    const wsUrl = srijanUrl?.value.trim() || srijanUrl?.getAttribute("placeholder") || "";
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
      checkNgrokSocket(wsUrl);
    }
    updateStatusIndicator();
  }

  storage.get("srijanWsUrl", (savedUrl: string | null) => {
    if (savedUrl && srijanUrl) {
      srijanUrl.value = savedUrl;
    }
    performFullHealthCheck();
    healthPollInterval = window.setInterval(performFullHealthCheck, 5000);
  });

  srijanUrlElement?.addEventListener("click", () => {
    const val = srijanUrl?.value.trim() || srijanUrl?.getAttribute("placeholder") || "";
    if (!val) return;

    storage.set("srijanWsUrl", val);
    if (urlSavedStatus) {
      urlSavedStatus.textContent = "URL saved ✓";
      setTimeout(() => {
        if (urlSavedStatus) urlSavedStatus.textContent = "URL saved";
      }, 2000);
    }

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ action: "UPDATE_SRIJAN_URL", url: val }).catch(() => {});
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
  function appendMessage(text: string, sender: "user" | "agent" = "user"): void {
    if (!chatThread || !contentArea) return;
    const bubble = document.createElement("div");
    bubble.className = `chat-msg ${sender}`;
    bubble.textContent = text;
    chatThread.appendChild(bubble);
    contentArea.scrollTop = contentArea.scrollHeight;
  }

  function dispatchMessage(): void {
    const text = promptInput?.value.trim();
    if (!text) return;

    appendMessage(text, "user");
    if (promptInput) promptInput.value = "";

    if (statusLabel) statusLabel.textContent = "PLANNING...";
    if (statusDot) {
      statusDot.className = "pulse-dot waiting";
      statusDot.style.background = "var(--accent-amber)";
    }

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ action: "USER_PROMPT", prompt: text }).catch(() => {});
    }

    setTimeout(() => {
      appendMessage(`Analyzing objective: "${text}"... Blueprint generated below.`, "agent");

      if (planSection) planSection.style.display = "block";
      if (goalTitle) goalTitle.textContent = `Goal: ${text}`;
      if (taskCount) taskCount.textContent = "3 Tasks";
      if (statusLabel) statusLabel.textContent = "RUNNING";
      if (statusDot) {
        statusDot.className = "pulse-dot";
        statusDot.style.background = "var(--accent-emerald)";
      }
      if (pauseBtn) pauseBtn.disabled = false;
      if (abortBtn) abortBtn.disabled = false;

      if (stepList) {
        stepList.innerHTML = `
          <li class="task-item running"><span class="item-icon">●</span><span>Inspecting DOM tree & target elements</span></li>
          <li class="task-item pending"><span class="item-icon">○</span><span>Synthesizing parameters and comparing state</span></li>
          <li class="task-item pending"><span class="item-icon">○</span><span>Execute browser interactions</span></li>
        `;
      }

      if (contentArea) contentArea.scrollTop = contentArea.scrollHeight;
    }, 450);
  }

  sendBtn?.addEventListener("click", dispatchMessage);
  promptInput?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dispatchMessage();
    }
  });

  abortBtn?.addEventListener("click", () => {
    if (statusLabel) statusLabel.textContent = "ABORTED";
    if (pauseBtn) pauseBtn.disabled = true;
    if (abortBtn) abortBtn.disabled = true;
    appendMessage("Pipeline execution halted by user.", "agent");
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ action: "ABORT" }).catch(() => {});
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