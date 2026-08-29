const captureBtn = document.getElementById("captureBtn") as HTMLButtonElement;

captureBtn.addEventListener("click", async () => {
	console.log("Button clicked! Requesting active tab screenshot...");

	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

	if ( tab?.id)
	{
		chrome.runtime.sendMessage({ action: "Start_Redact", tabId: tab.id});
	}
})
