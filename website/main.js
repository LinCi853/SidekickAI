// Progressive enhancement: the page remains readable without JavaScript.
(() => {
  const menuToggle = document.querySelector('.menu-toggle');
  const mobileNav = document.querySelector('#mobile-nav');
  const mobileLayout = window.matchMedia('(max-width: 800px)');

  function closeMenu({ restoreFocus = false } = {}) {
    if (!menuToggle || !mobileNav) return;
    const wasOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', '打开导航菜单');
    mobileNav.hidden = true;
    if (restoreFocus && wasOpen) menuToggle.focus({ preventScroll: true });
  }

  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => {
      const open = menuToggle.getAttribute('aria-expanded') !== 'true';
      menuToggle.setAttribute('aria-expanded', String(open));
      menuToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
      mobileNav.hidden = !open;
    });
    mobileNav.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu({ restoreFocus: true });
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.site-header')) closeMenu();
    });
    mobileLayout.addEventListener('change', () => {
      if (!mobileLayout.matches) closeMenu();
    });
  }

  const demo = document.querySelector('[data-demo]');
  if (!demo) return;
  const tabs = [...demo.querySelectorAll('[role="tab"]')];
  const panels = [...demo.querySelectorAll('[role="tabpanel"]')];
  const toggleDemo = demo.querySelector('[data-toggle-demo]');
  const hideDemo = demo.querySelector('[data-hide-demo]');
  const shortcutAction = demo.querySelector('.shortcut-action');
  const caption = demo.querySelector('.demo-caption');
  const windowContent = demo.querySelector('.app-window');
  const restoredMessage = demo.querySelector('.restored-message');
  const captions = {
    ai: '熟悉的 AI，在手边相聚',
    notes: '一闪而过的灵感，也值得留下',
    board: '把思路画开，让想法自由生长',
    assets: '对话会结束，你的积累会留下',
  };

  function selectTab(tab, { focus = false } = {}) {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== tab.getAttribute('aria-controls');
    });
    if (caption) caption.textContent = captions[tab.dataset.tab];
    if (focus) tab.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        selectTab(tabs[next], { focus: true });
      }
    });
  });

  function setDemoOpen(open) {
    // Move focus before making the window inert when its close button is used.
    if (!open && windowContent?.contains(document.activeElement)) toggleDemo?.focus({ preventScroll: true });
    demo.dataset.open = String(open);
    if (windowContent) {
      windowContent.inert = !open;
      windowContent.setAttribute('aria-hidden', String(!open));
    }
    restoredMessage?.setAttribute('aria-hidden', String(open));
    toggleDemo?.setAttribute('aria-pressed', String(open));
    toggleDemo?.setAttribute('aria-label', `模拟 Alt + Space，${open ? '收起' : '唤出'}演示窗口`);
    if (shortcutAction) shortcutAction.textContent = open ? '收起小窗' : '唤出小窗';
    if (caption) caption.textContent = open ? captions[tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.tab] : '回到原来的窗口，继续手头的事';
  }
  toggleDemo?.addEventListener('click', () => setDemoOpen(demo.dataset.open !== 'true'));
  hideDemo?.addEventListener('click', () => setDemoOpen(false));

  // 60 秒短片：不写 autoplay，播放完全由这里接管；没有素材时这段不会生效。
  const film = document.querySelector('[data-film]');
  const filmButton = film?.querySelector('[data-film-play]');
  const filmVideo = film?.querySelector('video');
  filmButton?.addEventListener('click', () => {
    if (!filmVideo) return;
    filmVideo.hidden = false;
    filmButton.hidden = true;
    filmVideo.play().catch(() => { /* 自动播放被拒时由用户点播放键 */ });
    filmVideo.focus({ preventScroll: true });
  });
})();
