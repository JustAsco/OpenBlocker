#!/usr/bin/env python3
"""Packages extension/ as a zip for the Chrome Web Store and Firefox Add-ons
(AMO): dist-extension/openblocker-extension-<version>.zip

and a Firefox variant: dist-extension/openblocker-extension-<version>-firefox.zip

The manifest uses "incognito": "split" so Chromium can show the block page in
incognito tabs; Firefox doesn't support that (it would install the extension
as not allowed in private windows), so its zip leaves the key out. Upload the
first in the Chrome Web Store developer dashboard and the second on
addons.mozilla.org ("Submit a new add-on"); Mozilla signs it, after which
Firefox keeps it across restarts.
"""
import json, os, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")
OUT = os.path.join(ROOT, "dist-extension")

manifest = json.load(open(os.path.join(SRC, "manifest.json")))
version = manifest["version"]
firefox_manifest = {k: v for k, v in manifest.items() if k != "incognito"}
os.makedirs(OUT, exist_ok=True)
for suffix, mf in (("", manifest), ("-firefox", firefox_manifest)):
    target = os.path.join(OUT, f"openblocker-extension-{version}{suffix}.zip")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for folder, _, files in os.walk(SRC):
            for f in sorted(files):
                if f.startswith("."):
                    continue
                path = os.path.join(folder, f)
                rel = os.path.relpath(path, SRC)
                if rel == "manifest.json":
                    z.writestr(rel, json.dumps(mf, indent=2))
                else:
                    z.write(path, rel)
    print(target)
