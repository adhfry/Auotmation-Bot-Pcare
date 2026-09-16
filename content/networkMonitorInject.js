// Runs in the MAIN world (the page's own JS context, not the isolated content-script
// world) so it can wrap `window.fetch` BEFORE PCare's own scripts run — this is the only
// way to actually see what PCare's AJAX calls return. The isolated-world content script
// (see domHelpers.js's networkMonitor listener) can't intercept fetches made by the page
// itself; it can only watch the DOM after the fact, which is exactly the blind spot that
// made "did getPemGeneralisTubuh actually return data?" impossible to answer from within
// the bot — we had to keep asking the user to check DevTools manually. Now we don't.
(function () {
  const WATCH_PATTERN = /EntriKunjunganDokkel\/(getPemGeneralisTubuh|getTindakanF1DetByPpk|getTindakanKapitasiF1DetByPpk|getHeaderObatByKunjungan|getMcuByKunjungan|getResepKacamata|getRiwayatPenyakitKeluarga|getRiwayat|getPendaftarByPpkNoUrutOrNoKartu)/i;

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const shouldWatch = WATCH_PATTERN.test(url);
    const response = await originalFetch.apply(this, args);
    if (shouldWatch) {
      try {
        const clone = response.clone();
        clone
          .text()
          .then((bodyText) => {
            let bodyPreview = bodyText.slice(0, 500);
            document.dispatchEvent(
              new CustomEvent('pcb-network-call', {
                detail: {
                  url: url.split('?')[0].split('/').slice(-2).join('/'), // short name, no huge query string
                  status: response.status,
                  ok: response.ok,
                  bodyPreview,
                  ts: Date.now(),
                },
              })
            );
          })
          .catch(() => {});
      } catch (_) {
        // best-effort diagnostics only, never let this break the page's own fetch
      }
    }
    return response;
  };

  // Drives select2 directly through PCare's own jQuery instead of simulating clicks on the
  // rendered dropdown. Real-cursor clicking on select2 options turned out to depend on OS
  // screen-coordinate math (CSS pixel vs. physical pixel, display scaling, window position)
  // that proved unreliable in practice across different machines/displays — this bypasses
  // that entirely by calling the same jQuery API select2's own docs recommend for scripted
  // value changes: `$(select).val(value).trigger('change')`. Only reachable from the
  // isolated-world content script via the 'pcb-jquery-select2-set' custom event bridge,
  // since jQuery/select2 live in this page's own JS context, not the extension's.
  document.addEventListener('pcb-jquery-select2-set', (ev) => {
    const { reqId, selectId, optionText, exact, append } = ev.detail || {};
    let ok = false;
    let error = null;
    let matchedValue = null;
    try {
      const $ = window.jQuery || window.$;
      const select = document.getElementById(selectId);
      if (!$ || typeof $ !== 'function') throw new Error('jQuery tidak ditemukan di halaman ini.');
      if (!select) throw new Error(`Elemen <select id="${selectId}"> tidak ditemukan.`);
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const wantedNorm = norm(optionText);
      const options = Array.from(select.options);
      const match = options.find((o) => {
        const text = norm(o.textContent);
        return exact ? text === wantedNorm : text.toLowerCase().includes(wantedNorm.toLowerCase());
      });
      if (!match) throw new Error(`Opsi "${optionText}" tidak ditemukan di antara ${options.length} opsi <select>.`);
      matchedValue = match.value;
      if (select.multiple) {
        let current = ($(select).val() || []).slice();
        if (append) {
          if (!current.includes(matchedValue)) current.push(matchedValue);
        } else {
          current = [matchedValue];
        }
        $(select).val(current).trigger('change');
      } else {
        $(select).val(matchedValue).trigger('change');
      }
      ok = true;
    } catch (err) {
      error = err.message;
    }
    document.dispatchEvent(
      new CustomEvent('pcb-jquery-select2-set-result', { detail: { reqId, ok, error, matchedValue } })
    );
  });
})();
