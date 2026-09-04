"use strict";
(() => {
    const globalState = globalThis;
    if (globalState.__projectVisionContentScriptLoaded) {
        return;
    }
    globalState.__projectVisionContentScriptLoaded = true;
    /* -------------------------------------------------------------------------- */
    /*                                BASIC HELPERS                               */
    /* -------------------------------------------------------------------------- */
    function isFiniteNumber(value) {
        return (typeof value === "number" &&
            Number.isFinite(value));
    }
    function safeFocus(element) {
        try {
            element.focus({
                preventScroll: true,
            });
        }
        catch {
            try {
                element.focus();
            }
            catch {
                // Some browser-internal/custom elements can reject focus.
            }
        }
    }
    function isElementDisabled(element) {
        if (element instanceof HTMLButtonElement &&
            element.disabled) {
            return true;
        }
        if (element instanceof HTMLInputElement &&
            element.disabled) {
            return true;
        }
        if (element instanceof HTMLTextAreaElement &&
            element.disabled) {
            return true;
        }
        if (element instanceof HTMLSelectElement &&
            element.disabled) {
            return true;
        }
        if (element instanceof HTMLOptGroupElement &&
            element.disabled) {
            return true;
        }
        if (element.hasAttribute("disabled")) {
            return true;
        }
        if (element.getAttribute("aria-disabled") === "true") {
            return true;
        }
        /*
         * A disabled fieldset disables its descendants except
         * descendants inside the fieldset's first legend.
         */
        const disabledFieldset = element.closest("fieldset[disabled]");
        if (disabledFieldset instanceof HTMLFieldSetElement) {
            const firstLegend = disabledFieldset.querySelector(":scope > legend");
            if (!(firstLegend instanceof HTMLElement) ||
                !firstLegend.contains(element)) {
                return true;
            }
        }
        return false;
    }
    function isVisible(element) {
        if (!element.isConnected) {
            return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.pointerEvents === "none" ||
            Number(style.opacity) === 0) {
            return false;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 ||
            rect.height <= 0) {
            return false;
        }
        /*
         * Hidden ancestors are already handled by the browser's
         * computed style in most cases, but checking the chain makes
         * behavior more reliable on unusual sites.
         */
        let current = element;
        while (current && current !== document.documentElement) {
            const currentStyle = window.getComputedStyle(current);
            if (currentStyle.display === "none" ||
                currentStyle.visibility === "hidden" ||
                currentStyle.visibility === "collapse") {
                return false;
            }
            current = current.parentElement;
        }
        return true;
    }
    function isPointInViewport(x, y) {
        return (x >= 0 &&
            y >= 0 &&
            x < window.innerWidth &&
            y < window.innerHeight);
    }
    /* -------------------------------------------------------------------------- */
    /*                              SHADOW DOM SUPPORT                            */
    /* -------------------------------------------------------------------------- */
    /*
     * Explicit return type is important here.
     *
     * Without it, TypeScript can sometimes infer recursive Shadow DOM
     * expressions as `any`, resulting in TS7022.
     */
    function getElementInsideShadowRoot(root, x, y) {
        let current = root.elementFromPoint(x, y);
        /*
         * Walk through nested open shadow roots.
         */
        while (current instanceof HTMLElement ||
            current instanceof SVGElement) {
            const host = current;
            const shadowRoot = host instanceof HTMLElement
                ? host.shadowRoot
                : null;
            if (!shadowRoot) {
                break;
            }
            const shadowElement = shadowRoot.elementFromPoint(x, y);
            if (!shadowElement ||
                shadowElement === current) {
                break;
            }
            current = shadowElement;
        }
        return current;
    }
    function getElementAtPoint(x, y) {
        if (!isFiniteNumber(x) ||
            !isFiniteNumber(y)) {
            return null;
        }
        if (!isPointInViewport(x, y)) {
            return null;
        }
        let element = document.elementFromPoint(x, y);
        if (!element) {
            return null;
        }
        /*
         * Descend through nested open Shadow DOM trees.
         *
         * This is deliberately iterative rather than recursively
         * calling getElementAtPoint().
         */
        for (let depth = 0; depth < 20; depth++) {
            if (!(element instanceof HTMLElement)) {
                break;
            }
            const shadowRoot = element.shadowRoot;
            if (!shadowRoot) {
                break;
            }
            const shadowElement = getElementInsideShadowRoot(shadowRoot, x, y);
            if (!shadowElement ||
                shadowElement === element) {
                break;
            }
            element = shadowElement;
        }
        return element;
    }
    /* -------------------------------------------------------------------------- */
    /*                             ELEMENT DISCOVERY                              */
    /* -------------------------------------------------------------------------- */
    function getParentElement(element) {
        if (element.parentElement) {
            return element.parentElement;
        }
        /*
         * If we are inside Shadow DOM, parentElement becomes null at
         * the shadow root boundary. Recover the host.
         */
        const root = element.getRootNode();
        if (root instanceof ShadowRoot) {
            return root.host;
        }
        return null;
    }
    function isClickableElement(element) {
        const tag = element.tagName.toLowerCase();
        if (tag === "button" ||
            tag === "a" ||
            tag === "input" ||
            tag === "select" ||
            tag === "summary") {
            return true;
        }
        const role = element.getAttribute("role");
        if (role === "button" ||
            role === "link" ||
            role === "checkbox" ||
            role === "radio" ||
            role === "switch" ||
            role === "tab" ||
            role === "option" ||
            role === "menuitem" ||
            role === "menuitemcheckbox" ||
            role === "menuitemradio") {
            return true;
        }
        if (element.hasAttribute("onclick")) {
            return true;
        }
        if (element.hasAttribute("tabindex") &&
            element.getAttribute("tabindex") !== "-1") {
            return true;
        }
        /*
         * Elements commonly used as custom controls.
         */
        if (element.hasAttribute("data-testid") &&
            (element.hasAttribute("aria-label") ||
                element.hasAttribute("aria-labelledby"))) {
            return true;
        }
        return false;
    }
    function findClickableElement(element) {
        if (!element) {
            return null;
        }
        let current = element;
        /*
         * Walk up through normal DOM and Shadow DOM boundaries.
         */
        for (let depth = 0; current && depth < 100; depth++) {
            if (current instanceof HTMLElement &&
                isClickableElement(current)) {
                return current;
            }
            current =
                getParentElement(current);
        }
        return null;
    }
    function pointIsInsideElement(element, x, y) {
        const rect = element.getBoundingClientRect();
        return (x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom);
    }
    function getTopmostClickableAtPoint(x, y) {
        const actual = getElementAtPoint(x, y);
        if (!actual) {
            return null;
        }
        return findClickableElement(actual);
    }
    function verifyClickTarget(element, x, y) {
        if (!element.isConnected) {
            return false;
        }
        if (!isVisible(element)) {
            return false;
        }
        if (!pointIsInsideElement(element, x, y)) {
            return false;
        }
        const actual = getElementAtPoint(x, y);
        if (!actual) {
            return false;
        }
        const actualClickable = findClickableElement(actual);
        /*
         * Normal case.
         */
        if (actualClickable === element) {
            return true;
        }
        /*
         * If the coordinate landed on a child of the intended
         * clickable, it is still valid.
         */
        if (element.contains(actual)) {
            return true;
        }
        /*
         * Labels are special: clicking their child text should
         * activate the associated control.
         */
        if (element instanceof HTMLLabelElement &&
            element.contains(actual)) {
            return true;
        }
        return false;
    }
    /* -------------------------------------------------------------------------- */
    /*                                  CLICK                                     */
    /* -------------------------------------------------------------------------- */
    function createPointerEvent(type, x, y, buttons) {
        return new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            detail: 1,
            clientX: x,
            clientY: y,
            screenX: window.screenX + x,
            screenY: window.screenY + y,
            button: 0,
            buttons,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
        });
    }
    function dispatchMouseClick(element, x, y) {
        try {
            element.dispatchEvent(createPointerEvent("pointerover", x, y, 0));
            element.dispatchEvent(createPointerEvent("pointerenter", x, y, 0));
            element.dispatchEvent(createPointerEvent("pointermove", x, y, 0));
            const pointerDownAllowed = element.dispatchEvent(createPointerEvent("pointerdown", x, y, 1));
            element.dispatchEvent(new MouseEvent("mouseover", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                detail: 1,
                clientX: x,
                clientY: y,
                screenX: window.screenX + x,
                screenY: window.screenY + y,
                button: 0,
                buttons: 0,
            }));
            element.dispatchEvent(new MouseEvent("mousemove", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                detail: 1,
                clientX: x,
                clientY: y,
                screenX: window.screenX + x,
                screenY: window.screenY + y,
                button: 0,
                buttons: 1,
            }));
            const mouseDownAllowed = element.dispatchEvent(new MouseEvent("mousedown", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                detail: 1,
                clientX: x,
                clientY: y,
                screenX: window.screenX + x,
                screenY: window.screenY + y,
                button: 0,
                buttons: 1,
            }));
            element.dispatchEvent(createPointerEvent("pointerup", x, y, 0));
            element.dispatchEvent(new MouseEvent("mouseup", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                detail: 1,
                clientX: x,
                clientY: y,
                screenX: window.screenX + x,
                screenY: window.screenY + y,
                button: 0,
                buttons: 0,
            }));
            const clickAllowed = element.dispatchEvent(new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                detail: 1,
                clientX: x,
                clientY: y,
                screenX: window.screenX + x,
                screenY: window.screenY + y,
                button: 0,
                buttons: 0,
            }));
            return (pointerDownAllowed &&
                mouseDownAllowed &&
                clickAllowed);
        }
        catch {
            return false;
        }
    }
    function clickAt(x, y) {
        if (!isFiniteNumber(x) ||
            !isFiniteNumber(y)) {
            return {
                success: false,
                error: "Click requires valid numeric x and y coordinates",
            };
        }
        if (!isPointInViewport(x, y)) {
            return {
                success: false,
                error: `Coordinates (${x}, ${y}) are outside the ` +
                    `current viewport (${window.innerWidth}x${window.innerHeight})`,
            };
        }
        const element = getElementAtPoint(x, y);
        if (!element) {
            return {
                success: false,
                error: `No element found at (${x}, ${y})`,
            };
        }
        /*
         * If the coordinate lands on an iframe itself, we cannot
         * automatically enter a cross-origin iframe from this
         * document. The background/content-script architecture must
         * have a content script running inside that frame.
         */
        if (element instanceof HTMLIFrameElement) {
            return {
                success: false,
                error: "Coordinates point to an iframe. The target must be handled by the content script running inside that frame.",
            };
        }
        const clickable = findClickableElement(element);
        if (!clickable) {
            return {
                success: false,
                error: `Element at (${x}, ${y}) is not clickable`,
            };
        }
        if (isElementDisabled(clickable)) {
            return {
                success: false,
                error: "Target element is disabled",
            };
        }
        if (!isVisible(clickable)) {
            return {
                success: false,
                error: "Target element is not visible",
            };
        }
        if (!verifyClickTarget(clickable, x, y)) {
            /*
             * Some websites place transparent overlays over controls
             * during animations. Give the coordinate one final lookup
             * rather than blindly clicking a stale element.
             */
            const latest = getTopmostClickableAtPoint(x, y);
            if (!latest ||
                latest !== clickable) {
                return {
                    success: false,
                    error: "Target moved or is covered by another element",
                };
            }
        }
        safeFocus(clickable);
        /*
         * Native controls should use the browser's native activation
         * whenever possible. This is much more reliable than manually
         * recreating every browser event.
         */
        try {
            clickable.click();
            return {
                success: true,
            };
        }
        catch {
            /*
             * Some custom elements can throw from `.click()`.
             * Fall back to a complete mouse/pointer sequence.
             */
            const dispatched = dispatchMouseClick(clickable, x, y);
            if (dispatched) {
                return {
                    success: true,
                };
            }
            return {
                success: false,
                error: "Unable to activate the target element",
            };
        }
    }
    /* -------------------------------------------------------------------------- */
    /*                              TEXT INPUTS                                  */
    /* -------------------------------------------------------------------------- */
    function isTextInput(element) {
        if (element instanceof HTMLTextAreaElement) {
            return true;
        }
        if (element instanceof HTMLInputElement) {
            const type = element.type.toLowerCase();
            return (type !== "hidden" &&
                type !== "checkbox" &&
                type !== "radio" &&
                type !== "button" &&
                type !== "submit" &&
                type !== "reset" &&
                type !== "file" &&
                type !== "range" &&
                type !== "color" &&
                type !== "image");
        }
        return false;
    }
    function isContentEditable(element) {
        if (!(element instanceof HTMLElement)) {
            return false;
        }
        return (element.isContentEditable ||
            element.getAttribute("contenteditable") === "true" ||
            element.getAttribute("contenteditable") === "plaintext-only");
    }
    function hasTextboxRole(element) {
        if (!(element instanceof HTMLElement)) {
            return false;
        }
        const role = element.getAttribute("role");
        return (role === "textbox" ||
            role === "searchbox");
    }
    function isSupportedTextInput(element) {
        return (isTextInput(element) ||
            isContentEditable(element) ||
            hasTextboxRole(element));
    }
    function findTextInputAtPoint(x, y) {
        const element = getElementAtPoint(x, y);
        if (!element) {
            return null;
        }
        if (isSupportedTextInput(element)) {
            return element;
        }
        /*
         * Walk upward through Shadow DOM and normal DOM.
         */
        let current = element;
        for (let depth = 0; current && depth < 100; depth++) {
            if (current instanceof HTMLElement &&
                isSupportedTextInput(current)) {
                return current;
            }
            current =
                getParentElement(current);
        }
        /*
         * Search common wrapper structures.
         */
        if (element instanceof HTMLElement) {
            const closestInput = element.closest("textarea, input, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox'], [role='searchbox']");
            if (closestInput instanceof HTMLElement &&
                isSupportedTextInput(closestInput)) {
                return closestInput;
            }
        }
        return null;
    }
    function findFocusedTextInput() {
        const active = document.activeElement;
        if (active instanceof HTMLElement &&
            isSupportedTextInput(active)) {
            return active;
        }
        return null;
    }
    function getNativeValueSetter(element) {
        const prototype = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor &&
            typeof descriptor.set === "function") {
            return descriptor.set.bind(element);
        }
        return null;
    }
    function dispatchInputEvents(element, text, previousValue) {
        /*
         * beforeinput
         */
        try {
            element.dispatchEvent(new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                composed: true,
                inputType: "insertText",
                data: text,
            }));
        }
        catch {
            // Older browsers.
        }
        /*
         * input
         */
        try {
            element.dispatchEvent(new InputEvent("input", {
                bubbles: true,
                cancelable: false,
                composed: true,
                inputType: "insertText",
                data: text,
            }));
        }
        catch {
            element.dispatchEvent(new Event("input", {
                bubbles: true,
                composed: true,
            }));
        }
        /*
         * change
         */
        try {
            element.dispatchEvent(new Event("change", {
                bubbles: true,
                composed: true,
            }));
        }
        catch {
            // Ignore sites with unusual event implementations.
        }
        /*
         * React/Vue/etc. occasionally inspect the actual DOM value
         * immediately after the input event. Reading it here also
         * ensures the browser has accepted the update.
         */
        void previousValue;
    }
    function setNativeInputValue(element, text) {
        const previousValue = element.value;
        const setter = getNativeValueSetter(element);
        if (setter) {
            setter(text);
        }
        else {
            element.value = text;
        }
        /*
         * Some frameworks track value changes using an internal
         * value tracker. Clear/update it when available.
         */
        const trackerHost = element;
        try {
            trackerHost._valueTracker?.setValue?.(previousValue);
        }
        catch {
            // Not all frameworks expose this.
        }
        /*
         * Restore the desired value after tracker manipulation.
         */
        if (element.value !== text) {
            if (setter) {
                setter(text);
            }
            else {
                element.value = text;
            }
        }
        dispatchInputEvents(element, text, previousValue);
    }
    function setContentEditableValue(element, text) {
        safeFocus(element);
        /*
         * Select the existing content so browser/framework selection
         * state matches what a user would normally see.
         */
        try {
            const selection = window.getSelection();
            if (selection) {
                const range = document.createRange();
                range.selectNodeContents(element);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
        catch {
            // Selection APIs may fail on unusual custom elements.
        }
        try {
            element.dispatchEvent(new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                composed: true,
                inputType: "insertText",
                data: text,
            }));
        }
        catch {
            // Ignore.
        }
        /*
         * Prefer textContent for predictable plain-text behavior.
         * This is particularly useful for Google-style contenteditable
         * fields and custom textbox implementations.
         */
        element.textContent = text;
        try {
            element.dispatchEvent(new InputEvent("input", {
                bubbles: true,
                cancelable: false,
                composed: true,
                inputType: "insertText",
                data: text,
            }));
        }
        catch {
            element.dispatchEvent(new Event("input", {
                bubbles: true,
                composed: true,
            }));
        }
        try {
            element.dispatchEvent(new Event("change", {
                bubbles: true,
                composed: true,
            }));
        }
        catch {
            // Ignore.
        }
    }
    function typeIntoElement(text, x, y) {
        if (typeof text !== "string") {
            return {
                success: false,
                error: "Type action requires text",
            };
        }
        let element = null;
        const coordinatesProvided = x !== undefined ||
            y !== undefined;
        /*
         * IMPORTANT:
         * If coordinates are supplied, they take priority.
         *
         * This prevents the agent from accidentally typing into
         * whatever happened to be focused when it intended to target
         * a specific field.
         */
        if (coordinatesProvided) {
            if (!isFiniteNumber(x) ||
                !isFiniteNumber(y)) {
                return {
                    success: false,
                    error: "Type coordinates must both be valid numbers",
                };
            }
            if (!isPointInViewport(x, y)) {
                return {
                    success: false,
                    error: `Type coordinates (${x}, ${y}) are outside the ` +
                        `current viewport (${window.innerWidth}x${window.innerHeight})`,
                };
            }
            element =
                findTextInputAtPoint(x, y);
            if (!element) {
                const target = getElementAtPoint(x, y);
                const tag = target instanceof HTMLElement ||
                    target instanceof SVGElement
                    ? target.tagName.toLowerCase()
                    : "unknown";
                return {
                    success: false,
                    error: `Coordinates (${x}, ${y}) point to ${tag}, not a supported text input`,
                };
            }
        }
        /*
         * If no coordinates were supplied, use the currently focused
         * input.
         */
        if (!element) {
            element =
                findFocusedTextInput();
        }
        if (!element) {
            return {
                success: false,
                error: "No text input found. Provide x/y coordinates or focus an input first.",
            };
        }
        if (isElementDisabled(element)) {
            return {
                success: false,
                error: "Target text input is disabled",
            };
        }
        if (!isVisible(element)) {
            return {
                success: false,
                error: "Target text input is not visible",
            };
        }
        safeFocus(element);
        if (element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement) {
            /*
             * Avoid attempting to set values on read-only fields.
             */
            if (element.readOnly) {
                return {
                    success: false,
                    error: "Target text input is read-only",
                };
            }
            setNativeInputValue(element, text);
            return {
                success: true,
            };
        }
        if (isContentEditable(element) ||
            hasTextboxRole(element)) {
            /*
             * Do not block role=textbox implementations merely because
             * they are not technically contenteditable. Many web apps
             * use custom textbox controls with their own input handling.
             */
            if (!isContentEditable(element) &&
                !hasTextboxRole(element)) {
                return {
                    success: false,
                    error: "Target element is not a supported editable control",
                };
            }
            setContentEditableValue(element, text);
            return {
                success: true,
            };
        }
        return {
            success: false,
            error: "Target element is not a supported text input",
        };
    }
    /* -------------------------------------------------------------------------- */
    /*                                KEYBOARD                                    */
    /* -------------------------------------------------------------------------- */
    const KEY_ALIASES = {
        esc: "Escape",
        escape: "Escape",
        enter: "Enter",
        return: "Enter",
        tab: "Tab",
        backspace: "Backspace",
        delete: "Delete",
        del: "Delete",
        space: " ",
        spacebar: " ",
        arrowup: "ArrowUp",
        up: "ArrowUp",
        arrowdown: "ArrowDown",
        down: "ArrowDown",
        arrowleft: "ArrowLeft",
        left: "ArrowLeft",
        arrowright: "ArrowRight",
        right: "ArrowRight",
        home: "Home",
        end: "End",
        pageup: "PageUp",
        pagedown: "PageDown",
        insert: "Insert",
        escape_key: "Escape",
        ctrl: "Control",
        control: "Control",
        alt: "Alt",
        shift: "Shift",
        meta: "Meta",
        command: "Meta",
        cmd: "Meta",
        back: "BrowserBack",
        forward: "BrowserForward",
    };
    function normalizeKey(key) {
        const trimmed = key.trim();
        if (!trimmed) {
            return "";
        }
        const normalized = trimmed.toLowerCase();
        return (KEY_ALIASES[normalized] ??
            trimmed);
    }
    function keyCodeFor(key) {
        if (key.length === 1) {
            if (/[a-z]/i.test(key)) {
                return `Key${key.toUpperCase()}`;
            }
            if (/[0-9]/.test(key)) {
                return `Digit${key}`;
            }
        }
        const map = {
            Enter: "Enter",
            Escape: "Escape",
            Tab: "Tab",
            Backspace: "Backspace",
            Delete: "Delete",
            ArrowUp: "ArrowUp",
            ArrowDown: "ArrowDown",
            ArrowLeft: "ArrowLeft",
            ArrowRight: "ArrowRight",
            Home: "Home",
            End: "End",
            PageUp: "PageUp",
            PageDown: "PageDown",
            Insert: "Insert",
            " ": "Space",
            Shift: "ShiftLeft",
            Control: "ControlLeft",
            Alt: "AltLeft",
            Meta: "MetaLeft",
            BrowserBack: "BrowserBack",
            BrowserForward: "BrowserForward",
        };
        return map[key] ?? key;
    }
    function getFocusableElements() {
        const selector = [
            "a[href]",
            "button:not([disabled])",
            "input:not([disabled])",
            "textarea:not([disabled])",
            "select:not([disabled])",
            "summary",
            "details",
            "[contenteditable='true']",
            "[contenteditable='plaintext-only']",
            "[role='button']",
            "[role='link']",
            "[role='checkbox']",
            "[role='radio']",
            "[role='switch']",
            "[role='tab']",
            "[role='option']",
            "[role='textbox']",
            "[tabindex]:not([tabindex='-1'])",
        ].join(",");
        return Array.from(document.querySelectorAll(selector)).filter(element => isVisible(element) &&
            !isElementDisabled(element));
    }
    function moveFocus(backwards) {
        const elements = getFocusableElements();
        if (elements.length === 0) {
            return;
        }
        const active = document.activeElement;
        const currentIndex = elements.indexOf(active);
        let nextIndex;
        if (currentIndex === -1) {
            nextIndex = backwards
                ? elements.length - 1
                : 0;
        }
        else {
            nextIndex = backwards
                ? currentIndex - 1
                : currentIndex + 1;
            if (nextIndex < 0) {
                nextIndex =
                    elements.length - 1;
            }
            if (nextIndex >= elements.length) {
                nextIndex = 0;
            }
        }
        safeFocus(elements[nextIndex]);
    }
    function activateEnterTarget(target) {
        if (isElementDisabled(target)) {
            return;
        }
        if (target instanceof HTMLButtonElement) {
            target.click();
            return;
        }
        if (target instanceof HTMLInputElement) {
            const type = target.type.toLowerCase();
            if (type === "submit" ||
                type === "button" ||
                type === "image" ||
                type === "reset") {
                target.click();
                return;
            }
        }
        if (target instanceof HTMLAnchorElement) {
            target.click();
            return;
        }
        if (target instanceof HTMLLabelElement) {
            target.click();
            return;
        }
        const role = target.getAttribute("role");
        if (role === "button" ||
            role === "link" ||
            role === "tab" ||
            role === "option" ||
            role === "menuitem") {
            try {
                target.click();
                return;
            }
            catch {
                const rect = target.getBoundingClientRect();
                dispatchMouseClick(target, rect.left +
                    rect.width / 2, rect.top +
                    rect.height / 2);
                return;
            }
        }
        const form = target.closest("form");
        if (form instanceof HTMLFormElement) {
            if (typeof form.requestSubmit ===
                "function") {
                form.requestSubmit();
            }
            else {
                form.submit();
            }
        }
    }
    function activateSpaceTarget(target) {
        if (isElementDisabled(target)) {
            return;
        }
        if (target instanceof HTMLButtonElement ||
            target instanceof HTMLInputElement) {
            target.click();
            return;
        }
        const role = target.getAttribute("role");
        if (role === "button" ||
            role === "checkbox" ||
            role === "radio" ||
            role === "switch" ||
            role === "tab") {
            try {
                target.click();
            }
            catch {
                const rect = target.getBoundingClientRect();
                dispatchMouseClick(target, rect.left +
                    rect.width / 2, rect.top +
                    rect.height / 2);
            }
        }
    }
    function pressKey(keyInput) {
        if (typeof keyInput !== "string" ||
            !keyInput.trim()) {
            return {
                success: false,
                error: "Press action requires a key",
            };
        }
        const key = normalizeKey(keyInput);
        if (!key) {
            return {
                success: false,
                error: "Press action requires a valid key",
            };
        }
        const active = document.activeElement;
        const target = active instanceof HTMLElement
            ? active
            : document.body;
        const code = keyCodeFor(key);
        /*
         * modifier state is derived from the actual active keyboard
         * target where possible.
         */
        const keydown = new KeyboardEvent("keydown", {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            ctrlKey: key === "Control",
            altKey: key === "Alt",
            shiftKey: key === "Shift",
            metaKey: key === "Meta",
        });
        const keydownAllowed = target.dispatchEvent(keydown);
        /*
         * Some websites still depend on keypress for printable keys
         * and Enter.
         */
        if (key === "Enter" ||
            key.length === 1 ||
            key === " ") {
            try {
                target.dispatchEvent(new KeyboardEvent("keypress", {
                    key,
                    code,
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                }));
            }
            catch {
                // Ignore.
            }
        }
        /*
         * Synthetic KeyboardEvent does NOT cause the browser's native
         * Tab behavior, so implement it ourselves.
         */
        if (key === "Tab" &&
            keydownAllowed) {
            moveFocus(false);
        }
        /*
         * Synthetic Enter also does not automatically perform the
         * browser's default button/form activation.
         */
        if (key === "Enter" &&
            keydownAllowed) {
            activateEnterTarget(target);
        }
        /*
         * Space similarly needs explicit activation for custom
         * controls.
         */
        if (key === " " &&
            keydownAllowed) {
            activateSpaceTarget(target);
        }
        target.dispatchEvent(new KeyboardEvent("keyup", {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
        }));
        return {
            success: true,
        };
    }
    /* -------------------------------------------------------------------------- */
    /*                                  SCROLL                                    */
    /* -------------------------------------------------------------------------- */
    function scrollPage(direction, amount) {
        if (direction !== "up" &&
            direction !== "down") {
            return {
                success: false,
                error: 'Scroll direction must be "up" or "down"',
            };
        }
        if (!isFiniteNumber(amount) ||
            amount <= 0) {
            return {
                success: false,
                error: "Scroll amount must be a positive number",
            };
        }
        /*
         * Prevent pathological API payloads from causing enormous
         * jumps or browser issues.
         */
        const distance = Math.min(Math.max(amount, 1), 5000);
        try {
            window.scrollBy({
                left: 0,
                top: direction === "down"
                    ? distance
                    : -distance,
                behavior: "auto",
            });
            return {
                success: true,
            };
        }
        catch {
            /*
             * Fallback for unusual browser implementations.
             */
            try {
                window.scrollBy(0, direction === "down"
                    ? distance
                    : -distance);
                return {
                    success: true,
                };
            }
            catch (error) {
                return {
                    success: false,
                    error: error instanceof Error
                        ? error.message
                        : "Unable to scroll page",
                };
            }
        }
    }
    /* -------------------------------------------------------------------------- */
    /*                              MESSAGE HANDLER                               */
    /* -------------------------------------------------------------------------- */
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message ||
            typeof message !== "object") {
            return;
        }
        /*
         * Health check.
         */
        if (message.type === "PING") {
            sendResponse({
                success: true,
            });
            return;
        }
        /*
         * Ignore unrelated extension messages.
         */
        if (message.type !==
            "AGENT_ACTION") {
            return;
        }
        const action = message.action;
        if (!action ||
            typeof action !== "object" ||
            typeof action.action !==
                "string") {
            sendResponse({
                success: false,
                error: "Invalid action",
            });
            return;
        }
        try {
            let result;
            switch (action.action) {
                /*
                 * These are the exact existing actions.
                 */
                case "click":
                    result =
                        clickAt(action.x, action.y);
                    break;
                case "type":
                    result =
                        typeIntoElement(action.text, action.x, action.y);
                    break;
                case "press":
                    result =
                        pressKey(action.key);
                    break;
                case "scroll":
                    result =
                        scrollPage(action.direction, action.amount);
                    break;
                /*
                 * These remain background-service-worker actions.
                 * Nothing new is being sent to the background here.
                 */
                case "open_tab":
                case "navigate":
                case "search":
                case "close_tab":
                case "switch_tab":
                    result = {
                        success: false,
                        error: `Action "${action.action}" ` +
                            "must be handled by the background service worker",
                    };
                    break;
                default:
                    result = {
                        success: false,
                        error: `Unknown action "${action.action}"`,
                    };
            }
            sendResponse(result);
        }
        catch (error) {
            sendResponse({
                success: false,
                error: error instanceof Error
                    ? error.message
                    : String(error),
            });
        }
    });
    console.log("[Project-Vision] Content script ready");
})();
