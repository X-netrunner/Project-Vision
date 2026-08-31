"use strict";
console.log("[*] background worker active");
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "Start_Redact") {
        console.log(`[bg] starting screen cap for tab : ${message.tabId}`);
        captureAndRedact(message.tabId);
        return true;
    }
    if (message.action === "REDACTION_COMPLETE") {
        chrome.runtime.sendMessage({
            action: "SHOW_PREVIEW",
            sanitizedUri: message.sanitizedUri
        });
    }
});
async function captureAndRedact(tabId) {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab({
            format: "jpeg",
            quality: 90
        });
        console.log("[background] Screenshot captured successfully");
        console.log(`[background] Base64 string length: ${dataUrl.length}`);
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ["dist/cs.js"]
        });
        chrome.tabs.sendMessage(tabId, {
            action: "PROCESS_IMAGE",
            imageUri: dataUrl
        });
    }
    catch (error) {
        console.error("[background] Failed to capture tab screenshot:", error);
    }
}
