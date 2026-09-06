// Mobile navigation toggle. Served from public/ so the CSP (script-src 'self')
// admits it without inline hashes.
(function () {
  var toggle = document.getElementById('nav-toggle');
  var menu = document.getElementById('mobile-nav');
  if (!toggle || !menu) return;
  toggle.addEventListener('click', function () {
    var expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    menu.hidden = expanded;
  });
  menu.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.closest && target.closest('a')) {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
})();
