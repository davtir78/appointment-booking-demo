// Host bar. When a site serves this demo as one of its tools, it names itself in "tool-host" meta
// tags and the demo draws a way back to that site across the top. Served on its own (GitHub Pages,
// a local server) there are no tags and no bar, so the demo stays domain-neutral. Tags:
//   <meta name="tool-host-name" content="Site name">      required
//   <meta name="tool-host-href" content="/">               required: the site's home
//   <meta name="tool-host-link" content="Label|/path">     optional, repeatable
// The same contract the Strategy Modeler uses.
(function () {
  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return ((el && el.getAttribute('content')) || '').trim();
  }
  var name = meta('tool-host-name');
  var href = meta('tool-host-href');
  if (!name || !href) return;

  var bar = document.createElement('nav');
  bar.className = 'host-bar';
  bar.setAttribute('aria-label', name);

  var home = document.createElement('a');
  home.className = 'host-home';
  home.href = href;
  home.innerHTML = '<span aria-hidden="true">← </span>';
  home.appendChild(document.createTextNode(name));
  bar.appendChild(home);

  var sep = document.createElement('span');
  sep.setAttribute('aria-hidden', 'true');
  sep.textContent = '/';
  bar.appendChild(sep);

  var current = document.createElement('span');
  current.className = 'host-current';
  current.textContent = 'Appointment Booking demo';
  bar.appendChild(current);

  Array.prototype.forEach.call(document.querySelectorAll('meta[name="tool-host-link"]'), function (m) {
    var parts = (m.getAttribute('content') || '').split('|').map(function (s) { return s.trim(); });
    if (!parts[0] || !parts[1]) return;
    var link = document.createElement('a');
    link.className = 'host-link';
    link.href = parts[1];
    link.textContent = parts[0];
    bar.appendChild(link);
  });

  document.body.insertBefore(bar, document.body.firstChild);
})();
