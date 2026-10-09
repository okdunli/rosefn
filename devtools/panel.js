(() => {
  const url = document.getElementById('url');
  const stateEl = document.getElementById('state');
  const prefetchEl = document.getElementById('prefetch');

  const READ = `(function () {
    var r = window.__rosefn;
    if (!r || typeof r.state !== 'function') return JSON.stringify({ rosefn: false });
    var out = { rosefn: true, url: location.pathname };
    try { out.state = JSON.parse(r.state()); } catch (e) { out.state = '(unreadable: ' + e + ')'; }
    try { out.prefetch = typeof r.prefetch === 'function' ? r.prefetch() : null; }
    catch (e) { out.prefetch = '(unreadable: ' + e + ')'; }
    return JSON.stringify(out);
  })()`;

  const show = (el, value, dim) => {
    el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    el.classList.toggle('dim', !!dim);
  };

  let alive = true;
  window.addEventListener('unload', () => { alive = false; });

  const read = () => {
    if (!alive) return;
    chrome.devtools.inspectedWindow.eval(READ, (result, exception) => {
      if (!alive) return;
      if (exception || !result) {
        url.textContent = exception ? `evaluation failed: ${exception.description || exception.code}` : 'no page';
        url.classList.add('dim');
        return;
      }
      let data;
      try { data = JSON.parse(result); } catch { return; }
      url.classList.remove('dim');
      if (!data.rosefn) {
        url.textContent = data.url || '(unknown)';
        stateEl.textContent = 'no rosefn runtime in this document - a zero-JS route (the compiler ships no bundle) or a page this framework did not render';
        stateEl.classList.add('dim');
        prefetchEl.textContent = '-';
        prefetchEl.classList.add('dim');
        return;
      }
      url.textContent = data.url;
      const entries = data.state && typeof data.state === 'object' ? Object.keys(data.state) : [];
      show(stateEl, data.state, entries.length === 0);
      if (entries.length === 0) stateEl.textContent = '(no signals yet - the route declares none, or none have been read)';
      show(prefetchEl, data.prefetch ?? '(the seam answered nothing)', data.prefetch == null);
    });
  };

  read();
  setInterval(read, 1000);
})();
