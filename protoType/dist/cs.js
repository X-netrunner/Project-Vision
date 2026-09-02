"use strict";
(() => {
    const globalState = globalThis;
    if (globalState.__projectVisionContentScriptLoaded) {
        return;
    }
    globalState.__projectVisionContentScriptLoaded =
        true;
    function isPingMessage(message) {
        return message.type === "PING";
    }
    function isActionMessage(message) {
        return (message.type ===
            "AGENT_ACTION");
    }
    function findElementAt(x, y) {
        const element = document.elementFromPoint(x, y);
        return element instanceof
            HTMLElement
            ? element
            : null;
    }
    function findClickableElement(element) {
        const clickable = element.closest("button, a, input, textarea, select, [role='button'], [role='link'], [onclick]");
        return clickable instanceof
            HTMLElement
            ? clickable
            : element;
    }
    function setInputValue(element, value) {
        const prototype = element instanceof
            HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) {
            descriptor.set.call(element, value);
        }
        else {
            element.value = value;
        }
        element.dispatchEvent(new Event("input", {
            bubbles: true,
            composed: true
        }));
        element.dispatchEvent(new Event("change", {
            bubbles: true,
            composed: true
        }));
    }
    function findTextInput() {
        const active = document.activeElement;
        if (active instanceof
            HTMLInputElement ||
            active instanceof
                HTMLTextAreaElement ||
            (active instanceof
                HTMLElement &&
                active.isContentEditable)) {
            return active;
        }
        const selectors = [
            "input[type='search']",
            "input[type='text']",
            "textarea[name='q']",
            "textarea[aria-label*='Search' i]",
            "input[name='q']",
            "input[aria-label*='Search' i]",
            "textarea",
            "input:not([type='hidden'])"
        ];
        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element instanceof
                HTMLElement) {
                return element;
            }
        }
        return null;
    }
    function performClick(x, y) {
        const element = findElementAt(x, y);
        if (!element) {
            throw new Error(`No element found at (${x}, ${y})`);
        }
        const clickable = findClickableElement(element);
        clickable.scrollIntoView({
            block: "center",
            inline: "center"
        });
        clickable.click();
    }
    function performType(text, x, y) {
        let element = null;
        if (typeof x === "number" &&
            typeof y === "number") {
            element =
                findElementAt(x, y);
        }
        if (!element) {
            element =
                findTextInput();
        }
        if (!element) {
            throw new Error("No input element found");
        }
        if (element instanceof
            HTMLInputElement ||
            element instanceof
                HTMLTextAreaElement) {
            element.focus();
            setInputValue(element, text);
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
            return;
        }
        throw new Error("Element is not a text input");
    }
    function performPress(key) {
        const target = document.activeElement instanceof
            HTMLElement
            ? document.activeElement
            : document.body;
        target.dispatchEvent(new KeyboardEvent("keydown", {
            key,
            code: key,
            bubbles: true,
            cancelable: true
        }));
        target.dispatchEvent(new KeyboardEvent("keyup", {
            key,
            code: key,
            bubbles: true,
            cancelable: true
        }));
        if (key === "Enter") {
            const form = target.closest("form");
            if (form instanceof
                HTMLFormElement) {
                if (typeof form.requestSubmit ===
                    "function") {
                    form.requestSubmit();
                }
                else {
                    form.submit();
                }
            }
        }
    }
    function performScroll(direction, amount) {
        const distance = direction === "down"
            ? amount
            : -amount;
        window.scrollBy({
            top: distance,
            left: 0,
            behavior: "smooth"
        });
    }
    async function executeAction(action) {
        try {
            switch (action.action) {
                case "click":
                    if (typeof action.x !==
                        "number" ||
                        typeof action.y !==
                            "number") {
                        throw new Error("Click requires x and y");
                    }
                    performClick(action.x, action.y);
                    break;
                case "type":
                    if (typeof action.text !==
                        "string") {
                        throw new Error("Type requires text");
                    }
                    performType(action.text, action.x, action.y);
                    break;
                case "press":
                    if (typeof action.key !==
                        "string") {
                        throw new Error("Press requires key");
                    }
                    performPress(action.key);
                    break;
                case "scroll":
                    if (!action.direction ||
                        typeof action.amount !==
                            "number") {
                        throw new Error("Scroll requires direction and amount");
                    }
                    performScroll(action.direction, action.amount);
                    break;
                case "open_tab":
                case "navigate":
                case "search":
                case "close_tab":
                case "switch_tab":
                    throw new Error(`${action.action} is handled by the background service worker`);
            }
            return {
                success: true
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error)
            };
        }
    }
    chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
        const message = rawMessage;
        if (isPingMessage(message)) {
            sendResponse({
                success: true
            });
            return true;
        }
        if (isActionMessage(message)) {
            executeAction(message.action)
                .then((result) => {
                sendResponse(result);
            })
                .catch((error) => {
                sendResponse({
                    success: false,
                    error: error instanceof
                        Error
                        ? error.message
                        : String(error)
                });
            });
            return true;
        }
        return false;
    });
    console.log("[Project-Vision] Content script ready");
})();
