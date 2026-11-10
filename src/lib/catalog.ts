// Built-in knowledge used for autosuggestions and one-click presets.

export interface SiteSuggestion {
  domain: string;
  name: string;
  category: CategoryId;
  /** Extra domains that belong to the same service (CDNs, short links…). */
  related?: string[];
}

export interface AppSuggestion {
  name: string;
  exe: string;
  category: CategoryId;
}

export type CategoryId = "social" | "video" | "gaming" | "news" | "shopping" | "chat" | "music" | "gambling" | "adult" | "browsers";

export const CATEGORIES: Record<CategoryId, { name: string; emoji: string; color: string }> = {
  social: { name: "Social media", emoji: "💬", color: "#8b5cf6" },
  video: { name: "Video & streaming", emoji: "📺", color: "#ef4444" },
  gaming: { name: "Gaming", emoji: "🎮", color: "#10b981" },
  news: { name: "News & forums", emoji: "📰", color: "#f59e0b" },
  shopping: { name: "Shopping", emoji: "🛒", color: "#ec4899" },
  chat: { name: "Messaging", emoji: "📱", color: "#3b82f6" },
  music: { name: "Music", emoji: "🎵", color: "#14b8a6" },
  gambling: { name: "Gambling", emoji: "🃏", color: "#f97316" },
  adult: { name: "Adult", emoji: "🔞", color: "#a3a3a3" },
  browsers: { name: "Web browsers", emoji: "🌐", color: "#06b6d4" },
};

export const SITES: SiteSuggestion[] = [
  // social
  { domain: "instagram.com", name: "Instagram", category: "social", related: ["cdninstagram.com"] },
  { domain: "tiktok.com", name: "TikTok", category: "social", related: ["tiktokcdn.com", "tiktokv.com"] },
  { domain: "facebook.com", name: "Facebook", category: "social", related: ["fb.com", "fbcdn.net"] },
  { domain: "x.com", name: "X (Twitter)", category: "social", related: ["twitter.com", "t.co", "twimg.com"] },
  { domain: "reddit.com", name: "Reddit", category: "social", related: ["redd.it", "redditmedia.com", "old.reddit.com"] },
  { domain: "snapchat.com", name: "Snapchat", category: "social" },
  { domain: "linkedin.com", name: "LinkedIn", category: "social" },
  { domain: "pinterest.com", name: "Pinterest", category: "social" },
  { domain: "tumblr.com", name: "Tumblr", category: "social" },
  { domain: "threads.net", name: "Threads", category: "social" },
  { domain: "bsky.app", name: "Bluesky", category: "social" },
  { domain: "9gag.com", name: "9GAG", category: "social" },
  { domain: "imgur.com", name: "Imgur", category: "social" },
  // video
  { domain: "youtube.com", name: "YouTube", category: "video", related: ["youtu.be", "ytimg.com", "youtube-nocookie.com"] },
  { domain: "netflix.com", name: "Netflix", category: "video", related: ["nflxvideo.net"] },
  { domain: "twitch.tv", name: "Twitch", category: "video" },
  { domain: "primevideo.com", name: "Prime Video", category: "video" },
  { domain: "disneyplus.com", name: "Disney+", category: "video" },
  { domain: "hulu.com", name: "Hulu", category: "video" },
  { domain: "max.com", name: "Max", category: "video" },
  { domain: "crunchyroll.com", name: "Crunchyroll", category: "video" },
  { domain: "vimeo.com", name: "Vimeo", category: "video" },
  { domain: "kick.com", name: "Kick", category: "video" },
  { domain: "dailymotion.com", name: "Dailymotion", category: "video" },
  // gaming
  { domain: "store.steampowered.com", name: "Steam Store", category: "gaming", related: ["steamcommunity.com"] },
  { domain: "epicgames.com", name: "Epic Games", category: "gaming" },
  { domain: "roblox.com", name: "Roblox", category: "gaming" },
  { domain: "chess.com", name: "Chess.com", category: "gaming" },
  { domain: "lichess.org", name: "Lichess", category: "gaming" },
  { domain: "poki.com", name: "Poki", category: "gaming" },
  { domain: "crazygames.com", name: "CrazyGames", category: "gaming" },
  { domain: "miniclip.com", name: "Miniclip", category: "gaming" },
  // news & forums
  { domain: "news.ycombinator.com", name: "Hacker News", category: "news" },
  { domain: "cnn.com", name: "CNN", category: "news" },
  { domain: "bbc.com", name: "BBC", category: "news", related: ["bbc.co.uk"] },
  { domain: "nytimes.com", name: "New York Times", category: "news" },
  { domain: "theguardian.com", name: "The Guardian", category: "news" },
  { domain: "foxnews.com", name: "Fox News", category: "news" },
  { domain: "spiegel.de", name: "Der Spiegel", category: "news" },
  { domain: "bild.de", name: "BILD", category: "news" },
  { domain: "theverge.com", name: "The Verge", category: "news" },
  { domain: "4chan.org", name: "4chan", category: "news" },
  { domain: "quora.com", name: "Quora", category: "news" },
  // shopping
  { domain: "amazon.com", name: "Amazon", category: "shopping", related: ["amazon.de", "amazon.co.uk"] },
  { domain: "ebay.com", name: "eBay", category: "shopping", related: ["ebay.de"] },
  { domain: "aliexpress.com", name: "AliExpress", category: "shopping" },
  { domain: "temu.com", name: "Temu", category: "shopping" },
  { domain: "shein.com", name: "SHEIN", category: "shopping" },
  { domain: "etsy.com", name: "Etsy", category: "shopping" },
  { domain: "zalando.com", name: "Zalando", category: "shopping", related: ["zalando.de"] },
  // chat
  { domain: "discord.com", name: "Discord", category: "chat", related: ["discord.gg", "discordapp.com"] },
  { domain: "web.whatsapp.com", name: "WhatsApp Web", category: "chat" },
  { domain: "web.telegram.org", name: "Telegram Web", category: "chat" },
  { domain: "messenger.com", name: "Messenger", category: "chat" },
  // music
  { domain: "open.spotify.com", name: "Spotify Web", category: "music" },
  { domain: "soundcloud.com", name: "SoundCloud", category: "music" },
  { domain: "music.youtube.com", name: "YouTube Music", category: "music" },
  // gambling
  { domain: "bet365.com", name: "bet365", category: "gambling" },
  { domain: "stake.com", name: "Stake", category: "gambling" },
  { domain: "pokerstars.com", name: "PokerStars", category: "gambling" },
  { domain: "draftkings.com", name: "DraftKings", category: "gambling" },
  { domain: "tipico.de", name: "Tipico", category: "gambling" },
  // adult (a few large ones – a full list import is on the roadmap)
  { domain: "pornhub.com", name: "Pornhub", category: "adult" },
  { domain: "xvideos.com", name: "XVideos", category: "adult" },
  { domain: "xnxx.com", name: "XNXX", category: "adult" },
  { domain: "xhamster.com", name: "xHamster", category: "adult" },
  { domain: "onlyfans.com", name: "OnlyFans", category: "adult" },
  { domain: "chaturbate.com", name: "Chaturbate", category: "adult" },
];

export const APPS: AppSuggestion[] = [
  { name: "Steam", exe: "steam.exe", category: "gaming" },
  { name: "Epic Games Launcher", exe: "EpicGamesLauncher.exe", category: "gaming" },
  { name: "Battle.net", exe: "Battle.net.exe", category: "gaming" },
  { name: "Riot Client", exe: "RiotClientServices.exe", category: "gaming" },
  { name: "League of Legends", exe: "LeagueClient.exe", category: "gaming" },
  { name: "Valorant", exe: "VALORANT.exe", category: "gaming" },
  { name: "EA app", exe: "EADesktop.exe", category: "gaming" },
  { name: "Ubisoft Connect", exe: "UbisoftConnect.exe", category: "gaming" },
  { name: "GOG Galaxy", exe: "GalaxyClient.exe", category: "gaming" },
  { name: "Xbox app", exe: "XboxPcApp.exe", category: "gaming" },
  { name: "Roblox", exe: "RobloxPlayerBeta.exe", category: "gaming" },
  { name: "Minecraft Launcher", exe: "MinecraftLauncher.exe", category: "gaming" },
  { name: "Fortnite", exe: "FortniteClient-Win64-Shipping.exe", category: "gaming" },
  { name: "Counter-Strike 2", exe: "cs2.exe", category: "gaming" },
  { name: "Dota 2", exe: "dota2.exe", category: "gaming" },
  { name: "Overwatch", exe: "Overwatch.exe", category: "gaming" },
  { name: "Discord", exe: "Discord.exe", category: "chat" },
  { name: "Telegram", exe: "Telegram.exe", category: "chat" },
  { name: "WhatsApp", exe: "WhatsApp.exe", category: "chat" },
  { name: "Signal", exe: "Signal.exe", category: "chat" },
  { name: "Messenger", exe: "Messenger.exe", category: "chat" },
  { name: "Slack", exe: "slack.exe", category: "chat" },
  { name: "Spotify", exe: "Spotify.exe", category: "music" },
  { name: "VLC", exe: "vlc.exe", category: "video" },
  { name: "Netflix", exe: "Netflix.exe", category: "video" },
  { name: "Google Chrome", exe: "chrome.exe", category: "browsers" },
  { name: "Mozilla Firefox", exe: "firefox.exe", category: "browsers" },
  { name: "Microsoft Edge", exe: "msedge.exe", category: "browsers" },
  { name: "Brave", exe: "brave.exe", category: "browsers" },
  { name: "Opera", exe: "opera.exe", category: "browsers" },
  { name: "Opera GX", exe: "opera_gx.exe", category: "browsers" },
  { name: "Vivaldi", exe: "vivaldi.exe", category: "browsers" },
];

/** All domains for a site including related ones. */
export const expandSite = (s: SiteSuggestion) => [s.domain, ...(s.related ?? [])];

export const siteName = (domain: string) => SITES.find((s) => s.domain === domain)?.name;

/** Fuzzy-ish score: prefix match beats substring match. */
export function score(query: string, ...fields: string[]): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let best = 0;
  for (const f of fields) {
    const t = f.toLowerCase();
    if (t === q) best = Math.max(best, 100);
    else if (t.startsWith(q)) best = Math.max(best, 80 - t.length / 10);
    else if (t.split(/[\s.\-_]/).some((w) => w.startsWith(q))) best = Math.max(best, 60 - t.length / 10);
    else if (t.includes(q)) best = Math.max(best, 40 - t.length / 10);
  }
  return best;
}
