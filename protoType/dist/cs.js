"use strict";
(() => {
    const globalState = globalThis;
    /*
     * Prevent duplicate content-script installation.
     *
     * Chrome can inject/reinject content scripts during navigation,
     * SPA route changes, extension reloads, etc.
     */
    if (globalState.__projectVisionContentScriptLoaded) {
        return;
    }
    globalState.__projectVisionContentScriptLoaded = true;
    // ---------------------------------------------------------------------------
    // General utilities
    // ---------------------------------------------------------------------------
    function isFiniteNumber(value) {
        return (typeof value === "number" &&
            Number.isFinite(value));
    }
    function sleep(ms) {
        return new Promise(resolve => {
            window.setTimeout(resolve, ms);
        });
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
                // Ignore focus failures.
            }
        }
    }
    function isConnected(element) {
        return element.isConnected;
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
        return true;
    }
    function isDisabled(element) {
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
        if (element.hasAttribute("disabled")) {
            return true;
        }
        const ariaDisabled = element.getAttribute("aria-disabled");
        if (ariaDisabled?.toLowerCase() === "true") {
            return true;
        }
        return false;
    }
    function isPointInsideViewport(x, y) {
        return (x >= 0 &&
            y >= 0 &&
            x < window.innerWidth &&
            y < window.innerHeight);
    }
    // ---------------------------------------------------------------------------
    // Shadow DOM / coordinate handling
    // ---------------------------------------------------------------------------
    function getElementAtPoint(x, y) {
        if (!isFiniteNumber(x) ||
            !isFiniteNumber(y)) {
            return null;
        }
        if (!isPointInsideViewport(x, y)) {
            return null;
        }
        let element = document.elementFromPoint(x, y);
        /*
         * Walk through open Shadow DOM roots.
         *
         * Explicit annotations here are important because TypeScript can otherwise
         * produce TS7022 in recursive/nested ShadowRoot inference.
         */
        while (element instanceof HTMLElement &&
            element.shadowRoot instanceof ShadowRoot) {
            const shadowRoot = element.shadowRoot;
            const shadowElement = shadowRoot.elementFromPoint(x, y);
            if (!shadowElement ||
                shadowElement === element) {
                break;
            }
            element = shadowElement;
        }
        return element;
    }
    function getDeepActiveElement() {
        let active = document.activeElement;
        while (active instanceof HTMLElement &&
            active.shadowRoot instanceof ShadowRoot) {
            const shadowRoot = active.shadowRoot;
            const shadowActive = shadowRoot.activeElement;
            if (!shadowActive) {
                break;
            }
            active = shadowActive;
        }
        return active;
    }
    function pointIsInsideElement(element, x, y) {
        if (!element.isConnected) {
            return false;
        }
        const rect = element.getBoundingClientRect();
        return (x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom);
    }
    // ---------------------------------------------------------------------------
    // Clickable element detection
    // ---------------------------------------------------------------------------
    function isClickableElement(element) {
        const tag = element.tagName.toLowerCase();
        if (tag === "button" ||
            tag === "a" ||
            tag === "input" ||
            tag === "select" ||
            tag === "summary") {
            return true;
        }
        const role = element.getAttribute("role")?.toLowerCase();
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
        if (element.hasAttribute("onclick") ||
            element.hasAttribute("ng-click") ||
            element.hasAttribute("@click") ||
            element.hasAttribute("v-on:click")) {
            return true;
        }
        /*
         * Do not treat every tabindex as clickable.
         *
         * tabindex is often used for focus management and treating every
         * focusable element as a button caused false-positive clicks.
         */
        if (element.hasAttribute("tabindex") &&
            element.getAttribute("tabindex") !== "-1") {
            const roleAttribute = element.getAttribute("role");
            if (roleAttribute === "button" ||
                roleAttribute === "link" ||
                roleAttribute === "tab" ||
                roleAttribute === "option") {
                return true;
            }
        }
        return false;
    }
    function findClickableElement(element) {
        if (!element) {
            return null;
        }
        let current = element;
        while (current) {
            if (current instanceof HTMLElement &&
                isClickableElement(current)) {
                return current;
            }
            current =
                current.parentElement;
        }
        return null;
    }
    /*
     * Find the nearest useful interactive ancestor without blindly promoting
     * arbitrary containers.
     */
    function findInteractiveAncestor(element) {
        if (!element) {
            return null;
        }
        if (element instanceof HTMLElement &&
            isClickableElement(element)) {
            return element;
        }
        return findClickableElement(element);
    }
    // ---------------------------------------------------------------------------
    // Click verification
    // ---------------------------------------------------------------------------
    function verifyClickTarget(element, x, y) {
        if (!element.isConnected ||
            !isVisible(element) ||
            isDisabled(element)) {
            return false;
        }
        if (!pointIsInsideElement(element, x, y)) {
            return false;
        }
        const actual = getElementAtPoint(x, y);
        if (!actual) {
            return false;
        }
        /*
         * The actual topmost element must belong to the intended target.
         *
         * This intentionally avoids the overly-permissive:
         *
         *   element.contains(actual)
         *
         * by itself.
         */
        if (actual === element) {
            return true;
        }
        if (element.contains(actual)) {
            return true;
        }
        const actualClickable = findClickableElement(actual);
        return (actualClickable === element);
    }
    // ---------------------------------------------------------------------------
    // Mouse / pointer event handling
    // ---------------------------------------------------------------------------
    function createMouseBase(x, y) {
        return {
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
        };
    }
    function dispatchPointerMouseClick(element, x, y) {
        const base = createMouseBase(x, y);
        /*
         * Pointer events first.
         *
         * Some React/Vue/custom web components listen to pointer events rather
         * than click.
         */
        try {
            element.dispatchEvent(new PointerEvent("pointerover", {
                ...base,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                buttons: 0,
            }));
            element.dispatchEvent(new PointerEvent("pointerenter", {
                ...base,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                buttons: 0,
            }));
            element.dispatchEvent(new PointerEvent("pointermove", {
                ...base,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                buttons: 0,
            }));
            element.dispatchEvent(new PointerEvent("pointerdown", {
                ...base,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                buttons: 1,
            }));
        }
        catch {
            // PointerEvent may be unavailable in unusual environments.
        }
        /*
         * Traditional mouse events.
         */
        element.dispatchEvent(new MouseEvent("mouseover", {
            ...base,
            buttons: 0,
        }));
        element.dispatchEvent(new MouseEvent("mousemove", {
            ...base,
            buttons: 1,
        }));
        element.dispatchEvent(new MouseEvent("mousedown", {
            ...base,
            buttons: 1,
        }));
        try {
            element.dispatchEvent(new PointerEvent("pointerup", {
                ...base,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                buttons: 0,
            }));
        }
        catch {
            // Ignore.
        }
        element.dispatchEvent(new MouseEvent("mouseup", {
            ...base,
            buttons: 0,
        }));
        element.dispatchEvent(new MouseEvent("click", {
            ...base,
            buttons: 0,
        }));
    }
    function shouldUseNativeClick(element) {
        const tag = element.tagName.toLowerCase();
        /*
         * Native .click() is preferable for real HTML controls.
         */
        return (tag === "button" ||
            tag === "a" ||
            tag === "input" ||
            tag === "select" ||
            tag === "summary");
    }
    // ---------------------------------------------------------------------------
    // CLICK
    // ---------------------------------------------------------------------------
    function clickAt(x, y) {
        if (!isFiniteNumber(x) ||
            !isFiniteNumber(y)) {
            return {
                success: false,
                error: "Click requires valid numeric x and y coordinates",
            };
        }
        if (!isPointInsideViewport(x, y)) {
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
        const clickable = findInteractiveAncestor(element);
        if (!clickable) {
            return {
                success: false,
                error: `Element at (${x}, ${y}) is not clickable`,
            };
        }
        if (!clickable.isConnected) {
            return {
                success: false,
                error: "Target element was removed from the page",
            };
        }
        if (isDisabled(clickable)) {
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
        /*
         * Re-check the target immediately before interaction.
         *
         * This matters heavily on Google, Amazon, React apps, SPAs, etc. where
         * the DOM can change between screenshot capture and action execution.
         */
        if (!verifyClickTarget(clickable, x, y)) {
            /*
             * Try resolving the target one final time.
             */
            const refreshed = getElementAtPoint(x, y);
            const refreshedClickable = findInteractiveAncestor(refreshed);
            if (!refreshedClickable ||
                refreshedClickable !== clickable ||
                !verifyClickTarget(refreshedClickable, x, y)) {
                return {
                    success: false,
                    error: "Target moved or is no longer at the requested coordinates",
                };
            }
        }
        safeFocus(clickable);
        try {
            if (shouldUseNativeClick(clickable)) {
                clickable.click();
            }
            else {
                dispatchPointerMouseClick(clickable, x, y);
            }
            /*
             * Remember the action only for diagnostics/re-entry protection.
             * This does NOT suppress legitimate future clicks indefinitely.
             */
            globalState.__projectVisionLastAction = {
                signature: `click:${Math.round(x)}:${Math.round(y)}`,
                time: Date.now(),
            };
            return {
                success: true,
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error
                    ? `Click failed: ${error.message}`
                    : `Click failed: ${String(error)}`,
            };
        }
    }
    // ---------------------------------------------------------------------------
    // TEXT INPUT
    // ---------------------------------------------------------------------------
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
                type !== "color");
        }
        return false;
    }
    function isContentEditable(element) {
        return (element instanceof HTMLElement &&
            element.isContentEditable);
    }
    function findTextInputAtPoint(x, y) {
        const element = getElementAtPoint(x, y);
        if (!element) {
            return null;
        }
        if (isTextInput(element) ||
            isContentEditable(element)) {
            return element;
        }
        const directParent = element.parentElement;
        if (directParent &&
            (isTextInput(directParent) ||
                isContentEditable(directParent))) {
            return directParent;
        }
        const editable = element.closest([
            "textarea",
            "input",
            "[contenteditable='true']",
            "[contenteditable='plaintext-only']",
            "[role='textbox']"
        ].join(","));
        if (editable instanceof HTMLElement &&
            (isTextInput(editable) ||
                isContentEditable(editable) ||
                editable.getAttribute("role") === "textbox")) {
            return editable;
        }
        return null;
    }
    function findFocusedTextInput() {
        const active = getDeepActiveElement();
        if (isTextInput(active) ||
            isContentEditable(active)) {
            return active;
        }
        if (active instanceof HTMLElement &&
            active.getAttribute("role") === "textbox") {
            return active;
        }
        return null;
    }
    function findFallbackTextInput() {
        const selectors = [
            "textarea",
            "input[type='search']",
            "input[type='text']",
            "input[type='email']",
            "input[type='url']",
            "input[type='tel']",
            "input[type='number']",
            "input[type='password']",
            "input:not([type])",
            "[contenteditable='true']",
            "[contenteditable='plaintext-only']",
            "[role='textbox']"
        ];
        for (const selector of selectors) {
            const elements = Array.from(document.querySelectorAll(selector));
            for (const element of elements) {
                if (isVisible(element) &&
                    !isDisabled(element)) {
                    return element;
                }
            }
        }
        return null;
    }
    function setInputValue(element, text) {
        const prototype = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        const setter = descriptor?.set;
        if (setter) {
            setter.call(element, text);
        }
        else {
            element.value = text;
        }
        /*
         * React and other controlled frameworks listen to input/change.
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
            // Older browsers may not support InputEvent constructor.
        }
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
        element.dispatchEvent(new Event("change", {
            bubbles: true,
            composed: true,
        }));
    }
    function setContentEditableValue(element, text) {
        safeFocus(element);
        const selection = window.getSelection();
        if (selection) {
            try {
                const range = document.createRange();
                range.selectNodeContents(element);
                selection.removeAllRanges();
                selection.addRange(range);
            }
            catch {
                // Ignore selection errors.
            }
        }
        /*
         * beforeinput first.
         */
        try {
            const beforeInput = new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                composed: true,
                inputType: "insertText",
                data: text,
            });
            const allowed = element.dispatchEvent(beforeInput);
            if (!allowed) {
                return;
            }
        }
        catch {
            // Continue.
        }
        /*
         * Use execCommand when available.
         *
         * This is deprecated, but remains useful for contenteditable editors
         * because many rich editors react better to editing commands than direct
         * textContent manipulation.
         */
        let inserted = false;
        try {
            if (typeof document.execCommand ===
                "function") {
                inserted =
                    document.execCommand("insertText", false, text);
            }
        }
        catch {
            inserted = false;
        }
        if (!inserted) {
            element.textContent = text;
        }
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
        element.dispatchEvent(new Event("change", {
            bubbles: true,
            composed: true,
        }));
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
        if (coordinatesProvided) {
            if (!isFiniteNumber(x) ||
                !isFiniteNumber(y)) {
                return {
                    success: false,
                    error: "Type coordinates must both be valid numbers",
                };
            }
            element =
                findTextInputAtPoint(x, y);
            /*
             * Do not immediately fall back to some random page input if the
             * coordinates were supplied. That can cause typing into the wrong field.
             */
            if (!element) {
                return {
                    success: false,
                    error: `Coordinates (${x}, ${y}) do not point to a supported text input`,
                };
            }
        }
        if (!element) {
            element =
                findFocusedTextInput();
        }
        /*
         * Only use a fallback input when no explicit coordinates were supplied
         * and there is no focused field.
         */
        if (!element &&
            !coordinatesProvided) {
            element =
                findFallbackTextInput();
        }
        if (!element) {
            return {
                success: false,
                error: "No text input found. Provide x/y coordinates or focus an input first.",
            };
        }
        if (!element.isConnected) {
            return {
                success: false,
                error: "Target text input is no longer connected to the page",
            };
        }
        if (isDisabled(element)) {
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
        try {
            if (element instanceof HTMLInputElement ||
                element instanceof HTMLTextAreaElement) {
                setInputValue(element, text);
                return {
                    success: true,
                };
            }
            if (element.isContentEditable) {
                setContentEditableValue(element, text);
                return {
                    success: true,
                };
            }
            /*
             * ARIA textbox fallback.
             */
            if (element.getAttribute("role") ===
                "textbox") {
                setContentEditableValue(element, text);
                return {
                    success: true,
                };
            }
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error
                    ? `Typing failed: ${error.message}`
                    : `Typing failed: ${String(error)}`,
            };
        }
        return {
            success: false,
            error: "Target element is not a supported text input",
        };
    }
    // ---------------------------------------------------------------------------
    // KEYBOARD
    // ---------------------------------------------------------------------------
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
    };
    function normalizeKey(key) {
        const normalized = key.trim().toLowerCase();
        return (KEY_ALIASES[normalized] ??
            key);
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
            " ": "Space",
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
            "[tabindex]:not([tabindex='-1'])"
        ].join(",");
        return Array.from(document.querySelectorAll(selector)).filter(element => isVisible(element) &&
            !isDisabled(element));
    }
    function moveFocus(backwards) {
        const elements = getFocusableElements();
        if (elements.length === 0) {
            return;
        }
        const active = getDeepActiveElement();
        const currentIndex = active instanceof HTMLElement
            ? elements.indexOf(active)
            : -1;
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
        const next = elements[nextIndex];
        if (next) {
            safeFocus(next);
        }
    }
    function activateEnterTarget(target) {
        if (isDisabled(target)) {
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
                type === "reset" ||
                type === "image") {
                target.click();
                return;
            }
        }
        if (target instanceof HTMLAnchorElement) {
            target.click();
            return;
        }
        const role = target.getAttribute("role")?.toLowerCase();
        if (role === "button" ||
            role === "link" ||
            role === "tab" ||
            role === "menuitem") {
            const rect = target.getBoundingClientRect();
            dispatchPointerMouseClick(target, rect.left +
                rect.width / 2, rect.top +
                rect.height / 2);
            return;
        }
        /*
         * Do not submit every form on Enter.
         *
         * Only submit if the active target actually belongs to a form.
         */
        const form = target.closest("form");
        if (form) {
            try {
                if (typeof form.requestSubmit ===
                    "function") {
                    form.requestSubmit();
                }
                else {
                    form.submit();
                }
            }
            catch {
                // Ignore form submission errors.
            }
        }
    }
    function activateSpaceTarget(target) {
        if (isDisabled(target)) {
            return;
        }
        if (target instanceof HTMLButtonElement) {
            target.click();
            return;
        }
        if (target instanceof HTMLInputElement) {
            const type = target.type.toLowerCase();
            if (type === "checkbox" ||
                type === "radio" ||
                type === "button" ||
                type === "submit") {
                target.click();
                return;
            }
        }
        const role = target.getAttribute("role")?.toLowerCase();
        if (role === "button" ||
            role === "checkbox" ||
            role === "radio" ||
            role === "switch") {
            const rect = target.getBoundingClientRect();
            dispatchPointerMouseClick(target, rect.left +
                rect.width / 2, rect.top +
                rect.height / 2);
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
        const target = getDeepActiveElement() instanceof HTMLElement
            ? getDeepActiveElement()
            : document.body;
        const code = keyCodeFor(key);
        /*
         * Synthetic keyboard events do not reproduce every browser-native
         * keyboard behavior. We therefore explicitly handle the important
         * browser behaviors below.
         */
        const keydown = new KeyboardEvent("keydown", {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            metaKey: false,
        });
        const keydownAllowed = target.dispatchEvent(keydown);
        if (key === "Enter" ||
            key.length === 1) {
            target.dispatchEvent(new KeyboardEvent("keypress", {
                key,
                code,
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
            }));
        }
        if (key === "Tab" &&
            keydownAllowed) {
            moveFocus(false);
        }
        if (key === "Enter" &&
            keydownAllowed) {
            activateEnterTarget(target);
        }
        if (key === " " &&
            keydownAllowed) {
            activateSpaceTarget(target);
        }
        /*
         * Escape is intentionally left as an event.
         *
         * Modal/dropdown implementations generally listen for the event and
         * perform their own close operation.
         */
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
    // ---------------------------------------------------------------------------
    // SCROLL
    // ---------------------------------------------------------------------------
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
        const distance = Math.min(Math.max(Math.round(amount), 1), 5000);
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
             * Fallback for unusual environments.
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
                        : String(error),
                };
            }
        }
    }
    // ---------------------------------------------------------------------------
    // MESSAGE HANDLER
    // ---------------------------------------------------------------------------
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message ||
            typeof message !== "object") {
            return;
        }
        /*
         * Lightweight health check.
         */
        if (message.type === "PING") {
            sendResponse({
                success: true,
            });
            return;
        }
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
                 *
                 * Keeping them here is useful because it prevents accidental
                 * execution if they ever get routed to the content script.
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
