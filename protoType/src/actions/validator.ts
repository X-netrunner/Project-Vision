import type { ActionPayload } from "../types.js";

export function validateAction(
  action: ActionPayload
): boolean {
  if (!action || typeof action !== "object") {
    return false;
  }

  const validActions = new Set([
    "click",
    "type",
    "press",
    "scroll",
    "open_tab",
    "navigate",
    "search",
    "close_tab",
    "switch_tab",
  ]);

  if (
    !validActions.has(
      action.action
    )
  ) {
    return false;
  }

  if (
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
          "number" &&
        Number.isFinite(action.x) &&
        Number.isFinite(action.y)
      );

    case "type":
      return (
        typeof action.text ===
        "string"
      );

    case "press":
      return (
        typeof action.key ===
        "string" &&
        action.key.length > 0
      );

    case "scroll":
      return (
        (action.direction === "up" ||
          action.direction === "down") &&
        typeof action.amount ===
          "number" &&
        Number.isFinite(
          action.amount
        ) &&
        action.amount > 0
      );

    case "open_tab":
    case "navigate":
      return (
        typeof action.url ===
          "string" &&
        action.url.trim().length > 0
      );

    case "search":
      return (
        typeof action.query ===
          "string" &&
        action.query.trim().length > 0
      );

    case "close_tab":
      return true;

    case "switch_tab":
      return (
        typeof action.tab_id ===
          "number" &&
        Number.isInteger(
          action.tab_id
        ) &&
        action.tab_id >= 0
      );

    default:
      return false;
  }
}