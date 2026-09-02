const statusBox = document.getElementById("status");
const startButton = document.getElementById("start");
const demoButton = document.getElementById("demo");
const screenshotButton = document.getElementById("screenshot");
const clickButton = document.getElementById("click");
const typeButton = document.getElementById("type");
const enterButton = document.getElementById("enter");
const scrollButton = document.getElementById("scroll");
function setStatus(message) {
    if (statusBox) {
        statusBox.textContent =
            message;
    }
}
async function getActiveTabId() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });
    if (!tabs[0] ||
        typeof tabs[0].id !==
            "number") {
        throw new Error("No active tab");
    }
    return tabs[0].id;
}
async function sendDemoAction(action) {
    const response = await chrome.runtime.sendMessage({
        type: "DEMO_ACTION",
        action
    });
    if (!response?.success) {
        throw new Error(response?.error ??
            "Demo action failed");
    }
}
if (startButton) {
    startButton.addEventListener("click", async () => {
        setStatus("Starting local screenshot test...");
        try {
            const response = await chrome.runtime.sendMessage({
                type: "START_AGENT"
            });
            if (response?.success) {
                setStatus("Screenshot sent to Varun. WebSocket must be running for this test.");
            }
            else {
                setStatus(response?.error ??
                    "Failed to start.");
            }
        }
        catch (error) {
            setStatus(error instanceof Error
                ? error.message
                : String(error));
        }
    });
}
if (demoButton) {
    demoButton.addEventListener("click", async () => {
        setStatus("Running local example...");
        try {
            const tabId = await getActiveTabId();
            const openAction = {
                action: "open_tab",
                url: "https://www.google.com",
                step_index: 0,
                is_last_step: true
            };
            await sendDemoAction(openAction);
            setStatus(`Example command sent for tab ${tabId}.`);
        }
        catch (error) {
            setStatus(error instanceof Error
                ? error.message
                : String(error));
        }
    });
}
if (screenshotButton) {
    screenshotButton.addEventListener("click", async () => {
        setStatus("Testing screenshot capture...");
        try {
            const response = await chrome.runtime.sendMessage({
                type: "LOCAL_SCREENSHOT_TEST"
            });
            if (response?.success) {
                setStatus(`Screenshot OK. Base64 length: ${response.length}`);
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
    });
}
if (clickButton) {
    clickButton.addEventListener("click", async () => {
        setStatus("Sending local click test...");
        try {
            await sendDemoAction({
                action: "click",
                x: 825,
                y: 360,
                step_index: 0,
                is_last_step: true
            });
            setStatus("Click command executed.");
        }
        catch (error) {
            setStatus(error instanceof Error
                ? error.message
                : String(error));
        }
    });
}
if (typeButton) {
    typeButton.addEventListener("click", async () => {
        setStatus("Sending local type test...");
        try {
            await sendDemoAction({
                action: "type",
                text: "ISRO",
                step_index: 0,
                is_last_step: true
            });
            setStatus("Type command executed.");
        }
        catch (error) {
            setStatus(error instanceof Error
                ? error.message
                : String(error));
        }
    });
}
if (enterButton) {
    enterButton.addEventListener("click", async () => {
        setStatus("Sending Enter test...");
        try {
            await sendDemoAction({
                action: "press",
                key: "Enter",
                step_index: 0,
                is_last_step: true
            });
            setStatus("Enter command executed.");
        }
        catch (error) {
            setStatus(error instanceof Error
                ? error.message
                : String(error));
        }
    });
}
if (scrollButton) {
    scrollButton.addEventListener("click", async () => {
        setStatus("Sending scroll test...");
        try {
            await sendDemoAction({
                action: "scroll",
                direction: "down",
                amount: 500,
                step_index: 0,
                is_last_step: true
            });
            setStatus("Scroll command executed.");
        }
        catch (error) {
            setStatus(error instanceof Error
                ? error.message
                : String(error));
        }
    });
}
setStatus("Ready for local testing.");
export {};
