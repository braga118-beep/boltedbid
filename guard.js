// BoltedBid page guard: loaded first on every page.
(function () {
  // Never run inside another website's frame (stops "clickjacking": tricking someone into clicking
  // Accept or Sign on a hidden copy of the page).
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try { window.top.location = window.self.location.href; } catch (e) { /* the other site blocked it; the page stays hidden */ }
    return;
  }
  var page = document.documentElement.getAttribute('data-page');
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // Front page opened from an app installed before the front page existed: open the app instead.
  if (page === 'landing' && standalone) { location.replace('app.html#/dashboard'); return; }
  if (page === 'team') {
    // iPhone/iPad: install from the invite link so the app opens with the company code filled in.
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var mf = document.getElementById('mf');
    if (ios && mf && /[?&]code=/.test(location.search)) mf.href = 'team-ios.webmanifest';
    window.__bip = null;
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); window.__bip = e; document.dispatchEvent(new Event('bip')); });
  }
})();
