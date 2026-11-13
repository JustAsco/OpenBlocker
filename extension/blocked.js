const target = decodeURIComponent(location.hash.slice(1));
const params = new URLSearchParams(location.search);
// "channel": a YouTube video from a channel that isn't allowed right now.
const reason = params.get("r");
const channel = params.get("c");
const host = reason === "channel" ? "This video" : hostOf(target) || "This site";
const QUOTES = [
  "You chose to focus. Future you says thanks.",
  "The urge passes in about 90 seconds. Breathe.",
  "Small wins add up. This is one of them.",
  "Distraction is a habit. So is focus.",
  "What were you about to do before this?",
];

document.getElementById("host").textContent = host;
document.getElementById("quote").textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];
document.getElementById("back").onclick = () => (history.length > 2 ? history.go(-2) : api.tabs.getCurrent((t) => api.tabs.update(t.id, { url: "about:blank" })));
document.getElementById("close").onclick = () => api.tabs.getCurrent((t) => api.tabs.remove(t.id));

function fmt(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function render() {
  const { rules, ytSubs } = await api.storage.local.get(["rules", "ytSubs"]);
  // Unblocked in the meantime? Go to the page the user wanted. For channels
  // the background script decides (it knows subscriptions and channel ids).
  const stillBlocked =
    reason === "channel"
      ? !!rules?.youtubeChannels && !(await api.runtime.sendMessage({ type: "channel-allowed", channel: channel ?? "" }).catch(() => false))
      : !rules || isBlocked(target, rules);
  if (target && rules && !stillBlocked) {
    location.replace(target);
    return;
  }
  if (!rules) return;
  if (reason === "channel") {
    const subs = rules.youtubeSubscriptions;
    document.getElementById("why").textContent = subs
      ? `is from ${channel || "a channel"}, which you aren't subscribed to and isn't on your list of allowed YouTube channels.`
      : `is from ${channel || "a channel"}, which isn't on your list of allowed YouTube channels.`;
    const box = document.getElementById("allowed");
    box.hidden = false;
    let note = "";
    if (subs && ytSubs?.status === "signed-out") note = " Your subscriptions can't be read: sign in to YouTube in this browser.";
    else if (subs && ytSubs?.status === "error") note = " Your subscriptions couldn't be read right now; OpenBlocker tries again in a few minutes.";
    else if (subs && ytSubs?.status === "ok") note = ` Plus the ${ytSubs.ids.length} channels you're subscribed to.`;
    box.querySelector("p").textContent = (rules.youtubeChannels.length ? "Allowed channels:" : "") + note;
    document.getElementById("allowed-list").replaceChildren(
      ...rules.youtubeChannels.slice(0, 30).map((c) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `https://www.youtube.com/${c.startsWith("UC") ? "channel/" + c : c}`;
        a.textContent = c;
        li.append(a);
        return li;
      }),
    );
    const parts = [];
    if (rules.lists?.length) parts.push(rules.lists.join(" · "));
    if (rules.until) parts.push(`until ${fmt(rules.until)}`);
    document.getElementById("meta").textContent = parts.join(" — ");
    return;
  }
  const allowlist = rules.allowOnly && !domainMatches(host, rules.blocked || []);
  document.getElementById("why").textContent = allowlist ? "isn't on your allowlist right now." : "is blocked right now.";
  const parts = [];
  if (rules.lists?.length) parts.push(rules.lists.join(" · "));
  if (rules.until) parts.push(`until ${fmt(rules.until)}`);
  document.getElementById("meta").textContent = parts.join(" — ");
  const box = document.getElementById("allowed");
  box.hidden = !allowlist;
  if (allowlist) {
    const ul = document.getElementById("allowed-list");
    ul.replaceChildren(
      ...rules.allowOnly.slice(0, 30).map((d) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "https://" + d;
        a.textContent = d;
        li.append(a);
        return li;
      }),
    );
  }
}

render();
setInterval(render, 2000);
