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

export interface ActionCoordinatesMessage {
    type: "ACTION_COORDINATES";
    request_id?: string;
    action_id?: string;
    tabId?: number;
    payload: ActionPayload;
}

export interface ActionResultMessage {
    type: "ACTION_RESULT";
    request_id?: string;
    action_id?: string;
    payload: {
        success: boolean;
        action: BrowserAction;
        step_index: number;
        error?: string;
        tab_id?: number;
    };
}