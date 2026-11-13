// Unit tests for the YouTube subscription parsing in extension/common.js.
// Run: node dev/extension_test.cjs
const fs = require("fs"); const vm = require("vm");
const ctx = { URL, console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require("path").join(__dirname, "../extension/common.js"), "utf8").replace(/^var api = .*$/m, "var api = {};"), ctx);
let fails = 0; const ok = (name, c) => { console.log((c ? "PASS " : "FAIL ") + name); if (!c) fails++; };
const id = (n) => "UC" + String(n).padStart(22, "x");
const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
  { itemSectionRenderer: { contents: [{ shelfRenderer: { content: { expandedShelfContentsRenderer: { items: [
    { channelRenderer: { channelId: id(1), title: { simpleText: "A \"quoted\" } name {" } } },
    { channelRenderer: { channelId: id(2) } }, { channelRenderer: { channelId: "not-an-id" } } ] } } } }] } },
  { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "TOKEN1" } } } } ] } } } }] } } };
const html = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script><script>ytcfg.set({"LOGGED_IN":true,"INNERTUBE_API_KEY":"k","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"2.2026"}}});</script>`;
const parsed = ctx.jsonAfter(html, "ytInitialData = ");
ok("finds ytInitialData despite braces and quotes inside strings", !!parsed);
const r = ctx.collectSubscriptions(parsed);
ok("collects valid channel ids only", JSON.stringify(r.ids) === JSON.stringify([id(1), id(2)]));
ok("finds the continuation token", r.token === "TOKEN1");
ok("reads INNERTUBE_CONTEXT", ctx.jsonAfter(html, '"INNERTUBE_CONTEXT":')?.client?.clientName === "WEB");
ok("signed in", ctx.signedIn(html) && !ctx.signedIn('"LOGGED_IN":false'));
const cont = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [{ gridChannelRenderer: { channelId: id(3) } }] } }] };
const r2 = ctx.collectSubscriptions(cont);
ok("continuation page: grid entries, no further token", r2.ids[0] === id(3) && r2.token === null);
ok("garbage is harmless", ctx.jsonAfter("ytInitialData = {broken", "ytInitialData = ") === null && ctx.collectSubscriptions(null).ids.length === 0);
console.log(fails + " failure(s)"); process.exit(fails ? 1 : 0);
