import type {
  ActionPayload,
  BrowserAction,
  ScrollDirection
} from "./types.js";

const browserActions: BrowserAction[] = [
  "click",
  "type",
  "press",
  "scroll",
  "open_tab",
  "navigate",
  "search",
  "close_tab",
  "switch_tab"
];

const scrollDirections: ScrollDirection[] = [
  "up",
  "down"
];

function isBrowserAction(
  value: unknown
): value is BrowserAction {
  return (
    typeof value === "string" &&
    browserActions.includes(
      value as BrowserAction
    )
  );
}

function isScrollDirection(
  value: unknown
): value is ScrollDirection {
  return (
    typeof value === "string" &&
    scrollDirections.includes(
      value as ScrollDirection
    )
  );
}

export function validateAction(
  value: unknown
): value is ActionPayload {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  const action =
    value as Partial<ActionPayload>;

  if (
    !isBrowserAction(action.action)
  ) {
    return false;
  }

  if (
    typeof action.step_index !==
      "number" ||
    !Number.isInteger(
      action.step_index
    ) ||
    action.step_index < 0
  ) {
    return false;
  }

  if (
    typeof action.is_last_step !==
      "boolean"
  ) {
    return false;
  }

  switch (action.action) {
    case "click":
      return (
        typeof action.x ===
          "number" &&
        typeof action.y ===
          "number"
      );

    case "type":
      return (
        typeof action.text ===
        "string"
      );

    case "press":
      return (
        typeof action.key ===
        "string"
      );

    case "scroll":
      return (
        isScrollDirection(
          action.direction
        ) &&
        typeof action.amount ===
          "number" &&
        action.amount > 0
      );

    case "open_tab":
    case "navigate":
      return (
        typeof action.url ===
          "string" &&
        action.url.length > 0
      );

    case "search":
      return (
        typeof action.query ===
          "string" &&
        action.query.length > 0
      );

    case "close_tab":
      return true;

    case "switch_tab":
      return (
        typeof action.tab_id ===
          "number" &&
        Number.isInteger(
          action.tab_id
        )
      );

    default:
      return false;
  }
}