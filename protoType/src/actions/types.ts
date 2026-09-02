export type BrowserAction =
  | "click"
  | "type"
  | "press"
  | "scroll"
  | "open_tab"
  | "navigate"
  | "search"
  | "close_tab"
  | "switch_tab";

export type ScrollDirection =
  | "up"
  | "down";

export interface ActionPayload {
  action: BrowserAction;

  x?: number;
  y?: number;

  text?: string;
  key?: string;

  direction?: ScrollDirection;
  amount?: number;

  url?: string;
  query?: string;
  tab_id?: number;

  step_index: number;
  is_last_step: boolean;
}

export interface AgentActionMessage {
  type: "AGENT_ACTION";
  request_id: string;
  action_id: string;
  tab_id?: number;
  step_index: number;
  action: ActionPayload;
  is_last_step: boolean;
}

export interface ActionResult {
  success: boolean;
  action: BrowserAction;
  step_index: number;
  tab_id?: number;
  error?: string;
}

export interface ActionResultMessage {
  type: "ACTION_RESULT";
  request_id: string;
  action_id: string;
  result: ActionResult;
}

export interface RawScreenshotMessage {
  type: "RAW_SCREENSHOT";
  request_id: string;
  tab_id: number;
  step_index: number;
  image: string;
  action_result: ActionResult | null;
}

export interface RedactedScreenshotMessage {
  type: "REDACTED_SCREENSHOT";
  request_id: string;
  tab_id: number;
  step_index: number;
  image: string;
  action_result: ActionResult | null;
}

export interface ErrorMessage {
  type: "ERROR";
  request_id?: string;
  error: string;
}

export type SrijanMessage =
  | AgentActionMessage
  | ErrorMessage;

export type VarunMessage =
  | RedactedScreenshotMessage
  | ErrorMessage;