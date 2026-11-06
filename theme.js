/* FinPal Family - the look chosen on this phone (light or dark), set before the page shows, so it never flashes
   the other one. Without a choice the page follows the phone (prefers-color-scheme in styles.css). */
try {
  var t = localStorage.getItem('finpal.theme');
  if (t === 'light' || t === 'dark') {
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < m.length; i++) { m[i].removeAttribute('media'); m[i].setAttribute('content', t === 'dark' ? '#0E1620' : '#F6F2EA'); }
  }
} catch (e) { /* storage is off: the phone's setting decides */ }
