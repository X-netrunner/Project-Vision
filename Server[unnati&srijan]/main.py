import asyncio
import re
import sys
import traceback
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
import json
import os
import uuid
import hashlib
from planner import createPlan, replanTask
from vlm import predict_action, reason_about_failure, analyze_form, build_form_fill_plan
from logger_util import info, ok, warn, error, step as step_log, task as task_log, save_screenshot

SEP = "=" * 70

# Increment this whenever the server's behavior changes meaningfully, so the
# startup banner makes it obvious which build is running.
SERVER_VERSION = "2.3.0"

# Maximum scroll-passes when scanning a form. Each pass analyzes the
# current viewport, scrolls down, and repeats until the whole form is seen.
MAX_FORM_SCAN = 4

URL_RE = re.compile(r"https?://[^\s'\"]+", re.IGNORECASE)


def normalize_label(label: str) -> str:
    """Normalize label by removing asterisks, quotes, excess whitespace, and lowercasing."""
    cleaned = re.sub(r'[\*\"\'\:\-]+', ' ', label or '')
    return ' '.join(cleaned.lower().split())


def is_form_goal(prompt: str) -> bool:
    """Return True when the user's request clearly asks to fill a web form."""
    p = (prompt or "").lower()
    has_form = "form" in p or "google forms" in p or "feedback" in p
    fill_verb = any(v in p for v in ["fill", "fill out", "submit this", "complete the form"])
    has_url = bool(URL_RE.search(prompt or ""))
    return has_form and (fill_verb or has_url)


def extract_url(prompt: str) -> str | None:
    m = URL_RE.search(prompt or "")
    return m.group(0) if m else None


class TeeLogger:
    def __init__(self, filename, stream):
        self.terminal = stream
        self.log_file = open(filename, "a", encoding="utf-8", buffering=1)

    def write(self, message):
        try:
            self.terminal.write(message)
            self.log_file.write(message)
        except Exception:
            pass

    def flush(self):
        try:
            self.terminal.flush()
            self.log_file.flush()
        except Exception:
            pass

    def isatty(self):
        # uvicorn's default logging config checks sys.stdout.isatty() to decide
        # whether to emit ANSI color codes - without this, dictConfig() blows up
        # with "Unable to configure formatter 'default'" before the server binds.
        try:
            return self.terminal.isatty()
        except Exception:
            return False

    def fileno(self):
        # Some libraries (and uvicorn's --reload file watchers) introspect the
        # underlying fd; forward to the real stream instead of raising.
        return self.terminal.fileno()

    def __getattr__(self, name):
        # Anything else (encoding, errors, etc.) - fall back to the real stream
        # so TeeLogger is a transparent proxy rather than a partial one.
        return getattr(self.terminal, name)


def setup_file_logging():
    """Redirect stdout/stderr to both console and logs/server.log."""
    log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "server.log")
    try:
        sys.stdout = TeeLogger(log_path, sys.stdout)
        sys.stderr = TeeLogger(log_path, sys.stderr)
    except Exception as e:
        print(f"[!] File logging setup error: {e}")


setup_file_logging()


class ConnectionManager:
    """Tracks active WebSocket connections with their IPs and execution status."""
    def __init__(self):
        self.connections: dict[str, dict] = {}

    def register(self, conn_id: str, client_ip: str, websocket: WebSocket) -> dict:
        info_data = {
            "conn_id": conn_id,
            "client_ip": client_ip,
            "websocket": websocket,
            "connected_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "status": "idle",
            "current_prompt": "",
            "current_request_id": "",
            "active_step": 0,
            "total_steps": 0,
        }
        self.connections[conn_id] = info_data
        return info_data

    def unregister(self, conn_id: str):
        self.connections.pop(conn_id, None)

    def update(self, conn_id: str, **kwargs):
        if conn_id in self.connections:
            self.connections[conn_id].update(kwargs)

    async def disconnect(self, conn_id: str, reason: str = "Disconnected by admin"):
        client = self.connections.get(conn_id)
        if client:
            try:
                ws = client.get("websocket")
                if ws:
                    await ws.close(code=1000, reason=reason)
            except Exception:
                pass
            self.unregister(conn_id)
            warn(f"Admin disconnected client {conn_id} ({client.get('client_ip')})")

    async def disconnect_all(self, reason: str = "Disconnected by admin"):
        ids = list(self.connections.keys())
        for cid in ids:
            await self.disconnect(cid, reason)

    def get_all(self) -> list[dict]:
        res = []
        for cid, c in self.connections.items():
            res.append({
                "conn_id": cid,
                "client_ip": c.get("client_ip", "unknown"),
                "connected_at": c.get("connected_at", ""),
                "status": c.get("status", "idle"),
                "current_prompt": c.get("current_prompt", ""),
                "current_request_id": c.get("current_request_id", ""),
                "active_step": c.get("active_step", 0),
                "total_steps": c.get("total_steps", 0),
            })
        return res


class TaskQueueManager:
    """Serializes automation requests across multiple connected clients."""
    def __init__(self):
        self.active_conn_id: str | None = None
        self.active_task_info: dict | None = None
        self.queue: list[dict] = []

    def is_busy(self, current_conn_id: str) -> bool:
        return self.active_conn_id is not None and self.active_conn_id != current_conn_id

    def enqueue(self, conn_id: str, client_ip: str, prompt: str, request_id: str) -> tuple[dict, int]:
        task_info = {
            "task_id": f"task_{uuid.uuid4().hex[:6]}",
            "conn_id": conn_id,
            "client_ip": client_ip,
            "prompt": prompt,
            "request_id": request_id,
            "queued_at": datetime.now().strftime("%H:%M:%S"),
            "event": asyncio.Event(),
            "cancelled": False,
        }
        self.queue.append(task_info)
        return task_info, len(self.queue)

    def acquire_active(self, conn_id: str, task_info: dict):
        self.active_conn_id = conn_id
        self.active_task_info = task_info

    def release_active(self, conn_id: str):
        if self.active_conn_id == conn_id:
            self.active_conn_id = None
            self.active_task_info = None
            while self.queue:
                nxt = self.queue.pop(0)
                if not nxt.get("cancelled", False):
                    self.active_conn_id = nxt["conn_id"]
                    self.active_task_info = nxt
                    nxt["event"].set()
                    break

    def cancel_task(self, task_id: str) -> bool:
        for t in self.queue:
            if t.get("task_id") == task_id:
                t["cancelled"] = True
                t["event"].set()
                self.queue.remove(t)
                return True
        return False

    def remove_conn(self, conn_id: str):
        self.queue = [t for t in self.queue if t.get("conn_id") != conn_id]
        if self.active_conn_id == conn_id:
            self.release_active(conn_id)

    def get_status(self) -> dict:
        active_clean = None
        if self.active_task_info:
            active_clean = {
                "conn_id": self.active_task_info.get("conn_id"),
                "client_ip": self.active_task_info.get("client_ip"),
                "prompt": self.active_task_info.get("prompt"),
                "request_id": self.active_task_info.get("request_id"),
            }
        return {
            "active_task": active_clean,
            "queued_count": len(self.queue),
            "queue": [
                {
                    "position": i + 1,
                    "task_id": t["task_id"],
                    "conn_id": t["conn_id"],
                    "client_ip": t["client_ip"],
                    "prompt": t["prompt"],
                    "request_id": t["request_id"],
                    "queued_at": t["queued_at"],
                }
                for i, t in enumerate(self.queue)
            ]
        }


conn_manager = ConnectionManager()
task_queue = TaskQueueManager()

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Project Vision &bull; Server Control Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-heading: #f0f6fc;
      --accent: #58a6ff;
      --success: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
    .header h1 { font-size: 22px; color: var(--text-heading); display: flex; align-items: center; gap: 10px; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .badge { padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .badge-primary { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
    .badge-success { background: #23863633; color: #3fb950; border: 1px solid #238636; }
    .badge-warning { background: #9e6a0333; color: #d29922; border: 1px solid #9e6a03; }
    .badge-danger { background: #da363333; color: #f85149; border: 1px solid #da3633; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
    .card-title { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .card-val { font-size: 26px; font-weight: 700; color: var(--text-heading); }
    .card-sub { font-size: 12px; color: #8b949e; margin-top: 4px; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin: 20px 0 10px; }
    .section-header h2 { font-size: 16px; color: var(--text-heading); display: flex; align-items: center; gap: 8px; }
    table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); margin-bottom: 24px; }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
    th { background: #21262d; color: #8b949e; font-weight: 600; font-size: 12px; text-transform: uppercase; }
    tr:hover { background: #1f242c; }
    .btn { padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: all 0.15s ease-in-out; }
    .btn-danger { background: #da3633; color: #fff; }
    .btn-danger:hover { background: #b62324; }
    .btn-secondary { background: #21262d; color: var(--text); border-color: var(--border); }
    .btn-secondary:hover { background: #30363d; }
    .btn-primary { background: #238636; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .empty { text-align: center; padding: 24px; color: #8b949e; font-style: italic; }
    .prompt-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .live-dot { width: 8px; height: 8px; background: var(--success); border-radius: 50%; display: inline-block; box-shadow: 0 0 6px var(--success); animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #238636; color: #fff; padding: 10px 18px; border-radius: 6px; display: none; z-index: 999; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  </style>
</head>
<body>
  <div class="header">
    <h1>
      <span class="live-dot"></span> Project Vision &bull; Server Control Panel
      <span class="badge badge-primary">v2.3.0</span>
    </h1>
    <div class="header-actions">
      <label style="font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 6px; cursor: pointer;">
        <input type="checkbox" id="autoRefresh" checked> Auto-refresh (2s)
      </label>
      <button class="btn btn-secondary" onclick="fetchData()">Refresh</button>
      <button class="btn btn-danger" onclick="disconnectAll()">Disconnect All</button>
    </div>
  </div>

  <div class="stats">
    <div class="card">
      <div class="card-title">Connected Clients</div>
      <div class="card-val" id="statClients">0</div>
      <div class="card-sub">Active WebSocket extensions</div>
    </div>
    <div class="card">
      <div class="card-title">Active Automation</div>
      <div class="card-val" id="statActive">Idle</div>
      <div class="card-sub" id="statActiveSub">GPU ready for instructions</div>
    </div>
    <div class="card">
      <div class="card-title">Queued Requests</div>
      <div class="card-val" id="statQueue">0</div>
      <div class="card-sub">Waiting for execution slot</div>
    </div>
  </div>

  <div class="section-header">
    <h2>Connected Clients &amp; IPs</h2>
  </div>
  <table>
    <thead>
      <tr>
        <th>Client ID</th>
        <th>Client IP</th>
        <th>Connected At</th>
        <th>Status</th>
        <th>Current Prompt</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="connectionsBody">
      <tr><td colspan="6" class="empty">Loading connections...</td></tr>
    </tbody>
  </table>

  <div class="section-header">
    <h2>Request Queue</h2>
  </div>
  <table>
    <thead>
      <tr>
        <th>Position</th>
        <th>Task ID</th>
        <th>Client IP</th>
        <th>Prompt</th>
        <th>Queued At</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="queueBody">
      <tr><td colspan="6" class="empty">Queue is empty.</td></tr>
    </tbody>
  </table>

  <div class="toast" id="toast">Action successful</div>

  <script>
    function showToast(msg, isError = false) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.background = isError ? '#da3633' : '#238636';
      t.style.display = 'block';
      setTimeout(() => t.style.display = 'none', 2500);
    }

    async function fetchData() {
      try {
        const [connRes, qRes] = await Promise.all([
          fetch('/connections'),
          fetch('/queue')
        ]);
        const connections = await connRes.json();
        const queueData = await qRes.json();
        renderConnections(connections);
        renderQueue(queueData);
      } catch (err) {
        console.error('Failed to fetch data:', err);
      }
    }

    function renderConnections(list) {
      document.getElementById('statClients').textContent = list.length;
      const tbody = document.getElementById('connectionsBody');
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No clients connected.</td></tr>';
        return;
      }
      let html = '';
      for (const c of list) {
        let badgeClass = 'badge-primary';
        if (c.status === 'executing') badgeClass = 'badge-success';
        else if (c.status === 'queued') badgeClass = 'badge-warning';

        html += `<tr>
          <td><code>${c.conn_id}</code></td>
          <td><strong>${c.client_ip}</strong></td>
          <td>${c.connected_at}</td>
          <td><span class="badge ${badgeClass}">${c.status}</span></td>
          <td class="prompt-cell" title="${c.current_prompt || ''}">${c.current_prompt || '<span style="color:#8b949e;">-</span>'}</td>
          <td>
            <button class="btn btn-danger" onclick="disconnectClient('${c.conn_id}', '${c.client_ip}')">Disconnect</button>
          </td>
        </tr>`;
      }
      tbody.innerHTML = html;
    }

    function renderQueue(data) {
      const active = data.active_task;
      const queue = data.queue || [];
      document.getElementById('statQueue').textContent = queue.length;
      if (active) {
        document.getElementById('statActive').textContent = 'Running';
        document.getElementById('statActive').style.color = 'var(--success)';
        document.getElementById('statActiveSub').textContent = `${active.client_ip}: ${active.prompt.slice(0, 35)}...`;
      } else {
        document.getElementById('statActive').textContent = 'Idle';
        document.getElementById('statActive').style.color = 'var(--text-heading)';
        document.getElementById('statActiveSub').textContent = 'GPU ready for instructions';
      }

      const tbody = document.getElementById('queueBody');
      if (!queue.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">Queue is currently empty.</td></tr>';
        return;
      }
      let html = '';
      for (const q of queue) {
        html += `<tr>
          <td><strong>#${q.position}</strong></td>
          <td><code>${q.task_id}</code></td>
          <td>${q.client_ip}</td>
          <td class="prompt-cell" title="${q.prompt}">${q.prompt}</td>
          <td>${q.queued_at}</td>
          <td>
            <button class="btn btn-secondary" onclick="cancelTask('${q.task_id}')">Cancel</button>
          </td>
        </tr>`;
      }
      tbody.innerHTML = html;
    }

    async function disconnectClient(connId, ip) {
      if (!confirm(`Are you sure you want to disconnect client ${connId} (${ip})?`)) return;
      try {
        const res = await fetch(`/connections/disconnect/${connId}`, { method: 'POST' });
        if (res.ok) {
          showToast(`Disconnected ${connId}`);
          fetchData();
        } else {
          showToast('Failed to disconnect', true);
        }
      } catch (err) {
        showToast('Error: ' + err, true);
      }
    }

    async function disconnectAll() {
      if (!confirm('Are you sure you want to disconnect ALL connected clients?')) return;
      try {
        const res = await fetch('/connections/disconnect_all', { method: 'POST' });
        if (res.ok) {
          showToast('All clients disconnected');
          fetchData();
        }
      } catch (err) {
        showToast('Error: ' + err, true);
      }
    }

    async function cancelTask(taskId) {
      try {
        const res = await fetch(`/queue/cancel/${taskId}`, { method: 'POST' });
        if (res.ok) {
          showToast(`Cancelled task ${taskId}`);
          fetchData();
        }
      } catch (err) {
        showToast('Error: ' + err, true);
      }
    }

    setInterval(() => {
      const cb = document.getElementById('autoRefresh');
      if (cb && cb.checked) {
        fetchData();
      }
    }, 2000);

    fetchData();
  </script>
</body>
</html>
"""

app = FastAPI(title="Project Vision Browser Automation Server")


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "browser-automation-server",
        "version": SERVER_VERSION,
        "connected_clients": len(conn_manager.connections),
        "queued_tasks": len(task_queue.queue),
    }


@app.get("/", response_class=HTMLResponse)
@app.get("/dashboard", response_class=HTMLResponse)
@app.get("/admin", response_class=HTMLResponse)
async def dashboard_page():
    return HTMLResponse(DASHBOARD_HTML)


@app.get("/connections")
async def get_connections():
    return JSONResponse(conn_manager.get_all())


@app.post("/connections/disconnect/{conn_id}")
async def disconnect_connection(conn_id: str):
    await conn_manager.disconnect(conn_id, reason="Disconnected by server admin")
    return {"status": "ok", "disconnected": conn_id}


@app.post("/connections/disconnect_all")
async def disconnect_all_connections():
    await conn_manager.disconnect_all(reason="Disconnected by server admin")
    return {"status": "ok", "disconnected_all": True}


@app.get("/queue")
async def get_queue():
    return JSONResponse(task_queue.get_status())


@app.post("/queue/cancel/{task_id}")
async def cancel_queued_task(task_id: str):
    cancelled = task_queue.cancel_task(task_id)
    return {"status": "ok", "cancelled": cancelled}


async def send_agent_action(websocket, request_id, tab_id, step_index, is_last_step, inner_action):
    payload = {
        "type": "AGENT_ACTION",
        "request_id": request_id,
        "action_id": f"action_{uuid.uuid4().hex[:6]}",
        "step_index": step_index,
        "is_last_step": is_last_step,
        "action": inner_action,
    }
    if tab_id is not None:
        payload["tab_id"] = tab_id
    step_log(f"Sending AGENT_ACTION step {step_index + 1} -> {json.dumps(inner_action)}")
    await websocket.send_text(json.dumps(payload))


async def handle_rethink(
    websocket, active_prompt, failed_step, error_msg,
    completed_steps, remaining_steps, taskPlan, current_step_index,
    active_request_id, active_tab_id, last_screenshot, device_pixel_ratio, retry_count,
):
    """Use VLM to look at the screenshot + planner to generate corrective steps, then dispatch."""
    max_retries = 3
    if retry_count >= max_retries:
        warn(f"Max retries ({max_retries}) reached for step. Skipping it.")
        current_step_index += 1
        retry_count = 0
        return taskPlan, current_step_index, retry_count

    warn(f"Rethink triggered on failed step: '{failed_step}'")
    warn(f"Error: {error_msg}")

    vlm_reason = ""
    if last_screenshot:
        try:
            info("Running VLM visual analysis on failure screenshot...")
            vlm_reason = await asyncio.to_thread(
                reason_about_failure,
                base64_image=last_screenshot,
                user_goal=active_prompt,
                failed_step=failed_step,
                error_msg=error_msg,
                completed_steps=completed_steps,
            )
            info(f"VLM visual analysis: {vlm_reason}")
        except Exception as e:
            warn(f"VLM reasoning failed: {e}")

    combined_error = error_msg
    if vlm_reason:
        combined_error = f"{error_msg} | VLM sees: {vlm_reason}"

    info("Calling replanner with rethink context...")
    replan_res = await asyncio.to_thread(
        replanTask,
        user_prompt=active_prompt,
        failed_step=failed_step,
        error_msg=combined_error,
        completed_steps=completed_steps,
        remaining_steps=remaining_steps,
    )
    thought = replan_res.get("thought", "")
    new_steps = replan_res.get("steps", [failed_step])
    info(f"Rethink thought: {thought}")
    info(f"Corrective steps: {new_steps}")

    taskPlan = taskPlan[:current_step_index] + new_steps
    retry_count += 1

    if current_step_index < len(taskPlan):
        next_step = taskPlan[current_step_index]
        isDone = (current_step_index + 1) >= len(taskPlan)
        info(f"Predicting corrective action for '{next_step}'...")
        inner_action = await asyncio.to_thread(
            predict_action,
            base64_image=last_screenshot,
            current_step=next_step,
            step_index=current_step_index,
            is_last_step=isDone,
            device_pixel_ratio=device_pixel_ratio,
        )
        await send_agent_action(
            websocket=websocket,
            request_id=active_request_id,
            tab_id=active_tab_id,
            step_index=current_step_index,
            is_last_step=isDone,
            inner_action=inner_action,
        )

    return taskPlan, current_step_index, retry_count


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    client_host = websocket.client.host if websocket.client else "unknown"
    forwarded = websocket.headers.get("x-forwarded-for")
    client_ip = forwarded.split(",")[0].strip() if forwarded else client_host

    conn_id = f"conn_{uuid.uuid4().hex[:6]}"
    conn_manager.register(conn_id, client_ip, websocket)
    info(f"Connection established with Extension from {client_ip} (ID: {conn_id})")

    taskPlan = []
    completed_steps = []
    current_step_index = 0
    active_prompt = ""
    active_request_id = "req_001"
    active_tab_id = None
    retry_count = 0
    last_screenshot = ""
    device_pixel_ratio = 1.0
    # Highest step index whose success we have already counted. The extension
    # confirms each completed step TWICE (a standalone ACTION_RESULT AND a
    # screenshot with the same bundled action_result). We must count each step
    # exactly once, so we dedupe by this index rather than by message order.
    last_confirmed_step = -1

    # Form-fill state. 'form_mode' marks an active form-filling task.
    # 'form_stage' is "navigate" (still going to the form URL), "scan" (reading
    # fields across the whole scrollable form), or "fill" (filling the fields).
    form_mode = False
    form_stage = "navigate"
    form_fields_all = []
    form_scan_count = 0
    prev_scan_hash = ""

    try:
        while True:
            rawData = await websocket.receive_text()
            try:
                message = json.loads(rawData)
                msgType = message.get("type") if isinstance(message, dict) else "STRING_PROMPT"
            except json.JSONDecodeError:
                message = None
                msgType = "STRING_PROMPT"

            # ══════════════ Phase 1: User Prompt ══════════════
            if msgType in ["USER_PROMPT", "STRING_PROMPT"]:
                if isinstance(message, dict):
                    active_prompt = message.get("prompt", "").strip()
                    active_request_id = message.get("request_id", f"req_{uuid.uuid4().hex[:6]}")
                else:
                    active_prompt = rawData.strip()
                    active_request_id = f"req_{uuid.uuid4().hex[:6]}"

                if not active_prompt:
                    warn("Received empty prompt; ignoring.")
                    continue

                task_log(SEP)
                task_log(f"Received USER PROMPT from {client_ip} ({active_request_id}): '{active_prompt}'")

                # Queue check: if another connection is currently running an action
                if task_queue.is_busy(conn_id):
                    conn_manager.update(conn_id, status="queued", current_prompt=active_prompt, current_request_id=active_request_id)
                    task_info, pos = task_queue.enqueue(conn_id, client_ip, active_prompt, active_request_id)
                    task_log(f"Server busy. Enqueued prompt from {client_ip} (Queue Pos #{pos}): '{active_prompt}'")
                    await websocket.send_text(json.dumps({
                        "type": "QUEUE_STATUS",
                        "status": "queued",
                        "position": pos,
                        "message": f"Server is busy with another automation task. Your request is queued at #{pos}."
                    }))
                    await task_info["event"].wait()
                    if task_info.get("cancelled", False):
                        task_log(f"Queued task {task_info['task_id']} was cancelled.")
                        conn_manager.update(conn_id, status="idle")
                        continue

                task_queue.acquire_active(conn_id, {
                    "conn_id": conn_id,
                    "client_ip": client_ip,
                    "prompt": active_prompt,
                    "request_id": active_request_id,
                })
                conn_manager.update(conn_id, status="executing", current_prompt=active_prompt, current_request_id=active_request_id)
                await websocket.send_text(json.dumps({
                    "type": "QUEUE_STATUS",
                    "status": "active",
                    "message": "Starting task execution now."
                }))

                completed_steps = []
                current_step_index = 0
                retry_count = 0
                last_confirmed_step = -1

                # Form-fill goals get a dedicated pipeline instead of the generic planner.
                form_mode = is_form_goal(active_prompt)
                if form_mode:
                    form_url = extract_url(active_prompt)
                    task_log("Detected a FORM-FILL goal. Using form pipeline.")
                    if form_url:
                        task_log(f"  form url: {form_url}")
                        taskPlan = [f"navigate: {form_url}"]
                        form_stage = "navigate"
                    else:
                        task_log("  no url given; filling the form currently on screen.")
                        taskPlan = []
                        form_stage = "scan"
                    task_log(f"Form plan ({len(taskPlan)} steps):")
                    for i, step_ in enumerate(taskPlan):
                        task_log(f"    Step {i + 1}: {step_}")
                    conn_manager.update(conn_id, total_steps=len(taskPlan), active_step=0)
                    task_log("Waiting for initial screenshot from extension...")
                    continue

                task_log(f"Generating task plan with Qwen3 8B planner (ollama)...")
                taskPlan = await asyncio.to_thread(createPlan, active_prompt)
                form_stage = "navigate"

                task_log(f"Task plan generated ({len(taskPlan)} steps):")
                for i, step_ in enumerate(taskPlan):
                    task_log(f"    Step {i + 1}: {step_}")
                conn_manager.update(conn_id, total_steps=len(taskPlan), active_step=0)
                task_log("Waiting for initial screenshot from extension...")

            # ══════════════ Phase 2: Screenshots & Action Prediction ══════════════
            elif message and msgType in ["RAW_SCREENSHOT", "REDACTED_SCREENSHOT"]:
                active_request_id = message.get("request_id", active_request_id)
                active_tab_id = message.get("tab_id", active_tab_id)
                device_pixel_ratio = message.get("device_pixel_ratio", device_pixel_ratio)
                base64_img = message.get("image", "")
                img_type = msgType

                # Store the screenshot for later analysis + debugging
                shot_label = f"step{current_step_index + 1}"
                if base64_img:
                    last_screenshot = base64_img
                    saved = save_screenshot(base64_img, shot_label)
                    info(f"Received {img_type} screenshot ({len(base64_img)} chars) saved={saved}")

                # Handle bundled action_result (client confirms previous action).
                # The extension may also send a standalone ACTION_RESULT for the
                # same step, so dedupe by the confirmed step index.
                bundled = message.get("action_result")
                if isinstance(bundled, dict):
                    b_success = bundled.get("success") is True
                    b_step = bundled.get("step_index", current_step_index)
                    if b_success:
                        if form_mode and form_stage == "scan":
                            pass
                        elif b_step == last_confirmed_step + 1 and b_step < len(taskPlan):
                            completed_steps.append(taskPlan[b_step])
                            current_step_index = b_step + 1
                            last_confirmed_step = b_step
                            retry_count = 0
                            ok(f"Step {b_step + 1} confirmed success (bundled).")
                        else:
                            info(f"Bundled success for step {b_step + 1} ignored (already counted/out of range).")
                    else:
                        error_desc = bundled.get("error", "Client execution failed")
                        taskPlan, current_step_index, retry_count = await handle_rethink(
                            websocket, active_prompt, taskPlan[last_confirmed_step + 1], error_desc,
                            completed_steps, taskPlan[last_confirmed_step + 2:],
                            taskPlan, last_confirmed_step + 1, active_request_id, active_tab_id,
                            last_screenshot, device_pixel_ratio, retry_count,
                        )
                        last_confirmed_step = current_step_index - 1

                # ── Form-fill: scroll-aware scan across the form, then fill. ──
                if form_mode and form_stage == "navigate" and current_step_index >= len(taskPlan):
                    task_log("Navigate confirmed; starting form scan across viewports...")
                    form_stage = "scan"
                    form_scan_count = 0
                    form_fields_all = []
                    prev_scan_hash = ""

                if form_mode and form_stage == "scan" and last_screenshot:
                    # Early stop if screenshot hasn't changed (bottom of page reached)
                    cur_hash = hashlib.md5(last_screenshot.encode()).hexdigest()
                    if prev_scan_hash and cur_hash == prev_scan_hash:
                        task_log("Page reached bottom (screenshot identical to previous pass). Ending scan early.")
                        form_scan_count = MAX_FORM_SCAN
                    prev_scan_hash = cur_hash

                    if form_scan_count < MAX_FORM_SCAN:
                        task_log(f"Running form analysis on viewport pass {form_scan_count + 1}/{MAX_FORM_SCAN}...")
                        fields = await asyncio.to_thread(analyze_form, last_screenshot)
                        # Dedupe by normalized label (avoid re-adding same field from adjacent passes or asterisk differences)
                        existing_labels = {normalize_label(x.get("label", "")) for x in form_fields_all}
                        for f in fields:
                            nl = normalize_label(f.get("label", ""))
                            if nl and nl not in existing_labels:
                                form_fields_all.append(f)
                                existing_labels.add(nl)
                        form_scan_count += 1

                    if form_scan_count >= MAX_FORM_SCAN:
                        task_log(f"Scan complete ({form_scan_count} passes). Building fill plan...")
                        fill_plan = await asyncio.to_thread(build_form_fill_plan, form_fields_all)
                        if not fill_plan:
                            warn("Form scan produced no auto-fillable (non-PII) fields.")
                            task_log("Skipping PII/redacted fields. Task complete - user fills those.")
                            form_mode = False
                            task_queue.release_active(conn_id)
                            conn_manager.update(conn_id, status="idle", current_prompt="", current_request_id="", active_step=0, total_steps=0)
                            continue

                        # If we scrolled down during scanning, prepend a scroll up to return to the top
                        if form_scan_count > 1:
                            fill_plan = ["scroll: up"] + fill_plan

                        task_log(f"Form fill plan ({len(fill_plan)} steps):")
                        for i, s in enumerate(fill_plan):
                            task_log(f"    Fill step {i + 1}: {s}")
                        taskPlan = fill_plan
                        conn_manager.update(conn_id, total_steps=len(taskPlan), active_step=1)
                        completed_steps = []
                        current_step_index = 0
                        retry_count = 0
                        last_confirmed_step = -1
                        form_stage = "fill"
                        continue  # re-enter loop to execute first fill step

                    # Scroll to reveal next viewport; the next screenshot will
                    # be analyzed as the subsequent scan pass.
                    task_log(f"Scrolling down for next scan pass...")
                    await send_agent_action(
                        websocket=websocket,
                        request_id=active_request_id,
                        tab_id=active_tab_id,
                        step_index=current_step_index,
                        is_last_step=False,
                        inner_action={"action": "scroll", "direction": "down", "amount": 500,
                                      "step_index": current_step_index, "is_last_step": False, "found": True},
                    )
                    continue

                if not taskPlan:
                    warn("Screenshot received but taskPlan is empty.")
                    continue

                if current_step_index >= len(taskPlan):
                    ok("All planned steps executed successfully. Task complete.")
                    task_queue.release_active(conn_id)
                    conn_manager.update(conn_id, status="idle", current_prompt="", current_request_id="", active_step=0, total_steps=0)
                    continue

                currentSubGoal = taskPlan[current_step_index]
                isDone = (current_step_index + 1) >= len(taskPlan)

                conn_manager.update(conn_id, active_step=current_step_index + 1, total_steps=len(taskPlan))
                step_log(f"Executing step {current_step_index + 1}/{len(taskPlan)}: '{currentSubGoal}'")
                step_log(f"    is_last_step={isDone} | dpr={device_pixel_ratio} | tab_id={active_tab_id}")

                # During form navigation there is no separate "last step" sentinel,
                # so we must NOT mark the navigate as the last step. Otherwise the
                # extension skips its post-action screenshot (bg.ts only sends one
                # when !is_last_step) and the form analysis never fires.
                send_is_last = isDone
                if form_mode and form_stage == "navigate":
                    send_is_last = False

                try:
                    info("Calling Qwen2.5-VL (GPU) predict_action...")
                    inner_action = await asyncio.to_thread(
                        predict_action,
                        base64_image=last_screenshot,
                        current_step=currentSubGoal,
                        step_index=current_step_index,
                        is_last_step=send_is_last,
                        device_pixel_ratio=device_pixel_ratio,
                    )
                    step_log(f"VLM predicted action: {json.dumps(inner_action)}")

                    if inner_action.get("found") is False:
                        warn(f"Element '{currentSubGoal}' not located in viewport. Rethinking...")
                        taskPlan, current_step_index, retry_count = await handle_rethink(
                            websocket, active_prompt, currentSubGoal,
                            f"Element '{currentSubGoal}' not found in viewport.",
                            completed_steps, taskPlan[current_step_index + 1:],
                            taskPlan, current_step_index, active_request_id, active_tab_id,
                            last_screenshot, device_pixel_ratio, retry_count,
                        )
                        last_confirmed_step = current_step_index - 1
                        if current_step_index >= len(taskPlan):
                            ok("Task ended after rethink. No more steps.")
                            task_queue.release_active(conn_id)
                            conn_manager.update(conn_id, status="idle", current_prompt="", current_request_id="", active_step=0, total_steps=0)
                        else:
                            conn_manager.update(conn_id, active_step=current_step_index + 1, total_steps=len(taskPlan))
                        continue

                    await send_agent_action(
                        websocket=websocket,
                        request_id=active_request_id,
                        tab_id=active_tab_id,
                        step_index=current_step_index,
                        is_last_step=send_is_last,
                        inner_action=inner_action,
                    )

                except Exception as err:
                    error(f"Error generating action: {err}")
                    traceback.print_exc()
                    await websocket.send_text(json.dumps({
                        "type": "ERROR",
                        "request_id": active_request_id,
                        "error": str(err),
                    }))
                    task_queue.release_active(conn_id)
                    conn_manager.update(conn_id, status="idle", current_prompt="", current_request_id="", active_step=0, total_steps=0)

            # ══════════════ Phase 3: Standalone ACTION_RESULT ══════════════
            elif message and msgType == "ACTION_RESULT":
                result = message.get("result", {})
                success = result.get("success", False)
                step_idx = result.get("step_index", current_step_index)

                if success:
                    if form_mode and form_stage == "scan":
                        ok(f"Scan scroll pass executed successfully.")
                    elif step_idx == last_confirmed_step + 1 and step_idx < len(taskPlan):
                        completed_steps.append(taskPlan[step_idx])
                        current_step_index = step_idx + 1
                        last_confirmed_step = step_idx
                        retry_count = 0
                        ok(f"Step {step_idx + 1} executed successfully.")
                        if current_step_index >= len(taskPlan):
                            ok("All planned steps confirmed executed. Task complete.")
                            task_queue.release_active(conn_id)
                            conn_manager.update(conn_id, status="idle", current_prompt="", current_request_id="", active_step=0, total_steps=0)
                        else:
                            conn_manager.update(conn_id, active_step=current_step_index + 1)
                    else:
                        info(f"Standalone ACTION_RESULT for step {step_idx + 1} ignored (already counted/out of range).")
                else:
                    error_desc = result.get("error", "Unknown execution failure")
                    failed_i = last_confirmed_step + 1
                    if failed_i < len(taskPlan):
                        taskPlan, current_step_index, retry_count = await handle_rethink(
                            websocket, active_prompt, taskPlan[failed_i], error_desc,
                            completed_steps, taskPlan[failed_i + 1:],
                            taskPlan, failed_i, active_request_id, active_tab_id,
                            last_screenshot, device_pixel_ratio, retry_count,
                        )
                        last_confirmed_step = current_step_index - 1
                        if current_step_index >= len(taskPlan):
                            ok("Task ended after rethink. No more steps.")
                            task_queue.release_active(conn_id)
                            conn_manager.update(conn_id, status="idle", current_prompt="", current_request_id="", active_step=0, total_steps=0)
                        else:
                            conn_manager.update(conn_id, active_step=current_step_index + 1, total_steps=len(taskPlan))

    except WebSocketDisconnect:
        warn(f"Extension disconnected ({conn_id}).")
    except Exception as e:
        error(f"Unexpected error: {e}")
        traceback.print_exc()
    finally:
        task_queue.remove_conn(conn_id)
        conn_manager.disconnect(conn_id)


def print_banner():
    print()
    print("=" * 66)
    print("  Project Vision  |  Browser Automation Server")
    print(f"  VERSION: {SERVER_VERSION}")
    print("=" * 66)
    print()


if __name__ == "__main__":
    import uvicorn
    print_banner()
    info(f"Starting server v{SERVER_VERSION} on 0.0.0.0:8001")
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False, log_level="info")
