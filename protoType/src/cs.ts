(() => {
  const globalState =
    globalThis as typeof globalThis & {
      __projectVisionContentScriptLoaded?: boolean;
    };

  if (
    globalState.__projectVisionContentScriptLoaded
  ) {
    return;
  }

  globalState.__projectVisionContentScriptLoaded =
    true;

  function findClickableElement(
    element: Element | null
  ): HTMLElement | null {
    if (!element) {
      return null;
    }

    const clickable =
      element.closest(
        "button, a, input, textarea, select, [role='button'], [role='link'], [onclick]"
      );

    if (
      clickable instanceof
      HTMLElement
    ) {
      return clickable;
    }

    if (
      element instanceof
      HTMLElement
    ) {
      return element;
    }

    return null;
  }

  function getElementAtPoint(
    x: number,
    y: number
  ): HTMLElement | null {
    const element =
      document.elementFromPoint(
        x,
        y
      );

    return findClickableElement(
      element
    );
  }

  function click(
    action: {
      x?: number;
      y?: number;
    }
  ): {
    success: boolean;
    error?: string;
  } {
    if (
      typeof action.x !==
        "number" ||
      typeof action.y !==
        "number"
    ) {
      return {
        success: false,
        error:
          "x and y are required",
      };
    }

    const element =
      getElementAtPoint(
        action.x,
        action.y
      );

    if (!element) {
      return {
        success: false,
        error:
          "No clickable element found at coordinates",
      };
    }

    element.click();

    return {
      success: true,
    };
  }

  function typeText(
    action: {
      text?: string;
    }
  ): {
    success: boolean;
    error?: string;
  } {
    if (
      typeof action.text !==
      "string"
    ) {
      return {
        success: false,
        error:
          "text is required",
      };
    }

    const active =
      document.activeElement;

    if (
      active instanceof
      HTMLInputElement ||
      active instanceof
      HTMLTextAreaElement
    ) {
      const prototype =
        active instanceof
        HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const descriptor =
        Object.getOwnPropertyDescriptor(
          prototype,
          "value"
        );

      descriptor?.set?.call(
        active,
        action.text
      );

      active.dispatchEvent(
        new Event(
          "input",
          {
            bubbles: true,
          }
        )
      );

      active.dispatchEvent(
        new Event(
          "change",
          {
            bubbles: true,
          }
        )
      );

      return {
        success: true,
      };
    }

    if (
      active instanceof
      HTMLElement &&
      active.isContentEditable
    ) {
      active.textContent =
        action.text;

      active.dispatchEvent(
        new InputEvent(
          "input",
          {
            bubbles: true,
            inputType:
              "insertText",
            data:
              action.text,
          }
        )
      );

      return {
        success: true,
      };
    }

    return {
      success: false,
      error:
        "No supported editable element is focused",
    };
  }

  function pressKey(
    action: {
      key?: string;
    }
  ): {
    success: boolean;
    error?: string;
  } {
    if (
      typeof action.key !==
      "string" ||
      action.key.length ===
        0
    ) {
      return {
        success: false,
        error:
          "key is required",
      };
    }

    const target =
      document.activeElement ??
      document.body;

    target.dispatchEvent(
      new KeyboardEvent(
        "keydown",
        {
          key:
            action.key,
          bubbles: true,
          cancelable: true,
        }
      )
    );

    target.dispatchEvent(
      new KeyboardEvent(
        "keyup",
        {
          key:
            action.key,
          bubbles: true,
          cancelable: true,
        }
      )
    );

    return {
      success: true,
    };
  }

  function scroll(
    action: {
      direction?: "up" | "down";
      amount?: number;
    }
  ): {
    success: boolean;
    error?: string;
  } {
    if (
      (
        action.direction !==
          "up" &&
        action.direction !==
          "down"
      ) ||
      typeof action.amount !==
        "number"
    ) {
      return {
        success: false,
        error:
          "direction and amount are required",
      };
    }

    const distance =
      action.direction ===
      "down"
        ? action.amount
        : -action.amount;

    window.scrollBy({
      top:
        distance,
      left: 0,
      behavior:
        "smooth",
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
      if (!message) {
        return;
      }

      if (
        message.type ===
        "PING"
      ) {
        sendResponse({
          success: true,
        });

        return;
      }

      if (
        message.type !==
        "AGENT_ACTION"
      ) {
        return;
      }

      const action =
        message.action;

      if (!action) {
        sendResponse({
          success: false,
          error:
            "Missing action",
        });

        return;
      }

      let result: {
        success: boolean;
        error?: string;
      };

      switch (
        action.action
      ) {
        case "click":
          result =
            click(
              action
            );
          break;

        case "type":
          result =
            typeText(
              action
            );
          break;

        case "press":
          result =
            pressKey(
              action
            );
          break;

        case "scroll":
          result =
            scroll(
              action
            );
          break;

        default:
          result = {
            success: false,
            error:
              "Unsupported content action",
          };
      }

      sendResponse(
        result
      );
    }
  );

  console.log(
    "[Project-Vision] Content script ready"
  );
})();