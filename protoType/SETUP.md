# Project-Vision setup

## Folder layout

Load **only** `protoType/` into `chrome://extensions`:

```text
Project-Vision/
├── protoType/              <- Chrome extension folder
│   ├── manifest.json
│   ├── dist/
│   ├── native_host.py
│   └── install-native-host.*
└── varun/
    └── app.py              <- existing local server
```

Keep `app.py` outside `protoType/`. The native host receives the project root from the OS launcher, starts `varun/app.py` automatically, and runs Python with `-B` plus `PYTHONDONTWRITEBYTECODE=1` so it does not create `__pycache__` for this launcher/server process.

## Windows

1. Load `Project-Vision/protoType` in `chrome://extensions`.
2. Copy the Project-Vision **Extension ID**.
3. In PowerShell:

```powershell
cd "$HOME\Downloads\Project-Vision\protoType"
.\install-native-host.ps1 -ExtensionId "YOUR_EXTENSION_ID"
```

4. Restart Chrome and reload the extension.

## macOS

1. Load `Project-Vision/protoType` in Chrome and copy its Extension ID.
2. In Terminal:

```bash
cd ~/Downloads/Project-Vision/protoType
./install-native-host.sh "YOUR_EXTENSION_ID"
```

3. Restart Chrome and reload the extension.

## Linux

1. Load `Project-Vision/protoType` in Chrome and copy its Extension ID.
2. In Terminal:

```bash
cd ~/Downloads/Project-Vision/protoType
./install-native-host.sh "YOUR_EXTENSION_ID"
```

3. Restart Chrome and reload the extension.

## Remove the native host

Windows:

```powershell
.\uninstall-native-host.ps1
```

macOS/Linux:

```bash
./uninstall-native-host.sh
```

The Srijan WebSocket URL and existing Srijan/Varun API payloads are unchanged.
