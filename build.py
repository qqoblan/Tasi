#!/usr/bin/env python3
"""يدمج src/engine.js و src/app.js داخل src/template.html لإنتاج index.html (ملف واحد)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
html = (ROOT / "src" / "template.html").read_text(encoding="utf-8")
html = html.replace("/*ENGINE*/", (ROOT / "src" / "engine.js").read_text(encoding="utf-8"))
html = html.replace("/*APP*/", (ROOT / "src" / "app.js").read_text(encoding="utf-8"))
(ROOT / "index.html").write_text(html, encoding="utf-8")
print("index.html built:", len(html), "bytes")
