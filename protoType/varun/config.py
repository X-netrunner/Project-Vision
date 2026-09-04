import os

# Base Directory Resolution
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Server & Network Settings
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000
WS_ENDPOINT = "/ws"
MAX_PAYLOAD_BYTES = 32 * 1024 * 1024  # 32 MB frame ceiling

# Model & Asset Paths
YUNET_MODEL_PATH = os.path.join(BASE_DIR, "face_detection_yunet_2023mar.onnx")
YUNET_MIN_EXPECTED_BYTES = 1_000_000  # sanity floor to catch truncated/corrupt downloads

# YuNet Face Detection Parameters
FACE_SCORE_THRESHOLD = 0.35  # Set to detect smaller icons/avatars
FACE_NMS_THRESHOLD = 0.3
FACE_TOP_K = 5000
FACE_INPUT_DIM = (320, 320)
FACE_PADDING_RATIO = 0.1

# PII & OCR Settings
NLP_SPACY_MODEL = "en_core_web_sm"
NLP_LANGUAGE = "en"
TEXT_PADDING_PX = 2
PII_CONFIDENCE_THRESHOLD = 0.35
LABEL_BLUR_LEAD_PX = 6  # Pulls blur box left to cover initial characters
PII_SPAN_MARGIN_RATIO = 0.6  # Extra per-side margin (fraction of estimated char width) added
                              # around regex-matched PII substrings, to absorb error from
                              # assuming uniform character width on proportional fonts.

# Form-Aware Spatial Thresholds (Vertically stacked forms like Google Forms)
FORM_VERTICAL_PROXIMITY_PX = 95
FORM_HORIZONTAL_ALIGN_TOLERANCE_PX = 120

# Trigger keywords for web form labels
FORM_LABEL_TRIGGERS = [
    "name", "full name", "first name", "last name",
    "email", "email address", "your email",
    "phone", "mobile", "contact number", "phone number",
    "address", "card", "card number", "ssn", "aadhaar", "pan"
]

# Sensitive Inline Field Labels (e.g., "Name: John Doe")
SENSITIVE_FIELD_LABELS = [
    "name", "email", "card", "phone", "ssn", "user", "holder", "account"
]

# Target Entities for Presidio NLP Engine
TARGET_PII_ENTITIES = [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "CRYPTO",
    "IBAN_CODE",
    "US_SSN",
    "US_BANK_NUMBER",
    "IP_ADDRESS",
]

# Blur & Compression Parameters
BLUR_KERNEL_DIVISOR = 3
BLUR_MIN_KERNEL_SIZE = 15
BLUR_SIGMA = 30
JPEG_COMPRESSION_QUALITY = 85

# Logging Settings
LOG_RETENTION_COUNT = 5   # Number of past session log files to keep on disk (oldest pruned first)
GC_COLLECT_INTERVAL = 20  # Run a full gc.collect() every N processed messages, not every single one