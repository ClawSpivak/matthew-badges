#!/usr/bin/env python3
"""
Badge Scanner Server
Serves the badge scanner web app and handles AI identification via Claude vision.
"""

import json
import os
import base64
import uuid
import time
import io
import subprocess
import sys
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse
import urllib.request
import urllib.error

try:
    import openpyxl
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', 'openpyxl', '-q'])
    import openpyxl

try:
    from PIL import Image
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', 'Pillow', '-q'])
    from PIL import Image

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

PORT = 8282
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PHOTOS_DIR = os.path.join(BASE_DIR, "photos")
COLLECTION_FILE = os.path.join(BASE_DIR, "..", "state", "badge-collection.json")
OPENCLAW_CONFIG = os.path.expanduser("~/.openclaw/openclaw.json")

os.makedirs(PHOTOS_DIR, exist_ok=True)


def shrink_image(image_b64, mime_type='image/jpeg', max_px=1024, quality=82):
    """Resize image to max_px on longest side before sending to API."""
    try:
        raw = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(raw)).convert('RGB')
        w, h = img.size
        if max(w, h) > max_px:
            scale = max_px / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality)
        return base64.b64encode(buf.getvalue()).decode(), 'image/jpeg'
    except Exception:
        return image_b64, mime_type


def get_api_key():
    try:
        with open(OPENCLAW_CONFIG) as f:
            cfg = json.load(f)
        key = cfg.get("env", {}).get("OPENROUTER_API_KEY", "")
        if key:
            return key
    except Exception:
        pass
    return os.environ.get("OPENROUTER_API_KEY", "")


def identify_badge(image_b64, mime_type="image/jpeg"):
    image_b64, mime_type = shrink_image(image_b64, mime_type)
    api_key = get_api_key()
    if not api_key:
        return {"error": "No API key configured"}

    prompt = """You are a world-class expert on car badges, emblems, hood ornaments, wheel caps, and automotive logos — you have encyclopedic knowledge of every make and model ever produced.

A kid is showing you a photo of a car badge they found. Your job is to identify it. Be aggressive — always make your best identification even if the photo is blurry, partial, or at an angle. Look for:
- Shape of the emblem (shield, circle, oval, star, wings, etc.)
- Any letters or numbers visible, even partial
- Colors, chrome patterns, or distinctive design elements
- Country of origin clues (Italian styling, German precision, American chrome, Japanese minimalism)
- Mounting style (grille badge, trunk emblem, fender script, steering wheel center, wheel cap)

Common badges a kid might find at a swap meet or junkyard: Ford (oval, Mustang horse, F-150 script), Chevrolet (bowtie), Dodge (ram, fratzog), Pontiac (arrowhead), Oldsmobile (rocket), Buick (tri-shield), Cadillac (crest/wreath), Lincoln (star), Mercury (circle), AMC, Plymouth (barracuda/road runner), VW (circle/VW), BMW (roundel), Mercedes (star), Audi (four rings), Porsche (crest), Ferrari (prancing horse), Lamborghini (bull), Alfa Romeo (cross/serpent), Fiat, Lancia, Maserati (trident), Jaguar (leaper), Land Rover, Rolls Royce (RR/Spirit), Bentley (winged B), Opel (lightning), Peugeot (lion), Renault (diamond), Citroën (chevrons), Volvo (iron/arrow), Saab, Toyota (three ovals), Honda (H), Nissan/Datsun, Mazda (M-wings), Subaru (Pleiades stars), Mitsubishi (three diamonds), Suzuki, Isuzu, Triumph (globe), MG (octagon), Austin-Healey, and many more.

IMPORTANT: Even if you're not 100% sure, pick the most likely identification. Only set confidence to "low" as a last resort. A partially visible Chevy bowtie is still a Chevy bowtie.

Respond with ONLY a JSON object (no markdown, no code blocks):
{
  "make": "Ford",
  "model": "Mustang",
  "years": "1965-1973",
  "badge_name": "Running Horse Grille Emblem",
  "description": "The iconic galloping mustang horse, one of the most recognizable badges in American automotive history!",
  "fun_fact": "The Mustang was named after the WWII P-51 Mustang fighter plane, not the wild horse — though the horse logo stuck forever!",
  "rarity": "uncommon",
  "value_estimate": "$20-60",
  "confidence": "high"
}

Rarity guide:
- "common" = mass-produced, millions made (basic oval Ford badges, VW roundels, Chevy bowties from common cars)
- "uncommon" = specific model badges, older cars, less common variants
- "rare" = pre-1970s, limited production, specialty models, European exotics
- "very_rare" = pre-war, prototype, coachbuilt, ultra-limited production

Keep description and fun_fact exciting and kid-friendly (8-12 year old audience)!
If it's genuinely not a car badge, set make to "Unknown" and describe what it actually is."""

    payload = json.dumps({
        "model": "anthropic/claude-sonnet-4.6",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{image_b64}"}
                    },
                    {
                        "type": "text",
                        "text": prompt
                    }
                ]
            }
        ],
        "max_tokens": 800
    }).encode()

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://badge-hunter.local",
            "X-Title": "Badge Hunter"
        }
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
            content = resp["choices"][0]["message"]["content"].strip()
            # Strip markdown code blocks if present
            if content.startswith("```"):
                content = content.split("```")[1]
                if content.startswith("json"):
                    content = content[4:]
                content = content.strip()
            return json.loads(content)
    except Exception as e:
        return {"error": str(e), "make": "Unknown", "badge_name": "Unidentified Badge",
                "description": "Couldn't identify this one — try a clearer photo!", "confidence": "low"}


RARITY_ORDER = ['very_rare', 'rare', 'uncommon', 'common', '']

FILLS = {
    'very_rare': PatternFill('solid', fgColor='FFD700'),
    'rare':      PatternFill('solid', fgColor='FFB347'),
    'uncommon':  PatternFill('solid', fgColor='B0D4E8'),
    'common':    PatternFill('solid', fgColor='F0F0F0'),
    '':          PatternFill('solid', fgColor='F8F8F8'),
}
RARITY_LABEL = {
    'very_rare': '🔥 Very Rare',
    'rare':      '⭐⭐⭐ Rare',
    'uncommon':  '⭐⭐ Uncommon',
    'common':    '⭐ Common',
}
NAVY_FILL  = PatternFill('solid', fgColor='1D3557')
WHITE_BOLD = Font(bold=True, color='FFFFFF', size=11)
THIN       = Border(bottom=Side(style='thin', color='DDDDDD'))


def build_excel(badges):
    wb = Workbook()

    # ── Sheet 1: Full Collection ──────────────────────────────────────────
    ws = wb.active
    ws.title = 'Badge Collection'

    headers = ['#', 'Make', 'Model', 'Badge Name', 'Years', 'Rarity', 'Est. Value', 'Description', 'Fun Fact', 'Date Added']
    widths  = [4,   16,     20,      36,            14,      16,       12,            60,             60,          14]

    for ci, (h, w) in enumerate(zip(headers, widths), 1):
        c = ws.cell(1, ci, h)
        c.font = WHITE_BOLD
        c.fill = NAVY_FILL
        c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        ws.column_dimensions[get_column_letter(ci)].width = w
    ws.row_dimensions[1].height = 26
    ws.freeze_panes = 'A2'

    sorted_badges = sorted(badges, key=lambda b: RARITY_ORDER.index(b.get('rarity', '')) if b.get('rarity', '') in RARITY_ORDER else 99)

    for ri, b in enumerate(sorted_badges, 2):
        rarity = b.get('rarity', '')
        fill   = FILLS.get(rarity, FILLS[''])
        added  = b.get('added', '')[:10] if b.get('added') else ''
        row_data = [
            ri - 1,
            b.get('make', ''),
            b.get('model', ''),
            b.get('badge_name', ''),
            b.get('years', ''),
            RARITY_LABEL.get(rarity, rarity),
            b.get('value_estimate', ''),
            b.get('description', ''),
            b.get('fun_fact', ''),
            added,
        ]
        for ci, val in enumerate(row_data, 1):
            c = ws.cell(ri, ci, val)
            c.fill = fill
            c.alignment = Alignment(wrap_text=True, vertical='top')
            c.border = THIN
        ws.row_dimensions[ri].height = 60

    ws.auto_filter.ref = f'A1:{get_column_letter(len(headers))}1'

    # ── Sheet 2: Stats ────────────────────────────────────────────────────
    ws2 = wb.create_sheet('Stats')
    ws2.column_dimensions['A'].width = 22
    ws2.column_dimensions['B'].width = 10

    ws2['A1'] = "Matthew's Badge Collection"
    ws2['A1'].font = Font(bold=True, size=16, color='1D3557')
    ws2.merge_cells('A1:B1')
    ws2.row_dimensions[1].height = 28

    ws2['A2'] = f"Generated {datetime.now().strftime('%B %d, %Y')}"
    ws2['A2'].font = Font(italic=True, color='888888', size=10)
    ws2.merge_cells('A2:B2')

    counts = {}
    for b in badges:
        r = b.get('rarity', 'unknown')
        counts[r] = counts.get(r, 0) + 1
    makes = len(set(b.get('make', '') for b in badges if b.get('make')))

    stats = [
        ('Total Badges', len(badges)),
        ('Different Makes', makes),
        ('Very Rare 🔥', counts.get('very_rare', 0)),
        ('Rare ⭐⭐⭐', counts.get('rare', 0)),
        ('Uncommon ⭐⭐', counts.get('uncommon', 0)),
        ('Common ⭐', counts.get('common', 0)),
    ]

    for ri, (label, val) in enumerate(stats, 4):
        ws2.cell(ri, 1, label).font = Font(bold=True, color='1D3557')
        ws2.cell(ri, 2, val).alignment = Alignment(horizontal='center')
        ws2.cell(ri, 2).font = Font(bold=True, size=13, color='1D3557')
        for ci in range(1, 3):
            ws2.cell(ri, ci).border = THIN

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.read()


def load_collection():
    if os.path.exists(COLLECTION_FILE):
        with open(COLLECTION_FILE) as f:
            data = json.load(f)
            # Support both old format {"badges":[]} and new format with metadata
            if isinstance(data, list):
                return {"badges": data}
            return data
    return {"badges": []}


def save_collection(collection, badge_name=None):
    with open(COLLECTION_FILE, "w") as f:
        json.dump(collection, f, indent=2)
    # Push to GitHub in background so it doesn't slow down the response
    script = os.path.join(os.path.dirname(BASE_DIR), "push-badge.sh")
    if os.path.exists(script):
        label = badge_name or "badge"
        subprocess.Popen(["/bin/bash", script, label],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


MIME_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
}


class BadgeHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # Quiet logging

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/" or path == "/index.html":
            self.serve_file(os.path.join(BASE_DIR, "index.html"))
        elif path == "/gallery" or path == "/gallery.html":
            self.serve_file(os.path.join(BASE_DIR, "gallery.html"))
        elif path == "/api/collection":
            self.send_json(load_collection())
        elif path == "/api/export/excel":
            collection = load_collection()
            xlsx_bytes = build_excel(collection.get("badges", []))
            filename = f"MatthewBadges_{datetime.now().strftime('%Y-%m-%d')}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", len(xlsx_bytes))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(xlsx_bytes)
            return
        elif path.startswith("/photos/"):
            photo_name = path[8:]
            self.serve_file(os.path.join(PHOTOS_DIR, photo_name))
        else:
            file_path = os.path.join(BASE_DIR, path.lstrip("/"))
            if os.path.isfile(file_path):
                self.serve_file(file_path)
            else:
                self.send_json({"error": "Not found"}, 404)

    def serve_file(self, file_path):
        if not os.path.isfile(file_path):
            self.send_response(404)
            self.end_headers()
            return
        ext = os.path.splitext(file_path)[1].lower()
        mime = MIME_TYPES.get(ext, "application/octet-stream")
        with open(file_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", len(data))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/identify":
            body = json.loads(self.read_body())
            image_b64 = body.get("image", "")
            mime_type = body.get("mimeType", "image/jpeg")
            # Strip data URL prefix if present
            if "," in image_b64:
                image_b64 = image_b64.split(",", 1)[1]
            result = identify_badge(image_b64, mime_type)
            self.send_json(result)

        elif path == "/api/add":
            body = json.loads(self.read_body())
            badge_info = body.get("badge", {})
            image_b64 = body.get("image", "")
            mime_type = body.get("mimeType", "image/jpeg")

            # Save photo
            photo_filename = None
            if image_b64:
                if "," in image_b64:
                    image_b64 = image_b64.split(",", 1)[1]
                ext = ".jpg" if "jpeg" in mime_type else ".png"
                photo_filename = f"{uuid.uuid4().hex[:8]}{ext}"
                photo_path = os.path.join(PHOTOS_DIR, photo_filename)
                with open(photo_path, "wb") as f:
                    f.write(base64.b64decode(image_b64))

            # Add to collection
            collection = load_collection()
            entry = {
                "id": uuid.uuid4().hex[:8],
                "added": datetime.now().isoformat(),
                "photo": f"/photos/{photo_filename}" if photo_filename else None,
                **badge_info
            }
            collection["badges"].append(entry)
            save_collection(collection, badge_name=badge_info.get("badge_name"))
            self.send_json({"ok": True, "entry": entry})

        elif path.startswith("/api/badge/") and path.endswith("/update"):
            # Update badge identification in place, keeping same photo
            badge_id = path[11:-7]
            body = json.loads(self.read_body())
            new_info = body.get("badge", {})
            collection = load_collection()
            for i, b in enumerate(collection["badges"]):
                if b.get("id") == badge_id:
                    # Preserve id, added, photo — replace everything else
                    preserved = {k: b[k] for k in ("id", "added", "photo") if k in b}
                    collection["badges"][i] = {**preserved, **new_info}
                    save_collection(collection)
                    self.send_json({"ok": True, "entry": collection["badges"][i]})
                    return
            self.send_json({"error": "Not found"}, 404)

        elif path == "/api/reidentify":
            # Re-run AI identification on a badge's saved photo
            body = json.loads(self.read_body())
            badge_id = body.get("id")
            collection = load_collection()
            badge = next((b for b in collection["badges"] if b.get("id") == badge_id), None)
            if not badge or not badge.get("photo"):
                self.send_json({"error": "Badge or photo not found"}, 404)
                return
            photo_path = os.path.join(BASE_DIR, badge["photo"].lstrip("/"))
            if not os.path.isfile(photo_path):
                self.send_json({"error": "Photo file missing"}, 404)
                return
            with open(photo_path, "rb") as f:
                image_b64 = base64.b64encode(f.read()).decode()
            result = identify_badge(image_b64, "image/jpeg")
            self.send_json(result)

        else:
            self.send_json({"error": "Not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/badge/"):
            badge_id = path[11:]
            collection = load_collection()
            before = len(collection["badges"])
            collection["badges"] = [b for b in collection["badges"] if b.get("id") != badge_id]
            save_collection(collection)
            removed = before - len(collection["badges"])
            self.send_json({"ok": True, "removed": removed})
        else:
            self.send_json({"error": "Not found"}, 404)


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

if __name__ == "__main__":
    server = ThreadedHTTPServer(("0.0.0.0", PORT), BadgeHandler)
    print(f"🏆 Badge Hunter server running at http://localhost:{PORT}")
    print(f"   Photos stored in: {PHOTOS_DIR}")
    print(f"   Collection file:  {COLLECTION_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
