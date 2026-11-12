#!/usr/bin/env python3
"""Security and behaviour tests for the background service's local API.

Builds dev/service-harness (the real service code without Tauri), runs it with
a throwaway data folder and checks, over HTTP like the app and the extension:
request hardening, lock enforcement, unlocks, the password, the emergency
reset, community lists and the extension bridge.

    python3 dev/service_api_test.py

Needs Rust and free ports 47613/47614. Works on Linux, macOS and Windows.
"""
import http.client, json, os, socket, subprocess, sys, tempfile, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SVC, BRIDGE = 47614, 47613
failures = 0


def call(method, path, body=None, port=SVC, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"X-OpenBlocker-Service": "1", "X-OpenBlocker": "1", "Content-Type": "application/json"} if headers is None else headers
    data = body if isinstance(body, (bytes, str)) or body is None else json.dumps(body)
    c.request(method, path, data, h)
    r = c.getresponse()
    raw = r.read()
    try:
        return r.status, json.loads(raw) if raw else None
    except ValueError:
        return r.status, raw


def bridge(path):
    return call("GET", path, port=BRIDGE, headers={"X-OpenBlocker": "1", "Host": f"127.0.0.1:{BRIDGE}"})


def check(name, cond):
    global failures
    print(("PASS " if cond else "FAIL ") + name)
    failures += 0 if cond else 1


def clone(x):
    return json.loads(json.dumps(x))


def main():
    subprocess.run(["cargo", "build", "-q"], cwd=os.path.join(HERE, "service-harness"), check=True)
    exe = os.path.join(HERE, "service-harness", "target", "debug", "service-harness" + (".exe" if os.name == "nt" else ""))
    data = tempfile.mkdtemp(prefix="ob-service-")
    proc = subprocess.Popen([exe], env={**os.environ, "OPENBLOCKER_SERVICE_DIR": data}, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                call("GET", "/svc/v1/status?since=0")
                break
            except OSError:
                time.sleep(0.25)
        run_tests()
    finally:
        proc.terminate()
    print(f"\n{failures} failure(s)")
    sys.exit(1 if failures else 0)


def run_tests():
    # ── request hardening ──
    code, st = call("GET", "/svc/v1/status?since=0")
    check("status answers", code == 200 and "seq" in st)
    check("no state before the app published one", call("GET", "/svc/v1/state")[0] == 404)
    check("missing custom header refused", call("GET", "/svc/v1/status", headers={"Host": f"127.0.0.1:{SVC}"})[0] == 404)
    check("DNS-rebinding Host refused", call("GET", "/svc/v1/status", headers={"X-OpenBlocker-Service": "1", "Host": f"evil.com:{SVC}"})[0] == 404)
    check("web page Origin refused", call("GET", "/svc/v1/status", headers={"X-OpenBlocker-Service": "1", "Host": f"127.0.0.1:{SVC}", "Origin": "https://evil.com"})[0] == 404)
    check("bridge refuses without header", call("GET", "/v1/rules", port=BRIDGE, headers={"Host": f"127.0.0.1:{BRIDGE}"})[0] == 404)
    s = socket.create_connection(("127.0.0.1", SVC))
    s.sendall(f"POST /svc/v1/state HTTP/1.1\r\nHost: 127.0.0.1:{SVC}\r\nX-OpenBlocker-Service: 1\r\nContent-Length: 40000000\r\n\r\n".encode())
    check("oversized body refused (413)", b" 413 " in s.recv(200))
    s.close()
    check("malformed state refused", call("POST", "/svc/v1/state", "{not json")[0] == 400)

    # ── locks ──
    now = int(time.time() * 1000)
    state = {
        "version": 2,
        "categories": [{"id": "social", "name": "Social", "color": "#000", "icon": "x", "sites": ["instagram.com"], "apps": []}],
        "lists": [{"id": "social", "name": "Social", "color": "#000", "icon": "x", "categories": ["social"],
                   "sites": ["reddit.com", "youtube.com/shorts", "127.0.0.1", "tauri.localhost"], "apps": []}],
        "schedules": [], "sessions": [], "settings": {}, "stats": {},
    }
    code, g = call("POST", "/svc/v1/state", state)
    check("first publish accepted", code == 200 and "generation" in g)
    locked = clone(state)
    locked["sessions"] = [{"id": "s1", "listId": "social", "startedAt": now, "endsAt": now + 3600_000, "lock": "timer"}]
    check("adding a lock accepted", call("POST", "/svc/v1/state", locked)[0] == 200)
    time.sleep(1.5)
    code, rules = bridge("/v1/rules?b=chrome&v=9")
    check("local addresses never reach the rules", "127.0.0.1" not in rules["blocked"] and "tauri.localhost" not in rules["blocked"] and "reddit.com" in rules["blocked"])
    code, body = call("POST", "/svc/v1/state", state)
    check("stopping a timer lock refused (409 + service state)", code == 409 and body["state"]["sessions"][0]["id"] == "s1")
    shrunk = clone(locked)
    shrunk["lists"][0]["sites"] = ["reddit.com"]
    check("removing from a locked list refused", call("POST", "/svc/v1/state", shrunk)[0] == 409)
    excepted = clone(locked)
    excepted["lists"][0]["exceptSites"] = ["instagram.com"]
    check("new exception on a locked list refused", call("POST", "/svc/v1/state", excepted)[0] == 409)
    grown = clone(locked)
    grown["lists"][0]["sites"].append("x.com")
    check("adding to a locked list accepted", call("POST", "/svc/v1/state", grown)[0] == 200)
    check("no unlock text for a timer lock", call("POST", "/svc/v1/challenge", {"key": "s1"})[0] == 400)

    # ── community lists + bridge ──
    check("community list upload", call("PUT", "/svc/v1/source?id=social", "huge1.com\nhuge2.com\nnot a domain\n127.0.0.1")[0] == 200)
    check("path traversal in source id refused", call("PUT", "/svc/v1/source?id=..%2F..%2Fevil", "a.com")[0] == 400)
    withsrc = clone(grown)
    withsrc["categories"][0]["source"] = {"url": "u", "name": "n", "updatedAt": now, "count": 2}
    call("POST", "/svc/v1/state", withsrc)
    time.sleep(1.5)
    code, rules = bridge("/v1/rules?b=chrome&v=9.9&a=" + urllib.parse.quote("https://www.reddit.com/r/x"))
    check("rules include list, category and community list", {"huge1.com", "instagram.com", "x.com", "reddit.com"} <= set(rules["blocked"]) and "127.0.0.1" not in rules["blocked"])
    check("paths go to blockedPaths", rules["blockedPaths"] == ["youtube.com/shorts"])
    code, again = bridge("/v1/rules?b=chrome&r=" + rules["rev"])
    check("unchanged rules aren't resent", again.get("unchanged") is True)
    code, st = call("GET", "/svc/v1/status?since=0")
    check("heartbeat reported", any(b["exe"] == "chrome.exe" for b in st["browsers"]))
    bridge("/v1/rules?b=firefox&v=9&i=0")
    code, st = call("GET", "/svc/v1/status?since=0")
    check("private-window permission reported", next(b for b in st["browsers"] if b["exe"] == "firefox.exe")["incognito"] is False)
    nosrc = clone(withsrc)
    nosrc["categories"][0]["source"] = None
    check("dropping a locked category's community list refused", call("POST", "/svc/v1/state", nosrc)[0] == 409)

    # ── typed unlock + generations ──
    texted = clone(withsrc)
    texted["sessions"].append({"id": "t1", "listId": "social", "startedAt": now, "endsAt": now + 3600_000, "lock": "text"})
    code, g = call("POST", "/svc/v1/state", texted)
    gen = g["generation"]
    code, ch = call("POST", "/svc/v1/challenge", {"key": "t1"})
    check("unlock text handed out", code == 200 and len(ch["text"]) >= 10)
    check("wrong text refused", call("POST", "/svc/v1/unlock", {"key": "t1", "answer": "nope"})[0] == 403)
    code, g2 = call("POST", "/svc/v1/unlock", {"key": "t1", "answer": ch["text"]})
    check("right text unlocks and bumps the generation", code == 200 and g2["generation"] == gen + 1)
    code, body = call("POST", f"/svc/v1/state?gen={gen}", texted)
    check("a stale state can't bring the unlocked block back", code == 409 and all(x["id"] != "t1" for x in body["state"]["sessions"]))
    current = body["state"]
    check("publishing on the new generation works", call("POST", f"/svc/v1/state?gen={g2['generation']}", current)[0] == 200)

    # ── password ──
    check("too short password refused", call("POST", "/svc/v1/password", {"current": None, "new": "abc"})[0] == 403)
    code, pw = call("POST", "/svc/v1/password", {"current": None, "new": "hunter22"})
    check("password set (Argon2 hash)", code == 200 and pw["password"].startswith("$argon2"))
    check("changing without the current password refused", call("POST", "/svc/v1/password", {"current": "wrong", "new": "x1234"})[0] == 403)
    time.sleep(3.1)
    code, st = call("GET", "/svc/v1/state")
    tampered = clone(st)
    tampered["password"] = None
    check("removing the password by publishing refused", call("POST", f"/svc/v1/state?gen={pw['generation']}", tampered)[0] == 409)
    pwlocked = clone(st)
    pwlocked["sessions"].append({"id": "p1", "listId": "social", "startedAt": now, "endsAt": now + 3600_000, "lock": "password"})
    call("POST", f"/svc/v1/state?gen={pw['generation']}", pwlocked)
    check("no unlock text for a password lock", call("POST", "/svc/v1/challenge", {"key": "p1"})[0] == 400)
    check("wrong password refused", call("POST", "/svc/v1/unlock", {"key": "p1", "answer": "nope"})[0] == 403)
    code, body = call("POST", "/svc/v1/unlock", {"key": "p1", "answer": "hunter22"})
    check("right password right after a wrong one is braked", code == 403 and "attempts" in body["error"].lower())
    time.sleep(3.1)
    check("password removal refused while a password lock runs", call("POST", "/svc/v1/password", {"current": "hunter22", "new": None})[0] == 403)
    time.sleep(3.1)
    code, body = call("POST", "/svc/v1/unlock", {"key": "p1", "answer": "hunter22"})
    check("right password unlocks", code == 200)
    gen = body["generation"]
    code, st = call("GET", "/svc/v1/state")
    check("password session gone, timer session kept", [x["id"] for x in st["sessions"]] == ["s1"])

    # ── password for schedules (also limits and the focus timer) ──
    allday = lambda id, pw: {"id": id, "listId": "tv", "days": list(range(7)), "start": 0, "end": 0, "locked": True, "password": pw, "label": None}
    sched = clone(st)
    sched["lists"].append({**sched["lists"][0], "id": "tv", "name": "TV"})
    sched["schedules"] = [allday("strict", False), allday("escape", True)]
    check("locked schedules published", call("POST", f"/svc/v1/state?gen={gen}", sched)[0] == 200)
    loosened = clone(sched)
    loosened["schedules"][0]["password"] = True
    check("adding a password escape to a running lock refused", call("POST", f"/svc/v1/state?gen={gen}", loosened)[0] == 409)
    skipped = clone(sched)
    skipped["skips"] = [{"refId": "strict", "until": now + 86400_000}]
    check("the app can't skip a locked schedule itself", call("POST", f"/svc/v1/state?gen={gen}", skipped)[0] == 409)
    check("a schedule without the escape can't be ended", call("POST", "/svc/v1/unlock", {"key": "strict", "answer": "hunter22"})[0] == 403)
    time.sleep(3.1)
    check("wrong password for a schedule refused", call("POST", "/svc/v1/unlock", {"key": "escape", "answer": "nope"})[0] == 403)
    time.sleep(3.1)
    code, body = call("POST", "/svc/v1/unlock", {"key": "escape", "answer": "hunter22"})
    check("right password ends the schedule for now", code == 200)
    code, st = call("GET", "/svc/v1/state")
    check("skipped until its end, schedule kept", [x["refId"] for x in st["skips"]] == ["escape"] and len(st["schedules"]) == 2)

    # ── emergency reset ──
    check("reset without text refused while locked", call("POST", "/svc/v1/unlock", {"key": "__reset__"})[0] == 403)
    code, ch = call("POST", "/svc/v1/challenge", {"key": "__reset__"})
    check("reset text is long", len(ch["text"]) >= 300)
    check("reset with the text works", call("POST", "/svc/v1/unlock", {"key": "__reset__", "answer": ch["text"]})[0] == 200)
    code, st = call("GET", "/svc/v1/state")
    check("everything reset, password included", st["sessions"] == [] and st.get("password") is None and len(st["lists"]) == 3)
    check("nothing locked any more: any state accepted", call("POST", "/svc/v1/state", state)[0] == 200)


if __name__ == "__main__":
    main()
