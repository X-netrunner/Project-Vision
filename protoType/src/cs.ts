(() => {
    const globalState =
        globalThis as typeof globalThis & {
            __projectVisionContentScriptLoaded?: boolean;
        };

    if (
        globalState.__projectVisionContentScriptLoaded
    ) {
        console.log(
            "[CS] Already loaded"
        );
        return;
    }

    globalState.__projectVisionContentScriptLoaded =
        true;

    console.log(
        "[*] Privacy Guard Active"
    );

    type BrowserAction =
        | "click"
        | "type"
        | "press"
        | "scroll"
        | "open_tab"
        | "navigate"
        | "search"
        | "close_tab"
        | "switch_tab";

    interface ContentMessage {
        action: "PROCESS_IMAGE";
        imageUri: string;
    }

    interface PingMessage {
        type: "PING";
    }

    interface ActionPayload {
        action: BrowserAction;

        x?: number;
        y?: number;

        text?: string;
        key?: string;

        direction?: "up" | "down";
        amount?: number;

        url?: string;
        query?: string;
        tab_id?: number;

        step_index: number;
        is_last_step: boolean;
    }

    interface ActionCoordinatesMessage {
        type: "ACTION_COORDINATES";
        request_id?: string;
        action_id?: string;
        tabId?: number;
        payload: ActionPayload;
    }

    interface ActionResultMessage {
        type: "ACTION_RESULT";
        request_id?: string;
        action_id?: string;
        payload: {
            success: boolean;
            action: BrowserAction;
            step_index: number;
            error?: string;
        };
    }

    type IncomingMessage =
        | ContentMessage
        | PingMessage
        | ActionCoordinatesMessage;

    function isPingMessage(
        message: IncomingMessage
    ): message is PingMessage {
        return (
            "type" in message &&
            message.type === "PING"
        );
    }

    function isContentMessage(
        message: IncomingMessage
    ): message is ContentMessage {
        return (
            "action" in message &&
            message.action === "PROCESS_IMAGE"
        );
    }

    function isActionCoordinatesMessage(
        message: IncomingMessage
    ): message is ActionCoordinatesMessage {
        return (
            "type" in message &&
            message.type === "ACTION_COORDINATES"
        );
    }

    function isVisible(
        element: Element
    ): element is HTMLElement {
        const htmlElement =
            element as HTMLElement;

        const rect =
            htmlElement.getBoundingClientRect();

        const style =
            window.getComputedStyle(
                htmlElement
            );

        return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
        );
    }

    function getClickableElement(
        x: number,
        y: number
    ): HTMLElement | null {

        const element =
            document.elementFromPoint(
                x,
                y
            );

        if (!(element instanceof HTMLElement)) {
            return null;
        }

        const clickable =
            element.closest(
                "button, a, input, textarea, select, [role='button'], [role='link'], [tabindex]"
            );

        if (
            clickable instanceof HTMLElement &&
            isVisible(clickable)
        ) {
            return clickable;
        }

        return null;
    }

    function findInputAt(
        x: number,
        y: number
    ):
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLElement
        | null {

        const coordinateElement =
            document.elementFromPoint(
                x,
                y
            );

        if (
            coordinateElement instanceof HTMLElement
        ) {
            const directInput =
                coordinateElement.closest(
                    "input:not([type='hidden']):not([type='password']), textarea, [contenteditable='true']"
                );

            if (
                directInput instanceof HTMLElement &&
                isVisible(directInput) &&
                !directInput.hasAttribute("disabled")
            ) {
                return directInput;
            }
        }

        const active =
            document.activeElement;

        if (active instanceof HTMLElement) {
            const isInput =
                active instanceof HTMLInputElement &&
                active.type !== "hidden" &&
                active.type !== "password";

            const isTextarea =
                active instanceof HTMLTextAreaElement;

            const isContentEditable =
                active.isContentEditable;

            if (
                (
                    isInput ||
                    isTextarea ||
                    isContentEditable
                ) &&
                isVisible(active)
            ) {
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

        const candidates =
            new Set<HTMLElement>();

        for (
            const selector of selectors
        ) {
            document
                .querySelectorAll(selector)
                .forEach((element) => {
                    if (
                        element instanceof HTMLElement &&
                        isVisible(element) &&
                        !element.hasAttribute(
                            "disabled"
                        )
                    ) {
                        candidates.add(
                            element
                        );
                    }
                });
        }

        if (
            candidates.size === 1
        ) {
            return [...candidates][0];
        }

        return null;
    }

    function setInputValue(
        element:
            | HTMLInputElement
            | HTMLTextAreaElement
            | HTMLElement,
        text: string
    ): void {

        if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
        ) {
            const prototype =
                Object.getPrototypeOf(
                    element
                );

            const descriptor =
                Object.getOwnPropertyDescriptor(
                    prototype,
                    "value"
                );

            if (descriptor?.set) {
                descriptor.set.call(
                    element,
                    text
                );
            } else {
                element.value =
                    text;
            }

            element.dispatchEvent(
                new Event(
                    "input",
                    {
                        bubbles: true
                    }
                )
            );

            element.dispatchEvent(
                new Event(
                    "change",
                    {
                        bubbles: true
                    }
                )
            );

            element.focus();

            return;
        }

        if (
            element.isContentEditable
        ) {
            element.focus();

            element.textContent =
                text;

            element.dispatchEvent(
                new InputEvent(
                    "input",
                    {
                        bubbles: true,
                        inputType:
                            "insertText",
                        data: text
                    }
                )
            );
        }
    }

    function normalizeKey(
        key: string
    ): string {

        const aliases: Record<
            string,
            string
        > = {
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

        return (
            aliases[
                key.toLowerCase()
            ] ?? key
        );
    }

    function executeClick(
        x: number,
        y: number
    ): void {

        const element =
            getClickableElement(
                x,
                y
            );

        if (!element) {
            throw new Error(
                "No clickable element found at coordinates"
            );
        }

        element.click();
    }

    function executeType(
        x: number,
        y: number,
        text: string
    ): void {

        const input =
            findInputAt(
                x,
                y
            );

        if (!input) {
            throw new Error(
                "No input element found at coordinates"
            );
        }

        setInputValue(
            input,
            text
        );
    }

    function executePress(
        key: string
    ): void {

        const normalizedKey =
            normalizeKey(key);

        const active =
            document.activeElement;

        if (
            !(active instanceof HTMLElement)
        ) {
            throw new Error(
                "No active element available"
            );
        }

        active.dispatchEvent(
            new KeyboardEvent(
                "keydown",
                {
                    key: normalizedKey,
                    code: normalizedKey,
                    bubbles: true,
                    cancelable: true
                }
            )
        );

        active.dispatchEvent(
            new KeyboardEvent(
                "keyup",
                {
                    key: normalizedKey,
                    code: normalizedKey,
                    bubbles: true,
                    cancelable: true
                }
            )
        );

        if (
            normalizedKey === "Enter" &&
            (
                active instanceof HTMLInputElement ||
                active instanceof HTMLTextAreaElement
            )
        ) {
            active.form?.requestSubmit();
        }
    }

    function executeScroll(
        direction: "up" | "down",
        amount: number
    ): void {

        const distance =
            direction === "down"
                ? amount
                : -amount;

        window.scrollBy({
            top: distance,
            behavior: "smooth"
        });
    }

    function validateAction(
        message: ActionCoordinatesMessage
    ): void {

        const payload =
            message.payload;

        if (!payload) {
            throw new Error(
                "Missing payload"
            );
        }

        if (
            !Number.isInteger(
                payload.step_index
            ) ||
            payload.step_index < 0
        ) {
            throw new Error(
                "Invalid step_index"
            );
        }

        if (
            payload.action === "click" ||
            payload.action === "type"
        ) {
            if (
                typeof payload.x !== "number" ||
                typeof payload.y !== "number"
            ) {
                throw new Error(
                    "Missing coordinates"
                );
            }
        }

        if (
            payload.action === "type" &&
            typeof payload.text !== "string"
        ) {
            throw new Error(
                "Missing text"
            );
        }

        if (
            payload.action === "press" &&
            typeof payload.key !== "string"
        ) {
            throw new Error(
                "Missing key"
            );
        }

        if (
            payload.action === "scroll" &&
            (
                payload.direction !== "up" &&
                payload.direction !== "down"
            )
        ) {
            throw new Error(
                "Missing scroll direction"
            );
        }
    }

    function executeAction(
        message: ActionCoordinatesMessage
    ): ActionResultMessage {

        const payload =
            message.payload;

        try {
            validateAction(
                message
            );

            switch (
                payload.action
            ) {
                case "click":
                    executeClick(
                        payload.x!,
                        payload.y!
                    );
                    break;

                case "type":
                    executeType(
                        payload.x!,
                        payload.y!,
                        payload.text!
                    );
                    break;

                case "press":
                    executePress(
                        payload.key!
                    );
                    break;

                case "scroll":
                    executeScroll(
                        payload.direction!,
                        payload.amount ??
                            500
                    );
                    break;

                default:
                    throw new Error(
                        `Action ${payload.action} is handled by background`
                    );
            }

            return {
                type: "ACTION_RESULT",
                request_id:
                    message.request_id,
                action_id:
                    message.action_id,
                payload: {
                    success: true,
                    action:
                        payload.action,
                    step_index:
                        payload.step_index
                }
            };

        } catch (error) {
            return {
                type: "ACTION_RESULT",
                request_id:
                    message.request_id,
                action_id:
                    message.action_id,
                payload: {
                    success: false,
                    action:
                        payload.action,
                    step_index:
                        payload.step_index,
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error)
                }
            };
        }
    }

    function redactScreenProcess(
        imageUri: string
    ): void {

        console.log(
            `[CS] Image size: ${imageUri.length} chars`
        );

        const img =
            new Image();

        img.onload = () => {

            const canvas =
                document.createElement(
                    "canvas"
                );

            canvas.width =
                img.naturalWidth;

            canvas.height =
                img.naturalHeight;

            const ctx =
                canvas.getContext(
                    "2d"
                );

            if (!ctx) {
                console.error(
                    "[CS] Canvas unavailable"
                );
                return;
            }

            ctx.drawImage(
                img,
                0,
                0
            );

            const selectors = [
                "input[type='email']",
                "input[type='password']",
                "input[name*='card' i]",
                "input[name*='phone' i]",
                "input[name*='ssn' i]",
                "input[name*='address' i]"
            ];

            const elements =
                document.querySelectorAll(
                    selectors.join(",")
                );

            const scaleX =
                canvas.width /
                window.innerWidth;

            const scaleY =
                canvas.height /
                window.innerHeight;

            for (
                const element of elements
            ) {
                if (
                    !(element instanceof HTMLElement)
                ) {
                    continue;
                }

                const rect =
                    element.getBoundingClientRect();

                ctx.fillStyle =
                    "black";

                ctx.fillRect(
                    rect.left * scaleX,
                    rect.top * scaleY,
                    rect.width * scaleX,
                    rect.height * scaleY
                );
            }

            const sanitizedUri =
                canvas.toDataURL(
                    "image/jpeg",
                    0.9
                );

            chrome.runtime.sendMessage({
                action:
                    "REDACTION_COMPLETE",
                sanitizedUri
            });
        };

        img.onerror = () => {
            console.error(
                "[CS] Screenshot load failed"
            );
        };

        img.src =
            imageUri;
    }

    chrome.runtime.onMessage.addListener(
        (
            message: IncomingMessage,
            _sender,
            sendResponse
        ) => {

            if (
                isPingMessage(message)
            ) {
                sendResponse({
                    success: true
                });

                return true;
            }

            if (
                isContentMessage(message)
            ) {
                redactScreenProcess(
                    message.imageUri
                );

                return true;
            }

            if (
                isActionCoordinatesMessage(
                    message
                )
            ) {
                const result =
                    executeAction(
                        message
                    );

                chrome.runtime.sendMessage(
                    result
                );

                return true;
            }

            return false;
        }
    );
})();