"use strict";
(() => {
    const globalState = globalThis;
    if (globalState.__projectVisionContentScriptLoaded) {
        console.log("[CS] Already loaded");
        return;
    }
    globalState.__projectVisionContentScriptLoaded =
        true;
    console.log("[*] Privacy Guard Active");
    function isPingMessage(message) {
        return ("type" in message &&
            message.type === "PING");
    }
    function isContentMessage(message) {
        return ("action" in message &&
            message.action === "PROCESS_IMAGE");
    }
    function isActionCoordinatesMessage(message) {
        return ("type" in message &&
            message.type === "ACTION_COORDINATES");
    }
    function isVisible(element) {
        const htmlElement = element;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(htmlElement);
        return (rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0");
    }
    function getClickableElement(x, y) {
        const element = document.elementFromPoint(x, y);
        if (!(element instanceof HTMLElement)) {
            return null;
        }
        const clickable = element.closest("button, a, input, textarea, select, [role='button'], [role='link'], [tabindex]");
        if (clickable instanceof HTMLElement &&
            isVisible(clickable)) {
            return clickable;
        }
        return null;
    }
    function findInputAt(x, y) {
        const coordinateElement = document.elementFromPoint(x, y);
        if (coordinateElement instanceof HTMLElement) {
            const directInput = coordinateElement.closest("input:not([type='hidden']):not([type='password']), textarea, [contenteditable='true']");
            if (directInput instanceof HTMLElement &&
                isVisible(directInput) &&
                !directInput.hasAttribute("disabled")) {
                return directInput;
            }
        }
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
            const isInput = active instanceof HTMLInputElement &&
                active.type !== "hidden" &&
                active.type !== "password";
            const isTextarea = active instanceof HTMLTextAreaElement;
            const isContentEditable = active.isContentEditable;
            if ((isInput ||
                isTextarea ||
                isContentEditable) &&
                isVisible(active)) {
                return active;
            }
        }
        const selectors = [
            "input[type='search']",
            "input[type='text']",
            "textarea[name='q']",
            "textarea[aria-label*='Search' i]",
            "input[name='q']",
            "input[aria-label*='Search' i]"
        ];
        const candidates = new Set();
        for (const selector of selectors) {
            document
                .querySelectorAll(selector)
                .forEach((element) => {
                if (element instanceof HTMLElement &&
                    isVisible(element) &&
                    !element.hasAttribute("disabled")) {
                    candidates.add(element);
                }
            });
        }
        if (candidates.size === 1) {
            return [...candidates][0];
        }
        return null;
    }
    function setInputValue(element, text) {
        if (element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement) {
            const prototype = Object.getPrototypeOf(element);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
            if (descriptor?.set) {
                descriptor.set.call(element, text);
            }
            else {
                element.value =
                    text;
            }
            element.dispatchEvent(new Event("input", {
                bubbles: true
            }));
            element.dispatchEvent(new Event("change", {
                bubbles: true
            }));
            element.focus();
            return;
        }
        if (element.isContentEditable) {
            element.focus();
            element.textContent =
                text;
            element.dispatchEvent(new InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: text
            }));
        }
    }
    function normalizeKey(key) {
        const aliases = {
            enter: "Enter",
            return: "Enter",
            esc: "Escape",
            escape: "Escape",
            tab: "Tab",
            backspace: "Backspace",
            delete: "Delete",
            space: " ",
            arrowup: "ArrowUp",
            arrowdown: "ArrowDown",
            arrowleft: "ArrowLeft",
            arrowright: "ArrowRight"
        };
        return (aliases[key.toLowerCase()] ?? key);
    }
    function executeClick(x, y) {
        const element = getClickableElement(x, y);
        if (!element) {
            throw new Error("No clickable element found at coordinates");
        }
        element.click();
    }
    function executeType(x, y, text) {
        const input = findInputAt(x, y);
        if (!input) {
            throw new Error("No input element found at coordinates");
        }
        setInputValue(input, text);
    }
    function executePress(key) {
        const normalizedKey = normalizeKey(key);
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) {
            throw new Error("No active element available");
        }
        active.dispatchEvent(new KeyboardEvent("keydown", {
            key: normalizedKey,
            code: normalizedKey,
            bubbles: true,
            cancelable: true
        }));
        active.dispatchEvent(new KeyboardEvent("keyup", {
            key: normalizedKey,
            code: normalizedKey,
            bubbles: true,
            cancelable: true
        }));
        if (normalizedKey === "Enter" &&
            (active instanceof HTMLInputElement ||
                active instanceof HTMLTextAreaElement)) {
            active.form?.requestSubmit();
        }
    }
    function executeScroll(direction, amount) {
        const distance = direction === "down"
            ? amount
            : -amount;
        window.scrollBy({
            top: distance,
            behavior: "smooth"
        });
    }
    function validateAction(message) {
        const payload = message.payload;
        if (!payload) {
            throw new Error("Missing payload");
        }
        if (!Number.isInteger(payload.step_index) ||
            payload.step_index < 0) {
            throw new Error("Invalid step_index");
        }
        if (payload.action === "click" ||
            payload.action === "type") {
            if (typeof payload.x !== "number" ||
                typeof payload.y !== "number") {
                throw new Error("Missing coordinates");
            }
        }
        if (payload.action === "type" &&
            typeof payload.text !== "string") {
            throw new Error("Missing text");
        }
        if (payload.action === "press" &&
            typeof payload.key !== "string") {
            throw new Error("Missing key");
        }
        if (payload.action === "scroll" &&
            (payload.direction !== "up" &&
                payload.direction !== "down")) {
            throw new Error("Missing scroll direction");
        }
    }
    function executeAction(message) {
        const payload = message.payload;
        try {
            validateAction(message);
            switch (payload.action) {
                case "click":
                    executeClick(payload.x, payload.y);
                    break;
                case "type":
                    executeType(payload.x, payload.y, payload.text);
                    break;
                case "press":
                    executePress(payload.key);
                    break;
                case "scroll":
                    executeScroll(payload.direction, payload.amount ??
                        500);
                    break;
                default:
                    throw new Error(`Action ${payload.action} is handled by background`);
            }
            return {
                type: "ACTION_RESULT",
                request_id: message.request_id,
                action_id: message.action_id,
                payload: {
                    success: true,
                    action: payload.action,
                    step_index: payload.step_index
                }
            };
        }
        catch (error) {
            return {
                type: "ACTION_RESULT",
                request_id: message.request_id,
                action_id: message.action_id,
                payload: {
                    success: false,
                    action: payload.action,
                    step_index: payload.step_index,
                    error: error instanceof Error
                        ? error.message
                        : String(error)
                }
            };
        }
    }
    function redactScreenProcess(imageUri) {
        console.log(`[CS] Image size: ${imageUri.length} chars`);
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width =
                img.naturalWidth;
            canvas.height =
                img.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                console.error("[CS] Canvas unavailable");
                return;
            }
            ctx.drawImage(img, 0, 0);
            const selectors = [
                "input[type='email']",
                "input[type='password']",
                "input[name*='card' i]",
                "input[name*='phone' i]",
                "input[name*='ssn' i]",
                "input[name*='address' i]"
            ];
            const elements = document.querySelectorAll(selectors.join(","));
            const scaleX = canvas.width /
                window.innerWidth;
            const scaleY = canvas.height /
                window.innerHeight;
            for (const element of elements) {
                if (!(element instanceof HTMLElement)) {
                    continue;
                }
                const rect = element.getBoundingClientRect();
                ctx.fillStyle =
                    "black";
                ctx.fillRect(rect.left * scaleX, rect.top * scaleY, rect.width * scaleX, rect.height * scaleY);
            }
            const sanitizedUri = canvas.toDataURL("image/jpeg", 0.9);
            chrome.runtime.sendMessage({
                action: "REDACTION_COMPLETE",
                sanitizedUri
            });
        };
        img.onerror = () => {
            console.error("[CS] Screenshot load failed");
        };
        img.src =
            imageUri;
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (isPingMessage(message)) {
            sendResponse({
                success: true
            });
            return true;
        }
        if (isContentMessage(message)) {
            redactScreenProcess(message.imageUri);
            return true;
        }
        if (isActionCoordinatesMessage(message)) {
            const result = executeAction(message);
            chrome.runtime.sendMessage(result);
            return true;
        }
        return false;
    });
})();
