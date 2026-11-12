#!/usr/bin/env python3
"""Packages extension/ as a zip for the Chrome Web Store and Firefox Add-ons
(AMO): dist-extension/openblocker-extension-<version>.zip

Both stores accept the same zip (manifest.json at the root). Upload it in the
Chrome Web Store developer dashboard and on addons.mozilla.org ("Submit a new
add-on"); Mozilla signs it, after which Firefox keeps it across restarts.
"""
import json, os, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")
OUT = os.path.join(ROOT, "dist-extension")

version = json.load(open(os.path.join(SRC, "manifest.json")))["version"]
os.makedirs(OUT, exist_ok=True)
target = os.path.join(OUT, f"openblocker-extension-{version}.zip")
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    for folder, _, files in os.walk(SRC):
        for f in sorted(files):
            if f.startswith("."):
                continue
            path = os.path.join(folder, f)
            z.write(path, os.path.relpath(path, SRC))
print(target)
