// Runs inside YouTube players embedded on other websites
// (youtube.com/embed/…, youtube-nocookie.com/embed/…). While only some
// channels are allowed, the player stays hidden and paused until the
// background script has checked the video's channel; a video from another
// channel is replaced by the block page. Playlists embedded as a whole
// ("videoseries") are followed video by video through the player's title link.

const BLOCK_PAGE = api.runtime.getURL("blocked.html");
const verdicts = new Map(); // video id -> { allowed, channel }
let restricted = false;
let checking = null; // video id being checked
let hideStyle = null;

function hidePlayer(on) {
  if (on) {
    if (!hideStyle) {
      hideStyle = document.createElement("style");
      hideStyle.textContent = "html { visibility: hidden !important; }";
    }
    if (!hideStyle.isConnected) (document.head || document.documentElement).append(hideStyle);
    // Hidden isn't silent: keep pausing until the verdict is in.
    for (const v of document.querySelectorAll("video")) if (!v.paused) v.pause();
  } else {
    hideStyle?.remove();
  }
}

/** The video playing now: from the player's title link (playlists), else from the address. */
function currentVideo() {
  const link = document.querySelector("a.ytp-title-link[href], a.ytp-youtube-button[href]");
  return (link && videoIdOf(link.href)) || videoIdOf(location.href);
}

async function check() {
  const { rules } = await api.storage.local.get("rules");
  restricted = !!rules?.youtubeChannels;
  if (!restricted) return hidePlayer(false);
  const id = currentVideo();
  if (!id) return hidePlayer(true); // a playlist that hasn't shown its first video yet
  const known = verdicts.get(id);
  if (known) {
    if (known.allowed) return hidePlayer(false);
    // Leaving the page stops YouTube's player for good.
    location.replace(`${BLOCK_PAGE}?r=channel&e=1&c=${encodeURIComponent(known.channel ?? "")}#${location.href}`);
    return;
  }
  hidePlayer(true);
  if (checking === id) return;
  checking = id;
  const verdict = await api.runtime.sendMessage({ type: "yt-embed", videoId: id }).catch(() => null);
  checking = null;
  if (verdict) verdicts.set(id, verdict);
  check();
}

check();
// Fast while a verdict is pending (pausing), relaxed otherwise.
setInterval(() => (restricted && hideStyle?.isConnected ? check() : null), 250);
setInterval(check, 1500);
api.storage.onChanged.addListener((c) => c.rules && (verdicts.clear(), check()));
