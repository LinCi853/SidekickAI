(function () {
  try {
    var html = document.documentElement;
    var isOxy = localStorage.getItem('sidekick-ui-version') !== 'classic';
    html.setAttribute('data-ui-version', isOxy ? 'oxy' : 'classic');

    if (isOxy) {
      html.classList.remove('dark');
      html.setAttribute('data-theme', 'light');
      html.setAttribute('data-oxy', 'true');
      var height = window.screen.height;
      html.setAttribute('data-oxy-scale', height <= 1080 ? 'compact' : height <= 1440 ? 'standard' : 'spacious');
      var color = localStorage.getItem('sidekick-active-app-color');
      if (color) {
        html.style.setProperty('--primary', color);
        html.style.setProperty('--brand-500', color);
      }
    } else {
      var preference = localStorage.getItem('ai-window-theme') || 'light';
      var dark = preference === 'dark' || preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches;
      html.classList.toggle('dark', dark);
      html.setAttribute('data-theme', dark ? 'dark' : 'light');
      html.setAttribute('data-ui-scale', localStorage.getItem('sidekick-user-ui-scale') || 'medium');
    }
  } catch (_) {}
})();
