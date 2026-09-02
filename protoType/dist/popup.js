"use strict";
const captureBtn = document.getElementById("captureBtn");
const testClick = document.getElementById("testClick");
const testType = document.getElementById("testType");
const testEnter = document.getElementById("testEnter");
const testScrollDown = document.getElementById("testScrollDown");
const testScrollUp = document.getElementById("testScrollUp");
const testOpenTab = document.getElementById("testOpenTab");
const testSearch = document.getElementById("testSearch");
const testNavigate = document.getElementById("testNavigate");
const testInvalid = document.getElementById("testInvalid");
const previewImg = document.getElementById("preview");
const statusBox = document.getElementById("status");
async function getActiveTab() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });
    return tabs[0];
}
function showStatus(text) {
    statusBox.textContent =
        text;
}
function sendAction(payload) {
    chrome.runtime.sendMessage({
        type: "ACTION_COORDINATES",
        request_id: `test-${Date.now()}`,
        action_id: `test-${Date.now()}`,
        payload
    });
}
captureBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) {
        showStatus("No active tab");
        return;
    }
    showStatus("Capturing...");
    chrome.runtime.sendMessage({
        action: "Start_Redact",
        tabId: tab.id
    });
});
testClick.addEventListener("click", () => {
    sendAction({
        action: "click",
        x: 825,
        y: 360,
        step_index: 0,
        is_last_step: true
    });
});
testType.addEventListener("click", () => {
    sendAction({
        action: "type",
        x: 825,
        y: 360,
        text: "PS4 controller",
        step_index: 0,
        is_last_step: true
    });
});
testEnter.addEventListener("click", () => {
    sendAction({
        action: "press",
        key: "Enter",
        step_index: 0,
        is_last_step: true
    });
});
testScrollDown.addEventListener("click", () => {
    sendAction({
        action: "scroll",
        direction: "down",
        amount: 500,
        step_index: 0,
        is_last_step: true
    });
});
testScrollUp.addEventListener("click", () => {
    sendAction({
        action: "scroll",
        direction: "up",
        amount: 500,
        step_index: 0,
        is_last_step: true
    });
});
testOpenTab.addEventListener("click", () => {
    sendAction({
        action: "open_tab",
        url: "https://duckduckgo.com/",
        step_index: 0,
        is_last_step: true
    });
});
testSearch.addEventListener("click", () => {
    sendAction({
        action: "search",
        query: "PS4 controller",
        step_index: 0,
        is_last_step: true
    });
});
testNavigate.addEventListener("click", () => {
    sendAction({
        action: "navigate",
        url: "https://duckduckgo.com/",
        step_index: 0,
        is_last_step: true
    });
});
testInvalid.addEventListener("click", () => {
    sendAction({
        action: "invalid_action",
        step_index: 0,
        is_last_step: true
    });
});
chrome.runtime.onMessage.addListener((message) => {
    if ("action" in message &&
        message.action ===
            "SHOW_PREVIEW") {
        previewImg.src =
            message.sanitizedUri;
        previewImg.style.display =
            "block";
        showStatus("Sanitized screenshot received");
        return;
    }
    if ("type" in message &&
        message.type ===
            "ACTION_RESULT") {
        const result = message.payload;
        if (result.success) {
            showStatus(`[SUCCESS] ${result.action} | Step ${result.step_index}`);
        }
        else {
            showStatus(`[FAILED] ${result.action} | Step ${result.step_index} | ${result.error}`);
        }
    }
});
