console.log("[*] Privacy Guard Active");

interface ContentMessage {
    action: "PROCESS_IMAGE";
    imageUri: string;
}

interface PiiCoord {
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
}

chrome.runtime.onMessage.addListener((message: ContentMessage) => {
    if (message.action === "PROCESS_IMAGE") {
        console.log("[*] Processing image inside content script");
        console.log(`[Content Script] Image size received: ${message.imageUri.length} chars`);
        redactScreenProcess(message.imageUri);
    }
});

async function redactScreenProcess(imageUri: string): Promise<void> {
    try {
        // Phase 1: DOM Hints
        const piiCoords = detectPii();
        console.log(`[Content Script] Local detection found ${piiCoords.length} PII elements`);

        // Phase 2: Canvas Blackout
        const sanitizedCanvas = await applyBlack(imageUri, piiCoords);

        // Phase 3: Export Data URL
        const sanitizedUri = sanitizedCanvas.toDataURL("image/jpeg", 0.9);
        console.log("[*] Redaction completed --> Data Length:", sanitizedUri.length);				
		chrome.runtime.sendMessage({
		  action: "[*] ReDACTION_COMPLETE",
		  sanitizedUri: sanitizedUri
		});
        // Next step: send sanitizedUri to backend server

    } catch (error) {
        console.error("[!] Redaction failed", error);
    }
}

// Phase 1: DOM Attribute Inspection
function detectPii(): PiiCoord[] {
    const coords: PiiCoord[] = [];
    const selectors = [
        'input[type="password"]',
        'input[type="email"]',
        'input[name*="card"]', 
        'input[autocomplete="cc-number"]', 
        'input[autocomplete*="address"]'
    ];
    
    const elements = document.querySelectorAll<HTMLElement>(selectors.join(","));

    elements.forEach((el) => {
        const rect = el.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
            coords.push({
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
                label: (el as HTMLInputElement).type || 'unknown-pii'
            });
        }
    });

    return coords;
}

// Phase 2: Canvas Drawing Logic
async function applyBlack(rawImageUri: string, masks: PiiCoord[]): Promise<HTMLCanvasElement> {
    const img = new Image();
    img.src = rawImageUri;

    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (err) => reject(`Image load error: ${err}`);
    });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

    canvas.width = img.width;
    canvas.height = img.height;

    ctx.drawImage(img, 0, 0);

    ctx.fillStyle = "black";
    masks.forEach((mask) => {
        ctx.fillRect(mask.x, mask.y, mask.width, mask.height);
    });

    return canvas;
}
