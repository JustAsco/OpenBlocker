// Explains how to allow the extension in private windows. Opened by the
// background script when the app requires the extension and it can't run
// there; the app closes such browsers after a minute's warning.
const firefox = navigator.userAgent.includes("Firefox/");
const steps = firefox
  ? ["Open about:addons and click OpenBlocker.", "Set “Run in Private Windows” to “Allow”."]
  : ["Click the button below (or open your browser's extensions page and click “Details” on OpenBlocker).", "Turn on “Allow in Incognito” (Edge: “Allow in InPrivate”)."];
document.getElementById("steps").replaceChildren(
  ...steps.map((s) => {
    const li = document.createElement("li");
    li.textContent = s;
    return li;
  }),
);
const button = document.getElementById("open");
if (firefox) button.hidden = true;
button.onclick = () => {
  const host = navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
  api.tabs.create({ url: `${host}://extensions/?id=${api.runtime.id}` });
};
async function check() {
  if (await api.extension.isAllowedIncognitoAccess()) {
    document.getElementById("status").textContent = "Done! Private windows are covered now. You can close this tab.";
  }
}
check();
setInterval(check, 2000);
