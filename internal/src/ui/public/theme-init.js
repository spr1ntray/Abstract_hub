(() => {
  const storageKey = 'abstract-hub-theme';

  function preferredTheme() {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function apply(theme) {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  }

  apply(preferredTheme());
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey) apply(preferredTheme());
  });
})();
