# Project-Vision setup

## 1. Put the local server outside the extension folder

Preferred layout:

```text
Project-Vision/
├── protoType/              <- load this folder in chrome://extensions
│   ├── manifest.json
│   ├── dist/
│   ├── native_host.py
│   └── register-native-host.ps1
└── varun/
    └── app.py              <- existing server
```

`native_host.py` automatically checks `varun/app.py` first.

Python bytecode writes are disabled for the server process, so running it through Project-Vision does not create `__pycache__` in the extension folder.

## 2. Load the extension

Open `chrome://extensions`, enable Developer mode, and choose `protoType`.

Copy the extension ID shown there.

## 3. Register Native Messaging once

In PowerShell:

```powershell
cd "$HOME\Downloads\Project-Vision\protoType"
.\setup-project-vision.ps1 -ExtensionId "YOUR_EXTENSION_ID"
```

Restart Chrome after registration.

Native Messaging registration is an operating-system security requirement; the extension cannot register itself.

## 4. Srijan

Enter the same WebSocket endpoint that you already use successfully, for example:

```text
wss://YOUR-NGROK-HOST.ngrok-free.app/ws
```

The extension sends the existing Srijan packet structures unchanged.

If Srijan accepts the TCP/WebSocket handshake and then closes the socket, inspect the extension service-worker console for:

- `Srijan WebSocket status: open`
- `Srijan WebSocket status: closed code: ... reason: ...`

A non-1000 close code/reason from that line is server-side protocol/policy information, not an ngrok reachability failure.
