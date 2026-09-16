// Plain-DOM helpers used by every flow module. This runs INSIDE the user's own real
// Chrome tab (content script), not through Playwright/CDP — so a click here is a click
// the browser itself sees as genuine, and the page is exactly what the user is looking at.
// No separate browser process, no profile, nothing to get "stuck on a blank tab" about.
(function (global) {
  const PCB = global.PCB || (global.PCB = {});

  // Rolling buffer of PCare's OWN page-level JS errors (uncaught exceptions + rejected
  // promises) — not our content script's, the SITE's. If a click like "No.Kunjungan"
  // triggers a handler that throws (e.g. because of a stale index, an unexpected null,
  // whatever), the data it was supposed to load simply never arrives, and our own polling
  // just times out with no clue why. Surfacing PCare's actual error text (see
  // recentPageErrors(), used by pelayananFlow.js's vitals-load failure) beats guessing at
  // more timing fixes for a problem that was never about timing.
  const PAGE_ERROR_LOG = [];
  function recordPageError(message) {
    PAGE_ERROR_LOG.push(`[${new Date().toLocaleTimeString('id-ID')}] ${message}`);
    if (PAGE_ERROR_LOG.length > 20) PAGE_ERROR_LOG.shift();
  }
  window.addEventListener('error', (e) => {
    recordPageError(`${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    recordPageError(`Promise rejected: ${e.reason?.message || e.reason}`);
  });
  function recentPageErrors() {
    return PAGE_ERROR_LOG.slice(-5); // timestamps are embedded in each line already
  }

  // Rolling log of PCare's own AJAX calls (URL, status, response body preview) for the
  // specific endpoints that feed the riwayat/Kunjungan detail view — captured by
  // content/networkMonitorInject.js, which runs in the MAIN world (the only place that
  // can see fetch() calls PCare's own script makes) and relays them here via a DOM
  // CustomEvent. This is what finally answers "did getPemGeneralisTubuh actually return
  // data?" directly, instead of asking the user to read DevTools Network tab by hand.
  const NETWORK_LOG = [];
  document.addEventListener('pcb-network-call', (e) => {
    const { url, status, ok, bodyPreview } = e.detail || {};
    NETWORK_LOG.push(`[${new Date().toLocaleTimeString('id-ID')}] ${url} -> HTTP ${status}${ok ? '' : ' (FAILED)'}: ${bodyPreview}`);
    if (NETWORK_LOG.length > 15) NETWORK_LOG.shift();
  });
  function recentNetworkCalls() {
    return NETWORK_LOG.slice(-8);
  }

  /**
   * Sets a select2 dropdown's value via PCare's own jQuery (see the
   * 'pcb-jquery-select2-set' listener in networkMonitorInject.js, the only place that can
   * reach the page's real jQuery instance) instead of simulating a click on the rendered
   * option. Real-cursor clicking on select2 options depends on OS screen-coordinate math
   * (CSS pixel vs. physical pixel, display scaling, window position) that proved unreliable
   * in practice — this calls the exact same `$(select).val(x).trigger('change')` API
   * select2's own documentation recommends for scripted value changes, so there's no cursor,
   * no coordinates, and no click simulation involved at all.
   */
  function setSelect2ValueViaJQuery(selectId, optionText, { exact = true, append = false, timeoutMs = 3000 } = {}) {
    return new Promise((resolve) => {
      const reqId = `s2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let settled = false;
      const onResult = (e) => {
        if (!e.detail || e.detail.reqId !== reqId) return;
        cleanup();
        resolve(e.detail);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, error: 'Timeout menunggu respons dari halaman (jQuery mungkin belum siap).' });
      }, timeoutMs);
      function cleanup() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener('pcb-jquery-select2-set-result', onResult);
      }
      document.addEventListener('pcb-jquery-select2-set-result', onResult);
      document.dispatchEvent(
        new CustomEvent('pcb-jquery-select2-set', { detail: { reqId, selectId, optionText, exact, append } })
      );
    });
  }

  // Background can't reach into a content script's in-flight await chain to cancel it —
  // but it CAN send this tab a plain message the instant Stop is clicked (see
  // background.js's 'STOP' handler and content/main.js's PCB_STOP listener), which sets
  // this flag. Every poll loop below checks it every ~150-200ms, so a long chain of
  // waitFor-based retries (pickDate's calendar retries, field lookups, etc.) now unwinds
  // within one poll tick of Stop being clicked, instead of only being noticed between
  // whole page-navigation steps.
  let stopRequested = false;
  function requestStop() {
    stopRequested = true;
  }
  function resetStopFlag() {
    stopRequested = false;
  }

  /** Thrown by waitFor when Stop was clicked mid-poll — marked so main.js can report a
   * clean stop instead of a patient error (see content/main.js's handleAction). */
  class ContentStopped extends Error {
    constructor() {
      super('Dihentikan oleh pengguna (Stop).');
      this.pcbStopped = true;
    }
  }

  function humanPause(minMs = 250, maxMs = 700) {
    const ms = minMs + Math.random() * (maxMs - minMs);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Polls `fn` until it returns a truthy value or `timeoutMs` elapses (then returns null/false). Aborts immediately (throws ContentStopped) if Stop was clicked. */
  async function waitFor(fn, timeoutMs = 8000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stopRequested) throw new ContentStopped();
      const result = await fn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  // Tried multiplying by window.devicePixelRatio here to compensate for Windows display
  // scaling (CSS pixels vs. the physical pixels nut-js's mouse.setPosition expects) — but
  // confirmed live this made real clicks land WORSE, drifting further off the further down
  // the target was. Reverted: whatever the actual scaling relationship is on this machine,
  // it isn't a flat devicePixelRatio multiply on the whole coordinate. Left as plain CSS-pixel
  // math (the original, previously-working behavior for the datepicker/riwayat button).
  // Select2 picking no longer depends on this path at all — see setSelect2ValueViaJQuery.
  function toScreenPoint(el) {
    const rect = el.getBoundingClientRect();
    const targetX = rect.x + rect.width / 2 + (Math.random() * 6 - 3);
    const targetY = rect.y + rect.height / 2 + (Math.random() * 6 - 3);
    const chromeHeight = window.outerHeight - window.innerHeight;
    return {
      x: Math.round(window.screenX + targetX),
      y: Math.round(window.screenY + chromeHeight + targetY),
    };
  }

  // ------------------------------------------------------------------------------------
  // Fake on-page cursor. Requested explicitly: the bot must never hijack the user's real
  // OS mouse just to show "where it's about to click" — that was requestCursorMove()'s old
  // job, moving the actual system cursor via the native host on every single humanClick.
  // This draws the bot's OWN cursor icon as a `position: fixed` <img> inside the PAGE
  // instead, positioned with plain CSS (getBoundingClientRect, viewport-relative — no OS
  // screen coordinates, no DPI scaling math, none of the problems that caused real clicks
  // to land in the wrong place). The user's real mouse is never touched for this.
  // ------------------------------------------------------------------------------------
  const FAKE_CURSOR_ID = '__pcb_fake_cursor__';
  let fakeCursorIconFile = 'blue_cursor.png';
  let fakeCursorHideTimer = null;

  try {
    chrome.storage?.local?.get(['cursorIcon'], (res) => {
      if (res && res.cursorIcon) fakeCursorIconFile = res.cursorIcon;
      const existing = document.getElementById(FAKE_CURSOR_ID);
      if (existing) existing.src = chrome.runtime.getURL(`icons/${fakeCursorIconFile}`);
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes.cursorIcon) {
        fakeCursorIconFile = changes.cursorIcon.newValue || fakeCursorIconFile;
        const existing = document.getElementById(FAKE_CURSOR_ID);
        if (existing) existing.src = chrome.runtime.getURL(`icons/${fakeCursorIconFile}`);
      }
    });
  } catch (_) {
    // storage not available for some reason — cursor just uses the default icon
  }

  function ensureFakeCursor() {
    let cursor = document.getElementById(FAKE_CURSOR_ID);
    if (!cursor) {
      cursor = document.createElement('img');
      cursor.id = FAKE_CURSOR_ID;
      cursor.src = chrome.runtime.getURL(`icons/${fakeCursorIconFile}`);
      Object.assign(cursor.style, {
        position: 'fixed',
        width: '30px',
        height: '30px',
        pointerEvents: 'none',
        zIndex: '2147483647',
        left: '0px',
        top: '0px',
        opacity: '0',
        transition: 'left 140ms ease-out, top 140ms ease-out, opacity 150ms ease-out',
        filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))',
      });
      (document.body || document.documentElement).appendChild(cursor);
    }
    return cursor;
  }

  /** Moves the bot's own on-page cursor icon to `el` — never touches the real OS cursor. */
  function moveFakeCursorTo(el) {
    try {
      const cursor = ensureFakeCursor();
      const rect = el.getBoundingClientRect();
      cursor.style.left = `${Math.round(rect.x + rect.width / 2 - 4)}px`;
      cursor.style.top = `${Math.round(rect.y + rect.height / 2 - 4)}px`;
      cursor.style.opacity = '1';
      clearTimeout(fakeCursorHideTimer);
      fakeCursorHideTimer = setTimeout(() => {
        cursor.style.opacity = '0';
      }, 2500);
    } catch (_) {
      // purely visual, never fatal
    }
  }

  /** Best-effort human-readable name for an element, used in verbose action logs. */
  function describeElement(el) {
    if (!el) return '(elemen tidak diketahui)';
    const text = textOf(el);
    if (text) return `"${text.slice(0, 60)}"`;
    if (el.placeholder) return `field "${el.placeholder}"`;
    if (el.name) return `field "${el.name}"`;
    if (el.id) return `#${el.id}`;
    return el.tagName ? el.tagName.toLowerCase() : '(elemen)';
  }

  // ------------------------------------------------------------------------------------
  // Verbose action logging. Requested explicitly: every meaningful bot action (search for
  // an element, scroll, click, type, wait) should produce its own clear log line, not be
  // silent. Threading a `log` callback through every helper call site across both flow
  // files would be a huge, invasive refactor — instead, main.js's dispatcher sets this ONE
  // "active logger" right before calling into a flow module, and every shared helper below
  // (humanClick, humanType, waitForPaceLoading, ...) logs through it automatically.
  // ------------------------------------------------------------------------------------
  let activeLogSink = null;
  function setActiveLogger(log) {
    activeLogSink = typeof log === 'function' ? log : null;
  }
  function logDetail(message) {
    if (activeLogSink) activeLogSink('debug', message);
  }

  /**
   * Requests a REAL, OS-level click (via the native host + nut-js) at `el`'s position —
   * indistinguishable from genuine human input, unlike a script-dispatched DOM click.
   * Use only for the rare widget that doesn't reliably respond to synthetic DOM events
   * (confirmed live: PCare's bootstrap-datepicker). Resolves false (never throws) if the
   * native host isn't installed/connected, so callers must have a fallback.
   *
   * IMPORTANT: unlike humanClick, this bypasses the DOM entirely — it just clicks whatever
   * is physically on screen at computed coordinates. If `el` isn't actually scrolled into
   * view first, those coordinates can point at empty space, a completely different
   * element, or off the page — a "successful" real click that hits nothing relevant. Must
   * scroll and let that settle BEFORE computing the point, every time, since a prior
   * action (a toast, a tab switching in, layout reflow) can move `el` between calls.
   */
  async function requestRealClick(el) {
    scrollIntoViewIfNeeded(el);
    await sleep(250); // let the scroll actually finish before trusting getBoundingClientRect()
    return new Promise((resolve) => {
      try {
        const { x, y } = toScreenPoint(el);
        chrome.runtime.sendMessage({ type: 'PCB_REAL_CLICK', x, y }, (res) => {
          const lastError = chrome.runtime.lastError;
          const ok = !!(res && res.ok);
          if (!ok) {
            logDetail(
              `Klik OS asli tidak berhasil untuk ${describeElement(el)}` +
                (lastError ? ` (native host: ${lastError.message}).` : res?.error ? ` (native host: ${res.error}).` : ' (native host mungkin tidak terpasang/terhubung).')
            );
          }
          resolve(ok);
        });
      } catch (_) {
        logDetail(`Klik OS asli gagal dikirim untuk ${describeElement(el)} — native host mungkin tidak terpasang.`);
        resolve(false);
      }
    });
  }

  /** Same idea as requestRealClick, but a real OS-level Enter keypress via the native host. */
  async function requestRealEnter(el) {
    scrollIntoViewIfNeeded(el);
    await sleep(250);
    return new Promise((resolve) => {
      try {
        const { x, y } = toScreenPoint(el);
        chrome.runtime.sendMessage({ type: 'PCB_REAL_ENTER', x, y }, (res) => {
          const lastError = chrome.runtime.lastError;
          const ok = !!(res && res.ok);
          if (!ok) {
            logDetail(
              `Enter OS asli tidak berhasil untuk ${describeElement(el)}` +
                (lastError ? ` (native host: ${lastError.message}).` : res?.error ? ` (native host: ${res.error}).` : ' (native host mungkin tidak terpasang/terhubung).')
            );
          }
          resolve(ok);
        });
      } catch (_) {
        logDetail(`Enter OS asli gagal dikirim untuk ${describeElement(el)} — native host mungkin tidak terpasang.`);
        resolve(false);
      }
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function scrollIntoViewIfNeeded(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  }

  function fireMouseEvent(el, type, opts = {}) {
    const rect = el.getBoundingClientRect();
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
      ...opts,
    });
    el.dispatchEvent(event);
  }

  /**
   * Clicks like a person would: scroll into view, brief pause (aiming), move the real
   * cursor there (best-effort), pause again, then click.
   *
   * `opts.alsoMouseDown` additionally dispatches a synthetic mousedown+mouseup pair before
   * the real `.click()` — needed for the rare widget that only responds to mousedown
   * (bootstrap-datepicker's calendar cells, confirmed live). Defaults to OFF: confirmed
   * live that dispatching both on an ordinary button (e.g. the "Cari" search button) can
   * fire its handler TWICE if it happens to listen for both mousedown and click — which on
   * a live government system means silently submitting the same search/save action twice.
   * Only pass `alsoMouseDown: true` at call sites that have actually been confirmed to
   * need it.
   */
  async function humanClick(el, opts = {}) {
    if (!el) throw new Error('humanClick: elemen tidak ditemukan.');
    const desc = describeElement(el);
    if (!opts.quiet) logDetail(`Scroll ke ${desc}...`);
    scrollIntoViewIfNeeded(el);
    await humanPause(150, 350);
    moveFakeCursorTo(el);
    if (!opts.quiet) logDetail(`Klik ${desc}...`);
    await humanPause(120, 320);
    if (opts.alsoMouseDown) {
      fireMouseEvent(el, 'mousedown');
      fireMouseEvent(el, 'mouseup');
    }
    el.click();
    await humanPause(200, 500);
    if (!opts.quiet) logDetail(`${desc} berhasil diklik.`);
  }

  /** Clears a field and types into it with per-character delay + input events (React/Vue-safe). */
  async function humanType(el, text, opts = {}) {
    const desc = describeElement(el);
    await humanClick(el, { quiet: true });
    logDetail(`Mengisi ${desc} dengan "${text}"...`);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el),
      'value'
    )?.set;
    const setValue = (v) => {
      if (nativeSetter) nativeSetter.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue('');
    await humanPause(100, 250);
    const str = String(text);
    for (const ch of str) {
      setValue(el.value + ch);
      await sleep(opts.delay ?? 60);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await humanPause(150, 400);
    logDetail(`${desc} terisi: "${el.value}".`);
  }

  function fireEnterKeyEvent(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** Confirmed against the reference project: typing a date directly into a datepicker
   * field (instead of clicking through the calendar UI) opens the calendar popup on
   * focus — pressing Escape closes it without navigating/selecting a day, leaving the
   * typed value intact. */
  function fireEscapeKeyEvent(el) {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** True once `el.value` is fully zero-padded: at least 2 leading zeros, and — when the
   * field declares a maxLength — exactly that many characters (i.e. genuinely complete,
   * not still mid-format). */
  function looksZeroPadded(el, minLeadingZeros) {
    const v = el.value || '';
    const leadingZeros = (v.match(/^0+/) || [''])[0].length;
    if (leadingZeros < minLeadingZeros) return false;
    if (el.maxLength && el.maxLength > 0 && v.length !== el.maxLength) return false;
    return true;
  }

  /**
   * Confirmed live: PCare's "No.Kartu" search field only zero-pads a typed BPJS number up
   * to its full length (e.g. "3217672506" -> "0003217672506") when Enter is actually
   * pressed — NOT on blur/change. Clicking Cari without that padding sends the wrong
   * number and gets a false "Data tidak ditemukan" even though the date/data are correct.
   * Tries a synthetic Enter first (cheap), and if the value still doesn't look padded,
   * falls back to a REAL OS-level Enter via the native host (same reasoning as
   * requestRealClick for the datepicker: some handlers only respond to trusted input).
   * Throws with the actual value/length/maxLength observed if neither works, rather than
   * silently proceeding with a number that's known to be wrong.
   */
  async function pressEnterAndValidateFormat(el, { minLeadingZeros = 2, timeoutMs = 2500 } = {}) {
    fireEnterKeyEvent(el);
    let ok = await waitFor(() => (looksZeroPadded(el, minLeadingZeros) ? true : null), timeoutMs, 150);

    if (!ok) {
      const realEnterSent = await requestRealEnter(el);
      if (realEnterSent) {
        ok = await waitFor(() => (looksZeroPadded(el, minLeadingZeros) ? true : null), timeoutMs, 150);
      }
    }

    if (!ok) {
      throw new Error(
        `pressEnterAndValidateFormat: nomor belum terformat dengan benar setelah Enter (nilai saat ini: "${el.value}", ` +
          `panjang ${el.value.length}${el.maxLength ? `/${el.maxLength}` : ''}, butuh minimal ${minLeadingZeros} angka 0 di depan).`
      );
    }
    await humanPause(150, 350);
  }

  /**
   * Sibling of pressEnterAndValidateFormat for fields whose zero-padding is wired to
   * onfocusout specifically (confirmed live: the rujukan modal's #noKartuHorizon_txt has
   * `onfocusout="onFocusOutNokaLeadingZero(this)"` in its own DOM, no Enter/keydown handler
   * at all) — pressing Enter there does nothing, confirmed live ("nomor belum terformat...
   * setelah Enter" even after the escalation to a real OS Enter). `.blur()` is a genuine
   * native DOM method — it fires the real `blur`/`focusout` event pipeline, not a synthetic
   * workaround — so it reaches this exact handler directly.
   */
  async function blurAndValidateFormat(el, { minLeadingZeros = 2, timeoutMs = 2500 } = {}) {
    el.blur();
    let ok = await waitFor(() => (looksZeroPadded(el, minLeadingZeros) ? true : null), timeoutMs, 150);

    if (!ok) {
      // Belt-and-suspenders: some pages only wire the check to a genuinely trusted blur
      // (triggered by focus moving elsewhere) rather than a script-invoked .blur() call —
      // move focus to <body> for real, then re-focus/blur isn't needed since we just need
      // the one focusout to have fired.
      document.body.focus();
      ok = await waitFor(() => (looksZeroPadded(el, minLeadingZeros) ? true : null), timeoutMs, 150);
    }

    if (!ok) {
      throw new Error(
        `blurAndValidateFormat: nomor belum terformat dengan benar setelah blur (nilai saat ini: "${el.value}", ` +
          `panjang ${el.value.length}${el.maxLength ? `/${el.maxLength}` : ''}, butuh minimal ${minLeadingZeros} angka 0 di depan).`
      );
    }
    await humanPause(150, 350);
  }

  /**
   * Types `value` into `input`, waits for its zero-padding to settle, then gives Cloudflare
   * Turnstile — embedded directly in PCare's "Pendaftaran" search widget, right next to
   * this field — 3-5 seconds to finish verifying BEFORE clicking Cari. Clicking too soon
   * (confirmed live) can make the search behave unpredictably even with a correctly
   * formatted number. If `checkSuccess()` doesn't confirm the search worked, retries the
   * entire sequence (retype, re-wait, re-click) up to `maxAttempts` times before giving up
   * — same pattern each time, per the reasoning above: a failure might just mean this
   * particular attempt raced Turnstile, not that the data is genuinely missing.
   */
  const TURNSTILE_RESPONSE_SELECTOR = 'input[name="cf-turnstile-response"]';

  /**
   * Waits for a Cloudflare Turnstile widget's own token to genuinely appear — NEVER
   * attempts to solve/bypass it, only confirms it already finished on its own (same
   * policy as content/loginFlow.js's login-page check). Returns true immediately if no
   * Turnstile widget is present at all (nothing to wait for).
   */
  async function waitForTurnstileToken(log, timeoutMs = 10000) {
    const tokenPresent = () => {
      const el = document.querySelector(TURNSTILE_RESPONSE_SELECTOR);
      return !!(el && el.value);
    };
    if (!document.querySelector(TURNSTILE_RESPONSE_SELECTOR)) return true; // no widget here
    const ready = await waitFor(() => (tokenPresent() ? true : null), timeoutMs, 250);
    if (!ready) {
      log?.('warn', 'Verifikasi Cloudflare Turnstile di form ini belum selesai setelah menunggu.');
    }
    return !!ready;
  }

  /**
   * PCare uses Pace.js as a global "something is loading" indicator — it adds a
   * "pace-active" state while ANY AJAX/page activity is in flight (confirmed against a
   * prior, unrelated automation project's source for this same system) and clears it when
   * done. Waiting for that to clear is a far more reliable "did the last click actually
   * finish" signal than a fixed pause — the pause we used before was a guess; this isn't.
   */
  async function waitForPaceLoading(timeoutMs = 20000) {
    logDetail(`Menunggu halaman selesai memproses (maks ${Math.round(timeoutMs / 1000)} detik)...`);
    await sleep(300); // give Pace.js a moment to notice the click and add the class
    const done = await waitFor(() => (document.querySelector('.pace-active') ? null : true), timeoutMs, 200);
    logDetail(done ? 'Halaman selesai memproses.' : 'Menunggu halaman selesai memproses — melebihi batas waktu, melanjutkan.');
  }

  function getNotifyMessage() {
    const el = document.querySelector("[data-notify='message']");
    return el ? textOf(el) : '';
  }

  /**
   * Types `value`, waits for its own zero-padding, then NEVER clicks Cari until this
   * form's embedded Cloudflare Turnstile has genuinely produced a token — clicking while
   * it's still pending gets the request flatly rejected server-side ("Verifikasi keamanan
   * gagal..."), and doing that repeatedly just repeats the same rejection instead of
   * fixing anything. If the token still isn't ready after a patient wait, this attempt is
   * skipped WITHOUT clicking (no point clicking something guaranteed to fail) and the next
   * attempt gets an even longer wait. If a click DOES get rejected anyway (a token can be
   * single-use and get invalidated), waits for a genuinely NEW token — not just "some
   * token" — before trying again, since retrying with the same now-dead token would just
   * fail the same way again.
   */
  async function fillAndSearchWithRetry(input, findCariBtn, value, checkSuccess, log, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await humanType(input, value);
      await pressEnterAndValidateFormat(input);

      const tokenReady = await waitForTurnstileToken(log, attempt === 1 ? 12000 : 20000);
      if (!tokenReady) {
        log?.('warn', `Turnstile belum selesai — tidak jadi klik Cari dulu (percobaan ${attempt}/${maxAttempts}), menunggu lebih lama.`);
        if (attempt < maxAttempts) {
          await humanPause(2000, 4000);
          continue; // skip the click entirely this round — clicking now is guaranteed to fail
        }
        return false;
      }

      const cariBtn = await findCariBtn();
      if (!cariBtn) throw new Error('Tombol cari tidak ditemukan.');
      const tokenBeforeClick = document.querySelector(TURNSTILE_RESPONSE_SELECTOR)?.value || null;
      await humanClick(cariBtn);
      await waitForPaceLoading(20000);
      await humanPause(500, 900);

      const notifyMsg = getNotifyMessage();
      if (notifyMsg && /captcha|verifikasi/i.test(notifyMsg)) {
        log?.('warn', `Server menolak pencarian: "${notifyMsg}" — menunggu token Turnstile BARU sebelum mencoba lagi.`);
        if (attempt < maxAttempts) {
          // The token we just used got rejected/invalidated — retrying with it (or
          // whatever's still sitting in the field) would just fail again. Wait for it to
          // actually change to something new before the next attempt.
          await waitFor(() => {
            const el = document.querySelector(TURNSTILE_RESPONSE_SELECTOR);
            return el && el.value && el.value !== tokenBeforeClick ? true : null;
          }, 15000, 300);
          await humanPause(1500, 2500);
          continue;
        }
        return false;
      }

      if (await checkSuccess()) return true;
      if (attempt < maxAttempts) {
        log?.('warn', `Pencarian percobaan ke-${attempt} belum berhasil, mencoba lagi (${attempt + 1}/${maxAttempts})...`);
      }
    }
    return false;
  }

  // ---- element finders (vanilla equivalents of Playwright's getByText/getByRole/etc.) ----

  function textOf(el) {
    return (el.textContent || '').trim();
  }

  /** Finds the "closest to leaf" element whose own text matches; mirrors Playwright's getByText. */
  function byText(text, { exact = false, root = document } = {}) {
    // Non-exact matching is case-INSENSITIVE, matching the Playwright /pattern/i regexes
    // this was ported from (e.g. /data tidak ditemukan/i) — every status/toast message
    // check in the original code relied on that, and a plain case-sensitive .includes()
    // silently fails to recognize "Data tidak ditemukan" vs "data tidak ditemukan",
    // falling through into unrelated, confusing timeouts elsewhere instead of surfacing
    // the real (and correctly detectable) state. exact:true stays case-sensitive, same as
    // Playwright's own exact-match semantics — used for known-casing labels/radios.
    const all = root.querySelectorAll('body *');
    const needle = exact ? text : text.toLowerCase();
    const matches = (t) => (exact ? t === text : t.toLowerCase().includes(needle));
    let best = null;
    for (const el of all) {
      if (el.children.length > 0) continue; // prefer leaf nodes, same spirit as Playwright
      if (matches(textOf(el))) {
        best = el;
        break;
      }
    }
    if (best) return best;
    // fall back to any element (leaf or not) if no pure leaf matched
    for (const el of all) {
      if (matches(textOf(el))) return el;
    }
    return null;
  }

  function allByText(text, { exact = false, root = document } = {}) {
    const all = Array.from(root.querySelectorAll('body *'));
    const needle = exact ? text : text.toLowerCase();
    const matches = (t) => (exact ? t === text : t.toLowerCase().includes(needle));
    return all.filter((el) => el.children.length === 0 && matches(textOf(el)));
  }

  function byPlaceholder(placeholder, { root = document, nth = 0 } = {}) {
    const list = Array.from(root.querySelectorAll(`input[placeholder="${placeholder}"]`));
    return list[nth] || null;
  }

  function byRoleButton(namePattern, { root = document, nth = 0 } = {}) {
    const re = namePattern instanceof RegExp ? namePattern : new RegExp(namePattern, 'i');
    const candidates = Array.from(root.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    const list = candidates.filter((el) => re.test(textOf(el) || el.value || ''));
    return list[nth] || null;
  }

  /**
   * Nth element matching one of `tagNames` after `labelText`'s element, in document order
   * (xpath "following::tag[n]" equivalent).
   *
   * IMPORTANT: setting `walker.currentNode = label` positions the walker AT label — every
   * subsequent `walker.nextNode()` call, by definition, already returns a node that comes
   * AFTER it. An earlier version of this function additionally waited to see `node ===
   * label` before counting anything, which can never happen (nextNode() never returns the
   * node currentNode was just set to), so it always returned null no matter what was
   * actually on the page. That bug was the real cause behind every "field tidak
   * ditemukan" error this bot has hit, including the "Tanggal Pendaftaran" one — timing
   * fixes couldn't have helped, since this returned null unconditionally, instantly, on
   * every single call.
   */
  function nthFollowingByTag(labelText, tagNames, n = 1, { root = document } = {}) {
    const label = byText(labelText, { root });
    if (!label) return null;
    const tagSet = new Set((Array.isArray(tagNames) ? tagNames : [tagNames]).map((t) => t.toUpperCase()));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = label;
    let node;
    let count = 0;
    while ((node = walker.nextNode())) {
      if (tagSet.has(node.tagName)) {
        count += 1;
        if (count === n) return node;
      }
    }
    return null;
  }

  /** First element (any tag) immediately after `labelText`'s element in document order (xpath "following::*[1]" equivalent). See nthFollowingByTag's note on the walker-position fix. */
  function firstFollowingElement(labelText, { root = document } = {}) {
    const label = byText(labelText, { root });
    if (!label) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = label;
    return walker.nextNode();
  }

  /** Finds the input immediately following an element containing `labelText` (xpath "following::input[1]" equivalent). */
  function inputFollowingText(labelText, { root = document } = {}) {
    return nthFollowingByTag(labelText, 'INPUT', 1, { root });
  }

  /**
   * Same as inputFollowingText, but POLLS for it instead of checking once. Use this right
   * after a navigation (+ dismissReminderPopup) instead of the synchronous version — the
   * page's real form can still be mid-render (e.g. behind an AJAX-driven reminder popup)
   * for a moment even after document.readyState is "complete", and a single-shot check
   * throws a false "field not found" error if it catches that narrow window.
   */
  async function waitForInputFollowingText(labelText, timeoutMs = 8000, { root = document } = {}) {
    return waitFor(() => inputFollowingText(labelText, { root }), timeoutMs, 200);
  }

  /** Polls for an element by id — prefer this over label-proximity matching wherever a
   * real, confirmed id is known (see PCare's real "Pendaftaran" search widget DOM), since
   * it can't be thrown off by markup changes around a label the way text-proximity can. */
  async function waitForId(id, timeoutMs = 8000) {
    return waitFor(() => document.getElementById(id), timeoutMs, 200);
  }

  /**
   * Snapshot of "why might the page not look like we expect" — logged right before an
   * anchor-field lookup gives up, so a failure like "Input X tidak ditemukan" leaves a
   * trail beyond just that message (is the page even done loading? is some other modal
   * still covering it? did the URL end up somewhere unexpected?).
   */
  function diagnosticSnapshot() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      modalBackdrop: !!document.querySelector('.modal-backdrop'),
      bodyModalOpen: document.body.classList.contains('modal-open'),
    };
  }

  async function waitForVisible(finder, timeoutMs = 8000) {
    return waitFor(() => {
      const el = finder();
      return isVisible(el) ? el : null;
    }, timeoutMs, 200);
  }

  /**
   * Closes the "Belum Entri Pelayanan Pasien" reminder modal PCare sometimes shows on
   * page (re)load. The modal is populated by an AJAX check that can lag behind
   * `document.readyState === 'complete'`, so we POLL for it to appear (instead of a single
   * point-in-time check that can simply miss it) — and after clicking OK, poll again until
   * the modal + its backdrop are genuinely gone (Bootstrap's fade-out isn't instant), so
   * the caller never starts interacting with a page that's still visually blocked.
   */
  async function dismissReminderPopup(log, { appearTimeoutMs = 4000, closeTimeoutMs = 5000 } = {}) {
    const okBtn = await waitFor(() => {
      const btn = byRoleButton(/^OK$/);
      return btn && isVisible(btn) ? btn : null;
    }, appearTimeoutMs, 200);
    if (!okBtn) return; // popup never showed up on this load — nothing to dismiss

    await humanClick(okBtn);
    log?.('debug', 'Menutup popup "Belum Entri Pelayanan Pasien" — menunggu modal benar-benar tertutup...');

    const closed = await waitFor(() => {
      const stillThere = byRoleButton(/^OK$/);
      const blocked = (stillThere && isVisible(stillThere)) || document.querySelector('.modal-backdrop') || document.body.classList.contains('modal-open');
      return blocked ? null : true;
    }, closeTimeoutMs, 150);
    if (!closed) {
      log?.('warn', 'Modal "Belum Entri Pelayanan Pasien" tampaknya belum tertutup sepenuhnya — melanjutkan dengan hati-hati.');
    }
  }

  PCB.dom = {
    humanPause,
    sleep,
    waitFor,
    requestStop,
    resetStopFlag,
    ContentStopped,
    waitForVisible,
    moveFakeCursorTo,
    requestRealClick,
    requestRealEnter,
    isVisible,
    scrollIntoViewIfNeeded,
    humanClick,
    humanType,
    pressEnterAndValidateFormat,
    blurAndValidateFormat,
    fillAndSearchWithRetry,
    waitForTurnstileToken,
    waitForPaceLoading,
    getNotifyMessage,
    byText,
    allByText,
    byPlaceholder,
    byRoleButton,
    inputFollowingText,
    waitForInputFollowingText,
    waitForId,
    diagnosticSnapshot,
    recentPageErrors,
    recentNetworkCalls,
    nthFollowingByTag,
    firstFollowingElement,
    dismissReminderPopup,
    textOf,
    fireEnterKeyEvent,
    fireEscapeKeyEvent,
    setSelect2ValueViaJQuery,
    describeElement,
    setActiveLogger,
    logDetail,
  };
})(window);
