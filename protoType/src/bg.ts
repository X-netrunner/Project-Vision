console.log(
    "[BG] Project Vision background worker active"
);

const BACKEND_WS_URL =
    "ws://127.0.0.1:8000/ws";

let backendSocket:
    WebSocket | null = null;

let backendConnecting =
    false;

interface StartRedactMessage {
    action: "Start_Redact";
    tabId: number;
}

interface RedactionCompleteMessage {
    action: "REDACTION_COMPLETE";
    sanitizedUri: string;
}

interface ScreenshotMessage {
    type: "SCREENSHOT";
    request_id: string;
    tab_id: number;
    image: string;
}

interface ActionCoordinatesMessage {
    type: "ACTION_COORDINATES";
    request_id?: string;
    action_id?: string;
    tabId?: number;
    payload: {
        action:
            | "click"
            | "type"
            | "press"
            | "scroll"
            | "open_tab"
            | "navigate"
            | "search"
            | "close_tab"
            | "switch_tab";

        x?: number;
        y?: number;

        text?: string;
        key?: string;

        direction?: "up" | "down";
        amount?: number;

        url?: string;
        query?: string;
        tab_id?: number;

        step_index: number;
        is_last_step: boolean;
    };
}

interface ActionResultMessage {
    type: "ACTION_RESULT";
    request_id?: string;
    action_id?: string;
    payload: {
        success: boolean;
        action:
            | "click"
            | "type"
            | "press"
            | "scroll"
            | "open_tab"
            | "navigate"
            | "search"
            | "close_tab"
            | "switch_tab";
        step_index: number;
        error?: string;
        tab_id?: number;
    };
}

type BackgroundMessage =
    | StartRedactMessage
    | RedactionCompleteMessage
    | ActionCoordinatesMessage
    | ActionResultMessage;

function connectBackend(): void {

    if (
        backendSocket?.readyState ===
        WebSocket.OPEN
    ) {
        return;
    }

    if (backendConnecting) {
        return;
    }

    backendConnecting = true;

    console.log(
        "[BG] Connecting to backend:",
        BACKEND_WS_URL
    );

    try {
        const socket =
            new WebSocket(
                BACKEND_WS_URL
            );

        backendSocket =
            socket;

        socket.onopen = () => {
            backendConnecting =
                false;

            console.log(
                "[BG] Backend connected"
            );
        };

        socket.onmessage = (
            event
        ) => {
            handleBackendMessage(
                event.data
            );
        };

        socket.onerror = (
            error
        ) => {
            console.error(
                "[BG] Backend WebSocket error:",
                error
            );
        };

        socket.onclose = () => {
            backendConnecting =
                false;

            backendSocket =
                null;

            console.log(
                "[BG] Backend disconnected"
            );

            setTimeout(
                connectBackend,
                3000
            );
        };

    } catch (error) {
        backendConnecting =
            false;

        console.error(
            "[BG] Backend connection failed:",
            error
        );
    }
}

function sendToBackend(
    message: unknown
): boolean {

    if (
        backendSocket?.readyState !==
        WebSocket.OPEN
    ) {
        console.error(
            "[BG] Backend is not connected"
        );

        connectBackend();

        return false;
    }

    backendSocket.send(
        JSON.stringify(message)
    );

    return true;
}

async function handleBackendMessage(
    rawMessage: unknown
): Promise<void> {

    let message:
        | ActionCoordinatesMessage
        | null = null;

    try {

        if (
            typeof rawMessage !== "string"
        ) {
            console.error(
                "[BG] Backend message is not text"
            );
            return;
        }

        const parsed =
            JSON.parse(
                rawMessage
            );

        if (
            !parsed ||
            parsed.type !==
                "ACTION_COORDINATES"
        ) {
            console.log(
                "[BG] Ignoring backend message:",
                parsed
            );

            return;
        }

        message =
            parsed as ActionCoordinatesMessage;

        await handleAction(
            message
        );

    } catch (error) {

        console.error(
            "[BG] Invalid backend message:",
            error
        );

        if (message) {
            const result:
                ActionResultMessage = {
                    type:
                        "ACTION_RESULT",
                    request_id:
                        message.request_id,
                    action_id:
                        message.action_id,
                    payload: {
                        success: false,
                        action:
                            message.payload.action,
                        step_index:
                            message.payload.step_index,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    }
                };

            sendToBackend(
                result
            );
        }
    }
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
}

async function handleAction(
    message: ActionCoordinatesMessage
): Promise<void> {

    const action =
        message.payload.action;

    try {

        if (
            action === "open_tab"
        ) {
            await handleOpenTab(
                message
            );

            return;
        }

        if (
            action === "navigate"
        ) {
            await handleNavigate(
                message
            );

            return;
        }

        if (
            action === "search"
        ) {
            await handleSearch(
                message
            );

            return;
        }

        if (
            action === "close_tab"
        ) {
            await handleCloseTab(
                message
            );

            return;
        }

        if (
            action === "switch_tab"
        ) {
            await handleSwitchTab(
                message
            );

            return;
        }

        const tabId =
            await resolveTabId(
                message
            );

        await ensureContentScript(
            tabId
        );

        await chrome.tabs.sendMessage(
            tabId,
            message
        );

    } catch (error) {

        const result:
            ActionResultMessage = {
                type:
                    "ACTION_RESULT",
                request_id:
                    message.request_id,
                action_id:
                    message.action_id,
                payload: {
                    success: false,
                    action:
                        message.payload.action,
                    step_index:
                        message.payload.step_index,
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error)
                }
            };

        sendToBackend(
            result
        );
    }
}

async function resolveTabId(
    message: ActionCoordinatesMessage
): Promise<number> {

    if (
        typeof message.tabId ===
        "number"
    ) {
        return message.tabId;
    }

    const tabs =
        await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

    const tab =
        tabs[0];

    if (
        !tab?.id
    ) {
        throw new Error(
            "No active tab found"
        );
    }

    return tab.id;
}

async function handleOpenTab(
    message: ActionCoordinatesMessage
): Promise<void> {

    const url =
        message.payload.url!;

    const tab =
        await chrome.tabs.create({
            url
        });

    const result:
        ActionResultMessage = {
        type:
            "ACTION_RESULT",
        request_id:
            message.request_id,
        action_id:
            message.action_id,
        payload: {
            success: true,
            action:
                "open_tab",
            step_index:
                message.payload.step_index,
            tab_id:
                tab.id
        }
    };

    sendToBackend(
        result
    );

    chrome.runtime.sendMessage(
        result
    );
}

async function handleNavigate(
    message: ActionCoordinatesMessage
): Promise<void> {

    const tabId =
        await resolveTabId(
            message
        );

    await chrome.tabs.update(
        tabId,
        {
            url:
                message.payload.url!
        }
    );

    const result:
        ActionResultMessage = {
        type:
            "ACTION_RESULT",
        request_id:
            message.request_id,
        action_id:
            message.action_id,
        payload: {
            success: true,
            action:
                "navigate",
            step_index:
                message.payload.step_index,
            tab_id:
                tabId
        }
    };

    sendToBackend(
        result
    );

    chrome.runtime.sendMessage(
        result
    );
}

async function handleSearch(
    message: ActionCoordinatesMessage
): Promise<void> {

    const query =
        message.payload.query!;

    const url =
        "https://duckduckgo.com/?q=" +
        encodeURIComponent(query);

    const tab =
        await chrome.tabs.create({
            url
        });

    const result:
        ActionResultMessage = {
        type:
            "ACTION_RESULT",
        request_id:
            message.request_id,
        action_id:
            message.action_id,
        payload: {
            success: true,
            action:
                "search",
            step_index:
                message.payload.step_index,
            tab_id:
                tab.id
        }
    };

    sendToBackend(
        result
    );

    chrome.runtime.sendMessage(
        result
    );
}

async function handleCloseTab(
    message: ActionCoordinatesMessage
): Promise<void> {

    const tabId =
        await resolveTabId(
            message
        );

    await chrome.tabs.remove(
        tabId
    );

    const result:
        ActionResultMessage = {
        type:
            "ACTION_RESULT",
        request_id:
            message.request_id,
        action_id:
            message.action_id,
        payload: {
            success: true,
            action:
                "close_tab",
            step_index:
                message.payload.step_index,
            tab_id:
                tabId
        }
    };

    sendToBackend(
        result
    );

    chrome.runtime.sendMessage(
        result
    );
}

async function handleSwitchTab(
    message: ActionCoordinatesMessage
): Promise<void> {

    const tabId =
        message.payload.tab_id!;

    await chrome.tabs.update(
        tabId,
        {
            active: true
        }
    );

    const result:
        ActionResultMessage = {
        type:
            "ACTION_RESULT",
        request_id:
            message.request_id,
        action_id:
            message.action_id,
        payload: {
            success: true,
            action:
                "switch_tab",
            step_index:
                message.payload.step_index,
            tab_id:
                tabId
        }
    };

    sendToBackend(
        result
    );

    chrome.runtime.sendMessage(
        result
    );
}

async function captureAndRedact(
    tabId: number
): Promise<void> {

    try {

        const dataUrl =
            await chrome.tabs.captureVisibleTab(
                {
                    format: "jpeg",
                    quality: 90
                }
            );

        await ensureContentScript(
            tabId
        );

        await chrome.tabs.sendMessage(
            tabId,
            {
                action:
                    "PROCESS_IMAGE",
                imageUri:
                    dataUrl
            }
        );

    } catch (error) {

        console.error(
            "[BG] Screenshot failed:",
            error
        );
    }
}

chrome.runtime.onMessage.addListener(
    (
        message: BackgroundMessage
    ) => {

        if (
            "action" in message &&
            message.action ===
                "Start_Redact"
        ) {

            captureAndRedact(
                message.tabId
            );

            return;
        }

        if (
            "action" in message &&
            message.action ===
                "REDACTION_COMPLETE"
        ) {

            const requestId =
                `req-${Date.now()}`;

            const sendScreenshot =
                async () => {

                    const tabs =
                        await chrome.tabs.query({
                            active: true,
                            currentWindow: true
                        });

                    const tab =
                        tabs[0];

                    if (!tab?.id) {
                        return;
                    }

                    const screenshot:
                        ScreenshotMessage = {
                        type:
                            "SCREENSHOT",
                        request_id:
                            requestId,
                        tab_id:
                            tab.id,
                        image:
                            message.sanitizedUri
                    };

                    sendToBackend(
                        screenshot
                    );

                    chrome.runtime.sendMessage({
                        action:
                            "SHOW_PREVIEW",
                        sanitizedUri:
                            message.sanitizedUri
                    });
                };

            sendScreenshot();

            return;
        }

        if (
            "type" in message &&
            message.type ===
                "ACTION_COORDINATES"
        ) {

            handleAction(
                message
            );

            return;
        }

        if (
            "type" in message &&
            message.type ===
                "ACTION_RESULT"
        ) {

            sendToBackend(
                message
            );

            chrome.runtime.sendMessage(
                message
            );

            return;
        }
    }
);

connectBackend();