const status = document.getElementById("status");
document.getElementById("grant").onclick = async () => {
  const ok = await api.permissions.request({ origins: ["<all_urls>"] });
  status.textContent = ok ? "All set! You can close this tab." : "Permission wasn't granted. Blocking won't work until it is.";
};
