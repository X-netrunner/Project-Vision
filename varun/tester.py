import asyncio
import base64
import io
import json
import threading
import tkinter as tk
from tkinter import filedialog, messagebox
from PIL import Image, ImageTk
import websockets

WS_URI = "ws://127.0.0.1:8000/ws"

class RedactionTestApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Redaction Pipeline Tester (Varun)")
        self.root.geometry("1100x650")
        self.root.configure(bg="#1e1e1e")

        # Top Control Bar
        top_bar = tk.Frame(root, bg="#2d2d2d", pady=10)
        top_bar.pack(fill=tk.X)

        self.btn_select = tk.Button(
            top_bar,
            text="Choose JPEG Image",
            font=("Arial", 12, "bold"),
            bg="#007acc",
            fg="white",
            padx=15,
            pady=5,
            command=self.select_and_process
        )
        self.btn_select.pack(side=tk.LEFT, padx=20)

        self.lbl_status = tk.Label(
            top_bar,
            text="Ready. Make sure app.py is running on :8000",
            font=("Arial", 11),
            bg="#2d2d2d",
            fg="#cccccc"
        )
        self.lbl_status.pack(side=tk.LEFT, padx=10)

        # Main Comparison Display Frame
        main_frame = tk.Frame(root, bg="#1e1e1e")
        main_frame.pack(fill=tk.BOTH, expand=True, padx=20, pady=20)

        # Left Column: Input Image
        left_box = tk.Frame(main_frame, bg="#252526", bd=2, relief=tk.GROOVE)
        left_box.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10)

        lbl_left_title = tk.Label(left_box, text="ORIGINAL (Unredacted)", font=("Arial", 12, "bold"), fg="#4ec9b0", bg="#252526")
        lbl_left_title.pack(pady=5)

        self.canvas_orig = tk.Label(left_box, bg="#1e1e1e")
        self.canvas_orig.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # Right Column: Output Image
        right_box = tk.Frame(main_frame, bg="#252526", bd=2, relief=tk.GROOVE)
        right_box.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=10)

        lbl_right_title = tk.Label(right_box, text="REDACTED (Returned by Pipeline)", font=("Arial", 12, "bold"), fg="#ce9178", bg="#252526")
        lbl_right_title.pack(pady=5)

        self.canvas_redacted = tk.Label(right_box, bg="#1e1e1e")
        self.canvas_redacted.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.img_orig_tk = None
        self.img_redact_tk = None

    def select_and_process(self):
        file_path = filedialog.askopenfilename(
            filetypes=[("Image files", "*.jpg *.jpeg *.png *.webp")]
        )
        if not file_path:
            return

        raw_pil = Image.open(file_path).convert("RGB")
        self.display_image(raw_pil, is_original=True)

        with open(file_path, "rb") as f:
            b64_data = base64.b64encode(f.read()).decode("utf-8")

        self.lbl_status.config(text="Sending frame to ws://127.0.0.1:8000/ws...", fg="#dcdcaa")

        threading.Thread(target=self.run_ws_query, args=(b64_data,), daemon=True).start()

    def run_ws_query(self, b64_image):
        async def query():
            try:
                async with websockets.connect(WS_URI, max_size=32 * 1024 * 1024) as ws:
                    payload = {
                        "type": "RAW_SCREENSHOT",
                        "request_id": "test_req_001",
                        "tab_id": 999,
                        "step_index": 1,
                        "image": f"data:image/jpeg;base64,{b64_image}",
                        "action_result": {"success": True, "action": "test_ping"}
                    }
                    await ws.send(json.dumps(payload))

                    response_raw = await ws.recv()
                    data = json.loads(response_raw)

                    if data.get("type") == "REDACTED_SCREENSHOT":
                        redacted_b64 = data.get("image")
                        latency_ms = data.get("processing_time_ms", 0.0)

                        if "," in redacted_b64:
                            redacted_b64 = redacted_b64.split(",", 1)[1]

                        img_bytes = base64.b64decode(redacted_b64)
                        redacted_pil = Image.open(io.BytesIO(img_bytes))

                        self.root.after(0, self.on_success, redacted_pil, latency_ms)
                    else:
                        err_msg = data.get("error", "Unknown server error")
                        self.root.after(0, self.on_failure, err_msg)

            except Exception as e:
                self.root.after(0, self.on_failure, str(e))

        asyncio.run(query())

    def on_success(self, pil_image, latency_ms):
        status_msg = f"Redacted & returned in {latency_ms} ms"
        self.lbl_status.config(text=status_msg, fg="#4ec9b0")
        self.display_image(pil_image, is_original=False)

    def on_failure(self, error_text):
        self.lbl_status.config(text=f"Error: {error_text}", fg="#f44747")
        messagebox.showerror("Connection / Redaction Error", f"Could not process image:\n\n{error_text}")

    def display_image(self, pil_img, is_original=True):
        max_w, max_h = 480, 480
        img_copy = pil_img.copy()
        img_copy.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
        tk_img = ImageTk.PhotoImage(img_copy)

        if is_original:
            self.img_orig_tk = tk_img
            self.canvas_orig.config(image=self.img_orig_tk)
        else:
            self.img_redact_tk = tk_img
            self.canvas_redacted.config(image=self.img_redact_tk)

if __name__ == "__main__":
    root = tk.Tk()
    app = RedactionTestApp(root)
    root.mainloop()