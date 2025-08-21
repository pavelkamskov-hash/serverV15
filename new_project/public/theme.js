(function () {
  function applySavedTheme() {
    const theme = localStorage.getItem('theme');
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }

  function initThemeToggle(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = document.documentElement.classList.contains('dark');
    el.addEventListener('change', toggleTheme);
  }

  window.initThemeToggle = initThemeToggle;
  window.toggleTheme = toggleTheme;
  applySavedTheme();
})();
