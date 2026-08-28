console.log("[*] Privacy Guard Active");

interface ContentMessage {
	action: "PROCESS_IMAGE"
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
		console.log("[*] Processing image inside cs.ts");
		console.log('[Content Script] Image size received: ${message.imageUri.length} chars');
		redactScreenProcess(message.imageUri);
	}
});

async function redactScreenProcess(imageUri: string): Promise<void> {
	try {
		// phase 1
		const piiCoords = detectPii();
		console.log('[Content Script] Local detection found ${piiCoords.length} PII elements');

		// phase 2
		const sanitizedCanvas = await applyBlack(imageUri,piiCoords);

		// phase 3
		const sanitizedUri = sanitizedCanvas.toDataURL("image/jpeg", 0.9);
		console.log("[*] Redaction is completed --> Data Length :",sanitizedUri.length);

		// we send sanitizedUri to backend server
		
	} catch (error){
		console.error("[!] Redaction failed" ,error);	
	}
}

// pahse 1 DOM attri inspection 
