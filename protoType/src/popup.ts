import type {
  ChatMessage,
} from "./types.js";

const messagesElement =
  document.getElementById(
    "messages"
  ) as HTMLDivElement;

const promptElement =
  document.getElementById(
    "prompt"
  ) as HTMLTextAreaElement;

const sendButton =
  document.getElementById(
    "send"
  ) as HTMLButtonElement;

const clearButton =
  document.getElementById(
    "clear"
  ) as HTMLButtonElement;

const statusElement =
  document.getElementById(
    "status"
  ) as HTMLDivElement;

const screenshotButton =
  document.getElementById(
    "screenshot"
  ) as HTMLButtonElement;

const demoButton =
  document.getElementById(
    "demo"
  ) as HTMLButtonElement;

function setStatus(
  text: string
): void {
  statusElement.textContent =
    text;
}

function createBubble(
  message: ChatMessage
): HTMLDivElement {
  const wrapper =
    document.createElement(
      "div"
    );

  wrapper.className =
    `message-row ${message.sender}`;

  const bubble =
    document.createElement(
      "div"
    );

  bubble.className =
    "message-bubble";

  /*
   * Sender label.
   */
  if (
    message.sender !==
    "user"
  ) {
    const label =
      document.createElement(
        "div"
      );

    label.className =
      "message-label";

    if (
      message.sender ===
      "server"
    ) {
      label.textContent =
        "Srijan";
    } else {
      label.textContent =
        "System";
    }

    bubble.appendChild(
      label
    );
  }

  /*
   * Human-readable text.
   */
  if (
    message.text
  ) {
    const text =
      document.createElement(
        "div"
      );

    text.className =
      "message-text";

    text.textContent =
      message.text;

    bubble.appendChild(
      text
    );
  }

  /*
   * Screenshot.
   *
   * This is displayed if the received
   * packet contains an image.
   */
  if (
    message.image
  ) {
    const image =
      document.createElement(
        "img"
      );

    image.className =
      "screenshot";

    image.src =
      message.image.startsWith(
        "data:"
      )
        ? message.image
        : `data:image/jpeg;base64,${message.image}`;

    image.alt =
      "Browser screenshot";

    bubble.appendChild(
      image
    );
  }

  /*
   * JSON display.
   *
   * The ORIGINAL JSON is displayed,
   * not modified.
   */
  if (
    message.raw !==
      undefined &&
    message.type !==
      "AGENT_ACTION"
  ) {
    const details =
      document.createElement(
        "details"
      );

    details.className =
      "json-details";

    const summary =
      document.createElement(
        "summary"
      );

    summary.textContent =
      "View JSON";

    const pre =
      document.createElement(
        "pre"
      );

    pre.textContent =
      JSON.stringify(
        message.raw,
        null,
        2
      );

    details.appendChild(
      summary
    );

    details.appendChild(
      pre
    );

    bubble.appendChild(
      details
    );
  }

  /*
   * Agent action JSON can also be viewed.
   */
  if (
    message.type ===
      "AGENT_ACTION" &&
    message.raw !==
      undefined
  ) {
    const details =
      document.createElement(
        "details"
      );

    details.className =
      "json-details";

    const summary =
      document.createElement(
        "summary"
      );

    summary.textContent =
      "View action JSON";

    const pre =
      document.createElement(
        "pre"
      );

    pre.textContent =
      JSON.stringify(
        message.raw,
        null,
        2
      );

    details.appendChild(
      summary
    );

    details.appendChild(
      pre
    );

    bubble.appendChild(
      details
    );
  }

  wrapper.appendChild(
    bubble
  );

  return wrapper;
}

function renderMessages(
  messages: ChatMessage[]
): void {
  messagesElement.innerHTML =
    "";

  for (
    const message of messages
  ) {
    messagesElement.appendChild(
      createBubble(message)
    );
  }

  scrollToBottom();
}

function appendMessage(
  message: ChatMessage
): void {
  messagesElement.appendChild(
    createBubble(message)
  );

  scrollToBottom();
}

function scrollToBottom(): void {
  messagesElement.scrollTop =
    messagesElement.scrollHeight;
}

async function loadMessages(): Promise<void> {
  try {
    const response =
      await chrome.runtime.sendMessage({
        type:
          "GET_CHAT_MESSAGES",
      });

    if (
      !response?.success
    ) {
      setStatus(
        "Could not load chat."
      );

      return;
    }

    renderMessages(
      response.messages ?? []
    );
  } catch (error) {
    setStatus(
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
}

async function sendPrompt(): Promise<void> {
  const prompt =
    promptElement.value.trim();

  if (!prompt) {
    return;
  }

  promptElement.value =
    "";

  sendButton.disabled =
    true;

  setStatus(
    "Sending to Srijan..."
  );

  try {
    const response =
      await chrome.runtime.sendMessage({
        type:
          "START_AGENT",
        prompt,
      });

    if (
      response?.success
    ) {
      setStatus(
        "Agent running..."
      );
    } else {
      setStatus(
        response?.error ??
          "Failed to start agent."
      );
    }
  } catch (error) {
    setStatus(
      error instanceof Error
        ? error.message
        : String(error)
    );
  } finally {
    sendButton.disabled =
      false;

    promptElement.focus();
  }
}

async function clearChat(): Promise<void> {
  try {
    const response =
      await chrome.runtime.sendMessage({
        type:
          "CLEAR_CHAT",
      });

    if (
      response?.success
    ) {
      messagesElement.innerHTML =
        "";

      setStatus(
        "Chat cleared."
      );
    }
  } catch (error) {
    setStatus(
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
}

async function testScreenshot(): Promise<void> {
  setStatus(
    "Capturing screenshot..."
  );

  try {
    const response =
      await chrome.runtime.sendMessage({
        type:
          "LOCAL_SCREENSHOT_TEST",
      });

    if (
      response?.success
    ) {
      setStatus(
        "Screenshot sent."
      );
    } else {
      setStatus(
        response?.error ??
          "Screenshot failed."
      );
    }
  } catch (error) {
    setStatus(
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
}

async function runDemo(): Promise<void> {
  setStatus(
    "Running demo..."
  );

  try {
    const response =
      await chrome.runtime.sendMessage({
        type:
          "DEMO_ACTION",
      });

    if (
      response?.success
    ) {
      setStatus(
        "Demo executed."
      );
    } else {
      setStatus(
        response?.error ??
          "Demo failed."
      );
    }
  } catch (error) {
    setStatus(
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
}

/*
 * New JSON message from background.
 */
chrome.runtime.onMessage.addListener(
  (
    message
  ) => {
    if (
      message?.type !==
      "CHAT_MESSAGE"
    ) {
      return;
    }

    const chatMessage =
      message.message as ChatMessage;

    appendMessage(
      chatMessage
    );

    if (
      chatMessage.type ===
      "CONNECTION_STATUS"
    ) {
      setStatus(
        chatMessage.text ??
          ""
      );
    }
  }
);

/*
 * Enter = send.
 * Shift + Enter = newline.
 */
promptElement.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();

      void sendPrompt();
    }
  }
);

sendButton.addEventListener(
  "click",
  () => {
    void sendPrompt();
  }
);

clearButton.addEventListener(
  "click",
  () => {
    void clearChat();
  }
);

screenshotButton.addEventListener(
  "click",
  () => {
    void testScreenshot();
  }
);

demoButton.addEventListener(
  "click",
  () => {
    void runDemo();
  }
);

void loadMessages();

promptElement.focus();