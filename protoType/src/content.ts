console.log("[Content Script] Loader inside web page");

interface ContentMessage {
	action: "PROCESS_IMAGE"
	imageUri: string;
}

chrome.runtime.onMessage.addListener((message: ContentMessage) => {
	if (message.action === "PROCESS_IMAGE") {
		console.log("[Content Script] Received image to redact");
		console.log('[Content Script] Image size received: ${message.imageUri.length} chars');
	}
});
