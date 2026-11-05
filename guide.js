/* fill the guide's addresses with this site's own, when it is opened from the hosted app */
(() => {
  if (!/^https:$/.test(location.protocol)) return;
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const values = { origin: location.origin, base, ref: location.origin + '/*' };
  document.querySelectorAll('[data-fill]').forEach(el => { el.textContent = values[el.dataset.fill] || el.textContent; });
})();
