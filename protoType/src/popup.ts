interface ChatMessage {
  id: string;
  sender:
    | "user"
    | "server"
    | "system";
  timestamp: number;
  raw?: unknown;
  text?: string;
  image?: string;
  type?: string;
}

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
    "sendBtn"
  ) as HTMLButtonElement;

const clearButton =
  document.getElementById(
    "clearBtn"
  ) as HTMLButtonElement;

function escapeHtml(
  value: string
): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll(
      "'",
      "&#039;"
    );
}

function renderMessage(
  message: ChatMessage
): HTMLDivElement {
  const wrapper =
    document.createElement(
      "div"
    );

  wrapper.className =
    `message ${message.sender}`;

  const type =
    document.createElement(
      "div"
    );

  type.className =
    "type";

  type.textContent =
    message.type ??
    message.sender;

  const bubble =
    document.createElement(
      "div"
    );

  bubble.className =
    "bubble";

  bubble.textContent =
    message.text ??
    "";

  wrapper.appendChild(
    type
  );

  wrapper.appendChild(
    bubble
  );

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
      "Screenshot";

    bubble.appendChild(
      image
    );
  }

  if (
    message.raw !==
    undefined
  ) {
    const details =
      document.createElement(
        "details"
      );

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

    try {
      pre.textContent =
        JSON.stringify(
          message.raw,
          null,
          2
        );
    } catch {
      pre.textContent =
        String(
          message.raw
        );
    }

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
      renderMessage(
        message
      )
    );
  }

  messagesElement.scrollTop =
    messagesElement.scrollHeight;
}

async function loadMessages(): Promise<void> {
  const response =
    await chrome.runtime.sendMessage({
      type:
        "GET_CHAT_MESSAGES",
    });

  if (
    response?.success &&
    Array.isArray(
      response.messages
    )
  ) {
    renderMessages(
      response.messages
    );
  }
}

async function sendPrompt(): Promise<void> {
  const prompt =
    promptElement.value.trim();

  if (!prompt) {
    return;
  }

  sendButton.disabled =
    true;

  try {
    const response =
      await chrome.runtime.sendMessage({
        type:
          "START_AGENT",
        prompt,
      });

    if (
      !response?.success
    ) {
      console.error(
        response?.error ??
        "Failed to start agent"
      );
    }

    promptElement.value =
      "";

    await loadMessages();
  } catch (error) {
    console.error(
      "Failed to send prompt:",
      error
    );
  } finally {
    sendButton.disabled =
      false;

    promptElement.focus();
  }
}

sendButton.addEventListener(
  "click",
  () => {
    void sendPrompt();
  }
);

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

clearButton.addEventListener(
  "click",
  async () => {
    await chrome.runtime.sendMessage({
      type:
        "CLEAR_CHAT",
    });

    await loadMessages();
  }
);

chrome.runtime.onMessage.addListener(
  (message) => {
    if (
      message?.type ===
      "CHAT_MESSAGE"
    ) {
      void loadMessages();
    }
  }
);

void loadMessages();