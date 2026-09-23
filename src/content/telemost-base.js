(() => {
  function publish() {
    const root = document.documentElement;
    if (!root) return false;
    try {
      root.dataset.mimicExt = chrome.runtime.getURL('');
    } catch {
      return false;
    }
    return Boolean(root.dataset.mimicExt);
  }

  if (publish()) return;
  const timer = setInterval(() => {
    if (publish()) clearInterval(timer);
  }, 10);
  setTimeout(() => clearInterval(timer), 3000);
})();
