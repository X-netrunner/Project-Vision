export function validateAction(message) {
    const payload = message.payload;
    if (!payload) {
        throw new Error("Missing payload");
    }
    if (payload.action !== "click" &&
        payload.action !== "type" &&
        payload.action !== "press" &&
        payload.action !== "scroll" &&
        payload.action !== "open_tab" &&
        payload.action !== "navigate" &&
        payload.action !== "search" &&
        payload.action !== "close_tab" &&
        payload.action !== "switch_tab") {
        throw new Error("Invalid action");
    }
    if (!Number.isInteger(payload.step_index) ||
        payload.step_index < 0) {
        throw new Error("Invalid step_index");
    }
    if (payload.action === "click" ||
        payload.action === "type") {
        if (typeof payload.x !== "number" ||
            typeof payload.y !== "number" ||
            !Number.isFinite(payload.x) ||
            !Number.isFinite(payload.y)) {
            throw new Error("Action requires valid x and y coordinates");
        }
    }
    if (payload.action === "type") {
        if (typeof payload.text !== "string") {
            throw new Error("Type action requires text");
        }
    }
    if (payload.action === "press") {
        if (typeof payload.key !== "string") {
            throw new Error("Press action requires key");
        }
    }
    if (payload.action === "scroll") {
        if (payload.direction !== "up" &&
            payload.direction !== "down") {
            throw new Error("Scroll action requires direction");
        }
        if (payload.amount !== undefined &&
            (typeof payload.amount !== "number" ||
                !Number.isFinite(payload.amount) ||
                payload.amount <= 0)) {
            throw new Error("Invalid scroll amount");
        }
    }
    if (payload.action === "open_tab" ||
        payload.action === "navigate") {
        if (typeof payload.url !== "string" ||
            payload.url.trim() === "") {
            throw new Error(`${payload.action} requires url`);
        }
    }
    if (payload.action === "search") {
        if (typeof payload.query !== "string" ||
            payload.query.trim() === "") {
            throw new Error("Search action requires query");
        }
    }
    if (payload.action === "switch_tab") {
        if (typeof payload.tab_id !== "number" ||
            !Number.isInteger(payload.tab_id)) {
            throw new Error("switch_tab requires tab_id");
        }
    }
}
