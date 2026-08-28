"use strict";
console.log("[Content Script] Loader inside web page");
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "PROCESS_IMAGE") {
        console.log("[Content Script] Received image to redact");
        console.log('[Content Script] Image size received: ${message.imageUri.length} chars');
    }
});
