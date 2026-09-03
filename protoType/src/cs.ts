(() => {
  const globalState = globalThis as typeof globalThis & {
    __projectVisionContentScriptLoaded?: boolean;
  };

  if (
    globalState.__projectVisionContentScriptLoaded
  ) {
    return;
  }

  globalState.__projectVisionContentScriptLoaded =
    true;

  function getElementAtPoint(
    x: number,
    y: number
  ): Element | null {
    return document.elementFromPoint(x, y);
  }

  function findClickableElement(
    element: Element | null
  ): HTMLElement | null {
    if (!element) {
      return null;
    }

    const clickable = element.closest(
      'button, a, input, textarea, select, [role="button"], [onclick], [tabindex]'
    );

    if (clickable instanceof HTMLElement) {
      return clickable;
    }

    return element instanceof HTMLElement
      ? element
      : null;
  }

  function clickAt(
    x: number,
    y: number
  ): {
    success: boolean;
    error?: string;
  } {
    const element =
      getElementAtPoint(x, y);

    if (!element) {
      return {
        success: false,
        error:
          `No element found at (${x}, ${y})`,
      };
    }

    const clickable =
      findClickableElement(element);

    if (!clickable) {
      return {
        success: false,
        error:
          `Element at (${x}, ${y}) is not clickable`,
      };
    }

    clickable.click();

    return {
      success: true,
    };
  }

  function findTextInput():
    HTMLElement | null {
    const active =
      document.activeElement;

    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement &&
        active.isContentEditable)
    ) {
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
      "input:not([type='hidden'])",
    ];

    for (const selector of selectors) {
      const element =
        document.querySelector(
          selector
        );

      if (
        element instanceof HTMLElement
      ) {
        return element;
      }
    }

    return null;
  }

  function setInputValue(
    element:
      | HTMLInputElement
      | HTMLTextAreaElement,
    text: string
  ): void {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const descriptor =
      Object.getOwnPropertyDescriptor(
        prototype,
        "value"
      );

    const setter =
      descriptor?.set;

    if (setter) {
      setter.call(element, text);
    } else {
      element.value = text;
    }

    element.dispatchEvent(
      new Event("input", {
        bubbles: true,
        composed: true,
      })
    );

    element.dispatchEvent(
      new Event("change", {
        bubbles: true,
        composed: true,
      })
    );
  }

  function typeIntoElement(
    text: string,
    x?: number,
    y?: number
  ): {
    success: boolean;
    error?: string;
  } {
    let element: HTMLElement | null =
      null;

    element = findTextInput();

    if (
      !element &&
      typeof x === "number" &&
      typeof y === "number"
    ) {
      const at =
        getElementAtPoint(x, y);

      if (
        at instanceof HTMLInputElement ||
        at instanceof HTMLTextAreaElement ||
        (at instanceof HTMLElement &&
          at.isContentEditable)
      ) {
        element = at;
      } else if (at) {
        element =
          at.closest(
            "input, textarea, [contenteditable]"
          ) as HTMLElement | null;
      }
    }

    if (!element) {
      return {
        success: false,
        error:
          "No supported input element found",
      };
    }

    element.focus();

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      setInputValue(element, text);

      return {
        success: true,
      };
    }

    if (element.isContentEditable) {
      element.textContent = text;

      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        })
      );

      return {
        success: true,
      };
    }

    return {
      success: false,
      error:
        "Element is not a text input",
    };
  }

  function pressKey(
    key: string
  ): {
    success: boolean;
    error?: string;
  } {
    const target =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.body;

    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
    );

    target.dispatchEvent(
      new KeyboardEvent("keyup", {
        key,
        bubbles: true,
        cancelable: true,
      })
    );

    if (
      key === "Enter" &&
      document.activeElement
    ) {
      const active =
        document.activeElement;

      const form =
        active instanceof HTMLElement
          ? active.closest("form")
          : null;

      if (form) {
        if (
          typeof form.requestSubmit === "function"
        ) {
          form.requestSubmit();
        } else {
          form.submit();
        }
      }
    }

    return {
      success: true,
    };
  }

  function scrollPage(
    direction: "up" | "down",
    amount: number
  ): {
    success: boolean;
    error?: string;
  } {
    const distance =
      direction === "down"
        ? amount
        : -amount;

    window.scrollBy({
      top: distance,
      behavior: "smooth",
    });

    return {
      success: true,
    };
  }

  chrome.runtime.onMessage.addListener(
    (
      message,
      _sender,
      sendResponse
    ) => {
      if (
        !message ||
        typeof message !== "object"
      ) {
        return;
      }

      if (
        message.type === "PING"
      ) {
        sendResponse({
          success: true,
        });

        return;
      }

      if (
        message.type !== "AGENT_ACTION"
      ) {
        return;
      }

      const action =
        message.action;

      if (
        !action ||
        typeof action.action !== "string"
      ) {
        sendResponse({
          success: false,
          error: "Invalid action",
        });

        return;
      }

      try {
        let result: {
          success: boolean;
          error?: string;
        };

        switch (action.action) {
          case "click":
            result = clickAt(
              action.x,
              action.y
            );
            break;

          case "type":
            result =
              typeIntoElement(
                action.text,
                action.x,
                action.y
              );
            break;

          case "press":
            result =
              pressKey(
                action.key
              );
            break;

          case "scroll":
            result =
              scrollPage(
                action.direction,
                action.amount
              );
            break;

          default:
            result = {
              success: false,
              error:
                `Action "${action.action}" ` +
                "must be handled by the background service worker",
            };
        }

        sendResponse(result);
      } catch (error) {
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }
  );

  console.log(
    "[Project-Vision] Content script ready"
  );
})();