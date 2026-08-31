"use strict";
const captureBtn = document.getElementById("captureBtn");
const previewImg = document.getElementById("preview");
captureBtn.addEventListener("click", async () => {
    console.log("[*] Button clicked! Requesting active tab screenshot...");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
        chrome.runtime.sendMessage({ action: "Start_Redact", tabId: tab.id });
    }
});
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "SHOW_PREVIEW" && message.sanitizedUri) {
        console.log("[*] Preview received in popup");
        previewImg.src = message.sanitizedUri;
        previewImg.style.display = "block";
    }
});
