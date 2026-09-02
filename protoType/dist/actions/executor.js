export async function executeContentAction(action, tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, {
            type: "AGENT_ACTION",
            action
        });
        if (!response ||
            typeof response.success !==
                "boolean") {
            return {
                success: false,
                action: action.action,
                step_index: action.step_index,
                tab_id: tabId,
                error: "Invalid response from content script"
            };
        }
        return {
            success: response.success,
            action: action.action,
            step_index: action.step_index,
            tab_id: tabId,
            error: response.error
        };
    }
    catch (error) {
        return {
            success: false,
            action: action.action,
            step_index: action.step_index,
            tab_id: tabId,
            error: error instanceof Error
                ? error.message
                : String(error)
        };
    }
}
