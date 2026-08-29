"use strict";
console.log("[*] Privacy Guard Active");
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "PROCESS_IMAGE") {
        console.log("[*] Processing image inside content script");
        console.log(`[Content Script] Image size received: ${message.imageUri.length} chars`);
        redactScreenProcess(message.imageUri);
    }
});
async function redactScreenProcess(imageUri) {
    try {
        // Phase 1: DOM Hints
        const piiCoords = detectPii();
        console.log(`[Content Script] Local detection found ${piiCoords.length} PII elements`);
        // Phase 2: Canvas Blackout
        const sanitizedCanvas = await applyBlack(imageUri, piiCoords);
        // Phase 3: Export Data URL
        const sanitizedUri = sanitizedCanvas.toDataURL("image/jpeg", 0.9);
        console.log("[*] Redaction completed --> Data Length:", sanitizedUri.length);
        // Next step: send sanitizedUri to backend server
    }
    catch (error) {
        console.error("[!] Redaction failed", error);
    }
}
// Phase 1: DOM Attribute Inspection
function detectPii() {
    const coords = [];
    const selectors = [
        'input[type="password"]',
        'input[type="email"]',
        'input[name*="card"]',
        'input[autocomplete="cc-number"]',
        'input[autocomplete*="address"]'
    ];
    const elements = document.querySelectorAll(selectors.join(","));
    elements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            coords.push({
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
                label: el.type || 'unknown-pii'
            });
        }
    });
    return coords;
}
// Phase 2: Canvas Drawing Logic
async function applyBlack(rawImageUri, masks) {
    const img = new Image();
    img.src = rawImageUri;
    await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (err) => reject(`Image load error: ${err}`);
    });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = "black";
    masks.forEach((mask) => {
        ctx.fillRect(mask.x, mask.y, mask.width, mask.height);
    });
    return canvas;
}
