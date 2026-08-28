"use strict";
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "Start_Redact") {
        console.log('[bg] starting screen cap for tab : ${message.tabId}');
        captureAndRedact(message.tabId);
        return true;
    }
});
async function captureAndRedact(tabId) {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab({
            format: "jpeg",
            quality: 90
        });
        console.log("[bg] Screenshot captured successfully");
        console.log(`[bg] Base64 string length: ${dataUrl.length}`);
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ["dist/content.js"]
        });
        chrome.tabs.sendMessage(tabId, {
            actoin: "PROCESS_IMAGE",
            imageUri: dataUrl
        });
    }
    catch (error) {
        console.error("[bg] Failed to capture tab screenshot:", error);
    }
}
