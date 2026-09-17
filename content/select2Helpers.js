// Ported 1:1 in spirit from src/pcare/common.js (Playwright version) — same DOM structure
// assumptions (confirmed live against PCare's real pages), just driven with plain DOM APIs
// since we're now running as a content script inside the user's own tab.
(function (global) {
  const PCB = global.PCB || (global.PCB = {});
  const {
    humanClick,
    humanType,
    humanPause,
    waitFor,
    byText,
    textOf,
    requestRealClick,
    recentPageErrors,
    setSelect2ValueViaJQuery,
    logDetail,
    diagnosticSnapshot,
    fireEscapeKeyEvent,
    waitForHumanHelp,
  } = PCB.dom;

  function fmtDateDDMMYYYY(d) {
    const date = d instanceof Date ? d : new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Opens PCare's bootstrap-datepicker on `dateInput` and clicks the day matching
   * `targetDate`, navigating months with the « arrow as needed.
   *
   * PCare's Pelayanan page has FOUR separate `.datepicker`-class fields (search date,
   * tanggal kunjungan, tanggal pulang, tanggal kejadian KLL) — bootstrap-datepicker can
   * leave more than one of these pre-rendered-but-hidden in the DOM at once, so an
   * unscoped `document.querySelector('.datepicker-days ...')` can silently match the
   * WRONG (closed) instance. We first find the one that's actually visible/open (via
   * `offsetParent`, null for anything `display:none`), then scope every lookup inside it.
   */
  async function pickDate(dateInput, targetDate) {
    const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
    const wantedDisplay = fmtDateDDMMYYYY(target);
    logDetail(`Mengatur tanggal ke ${wantedDisplay}...`);

    // Confirmed live (the same fix already proven for Pendaftaran's rujukan date
    // correction): typing the date directly into the field, in its own real runtime
    // format (dd-mm-yyyy — the placeholder's "yyyy-MM-dd" is misleading), then pressing
    // Escape to close whatever popup that opens, works reliably and skips the
    // calendar-click UI below entirely, which has repeatedly proven flaky. Tried first
    // since it's strictly simpler; only falls through to the calendar if it doesn't stick.
    await humanType(dateInput, wantedDisplay);
    fireEscapeKeyEvent(dateInput);
    await humanPause(250, 500);
    if (dateInput.value === wantedDisplay) {
      logDetail(`Tanggal ${wantedDisplay} berhasil diatur langsung (tanpa kalender).`);
      return;
    }
    logDetail(`Ketik langsung belum berhasil (nilai saat ini: "${dateInput.value}") — mencoba lewat kalender...`);

    const findOpenCalendar = () => {
      const candidates = Array.from(document.querySelectorAll('.datepicker-days'));
      return candidates.find((el) => el.offsetParent !== null) || null;
    };

    // Confirmed live: a genuine manual click reliably opens this calendar, but a
    // script-dispatched DOM click (mousedown/mouseup/click) sometimes doesn't — the widget
    // likely needs a real, trusted click event, not a synthetic one. Try the normal DOM
    // click a couple of times first (cheap, works most of the time elsewhere), then fall
    // back to an actual OS-level click via the native host (indistinguishable from a real
    // human click) before calling for human help.
    let opened = null;
    for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
      if (attempt > 0) await humanPause(300, 600);
      dateInput.focus();
      if (attempt < 2) {
        await humanClick(dateInput);
      } else {
        const clicked = await requestRealClick(dateInput);
        if (!clicked) await humanClick(dateInput); // native host unavailable — fall back
      }
      opened = await waitFor(findOpenCalendar, 3000, 150);
    }

    if (!opened) {
      // Last resort before giving up: call for human help (audible, repeating) — check
      // both whether the field's value now matches (they typed it directly themselves) or
      // the calendar is now open (they clicked it open) — either resolves this without
      // necessarily waiting out the full minute.
      const helpResult = await waitForHumanHelp(
        () => (dateInput.value === wantedDisplay ? 'typed' : findOpenCalendar()),
        { log: (level, msg) => logDetail(msg), description: `bantuan mengatur tanggal ke ${wantedDisplay}` }
      );
      if (helpResult === 'typed') {
        logDetail(`Tanggal ${wantedDisplay} sudah sesuai setelah dibantu — melanjutkan.`);
        return;
      }
      if (helpResult) opened = helpResult;
    }

    if (!opened) {
      const anyDatepicker = document.querySelectorAll('.datepicker, .datepicker-dropdown, .bootstrap-datetimepicker-widget').length;
      const pageErrors = recentPageErrors();
      // Same diagnostic pattern used elsewhere (searchByBpjs's anchor-field failure): dump
      // what might be silently blocking the click — a modal backdrop, or the field itself
      // being disabled/readonly — instead of leaving the next debugging round guessing.
      const snapshot = diagnosticSnapshot();
      throw new Error(
        `pickDate: kalender tidak terbuka setelah beberapa percobaan klik field tanggal, termasuk klik OS asli dan permintaan bantuan ` +
          `(ada ${anyDatepicker} elemen datepicker di DOM, tapi tidak ada yang terlihat terbuka; ` +
          `field: disabled=${dateInput.disabled}, readOnly=${dateInput.readOnly}, value="${dateInput.value}"; ` +
          `modal backdrop aktif=${snapshot.modalBackdrop}, body.modal-open=${snapshot.bodyModalOpen})` +
          (pageErrors.length ? `. Error JS dari halaman PCare: ${pageErrors.join(' | ')}` : '.')
      );
    }

    const wantedLabel = target.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    let navigated = false;
    for (let guard = 0; guard < 36; guard++) {
      const label = textOf(opened.querySelector('.datepicker-switch') || document.createElement('span'));
      if (label === wantedLabel) break;
      const prevBtn = opened.querySelector('th.prev');
      if (!prevBtn) break;
      navigated = true;
      await humanClick(prevBtn, { alsoMouseDown: true, quiet: true });
    }
    if (navigated) logDetail(`Navigasi kalender ke bulan ${wantedLabel}.`);

    await humanPause(200, 450);
    const day = String(target.getDate());
    const dayCells = Array.from(opened.querySelectorAll('td.day:not(.old):not(.new)'));
    const dayCell = dayCells.find((el) => textOf(el) === day);
    if (!dayCell) {
      const currentLabel = textOf(opened.querySelector('.datepicker-switch') || document.createElement('span'));
      throw new Error(
        `pickDate: tanggal ${day} tidak ditemukan di kalender (bulan yang tampil: "${currentLabel}", target: "${wantedLabel}").`
      );
    }
    logDetail(`Memilih tanggal ${day} di kalender...`);
    // Confirmed live: this specific click needs the mousedown+click combo — the calendar
    // day cell doesn't reliably respond to a plain .click() alone.
    await humanClick(dayCell, { alsoMouseDown: true });
    logDetail(`Tanggal ${fmtDateDDMMYYYY(target)} terpilih di kalender.`);
  }

  /**
   * Picks an option from an already-visible (or about-to-open) select2 v4 dropdown.
   * `openEl` is the clickable closed-state box (e.g. #select2-<id>-container); pass null
   * if the dropdown is already open. Crosschecks afterward that the closed box's rendered
   * text actually reflects the pick — clicking an option and just trusting it landed isn't
   * enough; select2 occasionally needs a beat to re-render its own closed-state label.
   */
  async function pickSelect2Option(openEl, optionText, { exact = true, typeToFilter = true } = {}) {
    if (openEl) await humanClick(openEl);
    await humanPause(250, 500);

    const searchFields = document.querySelectorAll('.select2-search__field');
    const searchField = searchFields[searchFields.length - 1];
    if (typeToFilter && searchField) {
      await humanType(searchField, optionText, { delay: 55 });
      await humanPause(300, 600);
    }

    const re = exact ? new RegExp(`^${escapeRegex(optionText)}$`) : new RegExp(escapeRegex(optionText));
    let option = await waitFor(() => {
      const opts = Array.from(document.querySelectorAll('.select2-results__option[role="treeitem"]'));
      return opts.find((el) => re.test(textOf(el))) || null;
    }, 5000, 150);

    if (!option) throw new Error(`pickSelect2Option: opsi "${optionText}" tidak ditemukan.`);
    const pickedLabel = textOf(option);

    // Confirmed live (sama seperti kalender datepicker & tombol No.Kunjungan riwayat):
    // klik sintetis pada opsi select2 kadang tidak benar-benar terdaftar oleh widget ini,
    // walau elemen yang diklik sudah benar. Coba klik biasa dulu, lalu eskalasi ke klik
    // OS asli (via native host) sebelum menyerah — jangan langsung anggap gagal permanen.
    let confirmed = !openEl;
    for (let attempt = 0; attempt < 3 && !confirmed; attempt += 1) {
      if (attempt > 0) {
        await humanPause(200, 400);
        const stillOpen = document.body.contains(option) && option.offsetParent !== null;
        if (!stillOpen) {
          if (openEl) await humanClick(openEl);
          await humanPause(250, 500);
          option = await waitFor(() => {
            const opts = Array.from(document.querySelectorAll('.select2-results__option[role="treeitem"]'));
            return opts.find((el) => re.test(textOf(el))) || null;
          }, 2000, 150);
          if (!option) break;
        }
      }
      if (attempt < 2) {
        await humanClick(option);
      } else {
        const clicked = await requestRealClick(option);
        if (!clicked) await humanClick(option);
      }
      if (openEl) {
        confirmed = await waitFor(() => (textOf(openEl).includes(pickedLabel) ? true : null), 2500, 150);
      } else {
        confirmed = true;
      }
    }

    if (!confirmed) {
      throw new Error(
        `pickSelect2Option: pilihan "${pickedLabel}" sudah dicoba diklik beberapa kali (termasuk klik OS asli) tapi kotak select2 masih menampilkan "${textOf(openEl)}" — pilihan tampaknya tidak benar-benar tersimpan.`
      );
    }
  }

  /**
   * Picks an option on a select2 dropdown whose underlying <select> id is known.
   *
   * Primary path: sets the value directly through PCare's own jQuery (see
   * setSelect2ValueViaJQuery) — no cursor, no screen coordinates, no click simulation.
   * Confirmed by reading the underlying <select>'s real value/selectedOptions back, not by
   * scraping the rendered closed-box text (which can be ambiguous with partial matches).
   * Only falls back to the old click-based `pickSelect2Option` if the jQuery path fails for
   * some reason (e.g. jQuery not exposed as expected) — kept as a safety net, not the
   * expected path.
   */
  async function pickSelect2ById(selectId, optionText, opts = {}) {
    const { exact = true, append = false } = opts;
    logDetail(`Memilih "${optionText}" pada dropdown #${selectId}...`);
    const result = await setSelect2ValueViaJQuery(selectId, optionText, { exact, append });
    if (result.ok) {
      const select = document.getElementById(selectId);
      const confirmed = await waitFor(() => {
        if (!select) return null;
        if (select.multiple) {
          const values = Array.from(select.selectedOptions).map((o) => o.value);
          return values.includes(result.matchedValue) ? true : null;
        }
        return select.value === result.matchedValue ? true : null;
      }, 2500, 150);
      if (confirmed) {
        logDetail(`"${optionText}" tersimpan di #${selectId}.`);
        return;
      }
    }

    const container = document.getElementById(`select2-${selectId}-container`);
    if (!container) {
      throw new Error(
        `pickSelect2ById: cara jQuery langsung gagal (${result.error || 'nilai tidak tersimpan'}), dan container ` +
          `select2-${selectId}-container tidak ditemukan untuk fallback klik.`
      );
    }
    return pickSelect2Option(container, optionText, opts);
  }

  /**
   * Generic fallback for dropdown-ish widgets whose real id isn't known statically (e.g. a
   * row added dynamically via "+Tambah Data Baru"). Most "plain" looking dropdowns on this
   * page turn out to actually be select2 too (confirmed live: Riwayat Alergi, Prognosa,
   * Status Pulang all are) — so this tries select2's real result-item structure FIRST, and
   * only falls back to a generic role="option"/.dropdown-menu li match if that's not it.
   * Deliberately does NOT match a bare `li` selector — that's the entire document's list
   * items, including unrelated nav/menu ones, and has silently matched the wrong element
   * before.
   */
  async function pickDropdownOption(dropdownEl, optionText, { exact = true } = {}) {
    await humanClick(dropdownEl);
    await humanPause(250, 500);
    const re = exact ? new RegExp(`^${escapeRegex(optionText)}$`) : new RegExp(escapeRegex(optionText));
    const findOption = () => {
      const opts = Array.from(
        document.querySelectorAll('.select2-results__option[role="treeitem"], .dropdown-menu li, [role="option"]')
      );
      return opts.find((el) => re.test(textOf(el))) || null;
    };
    let option = await waitFor(findOption, 5000, 150);
    if (!option) throw new Error(`pickDropdownOption: opsi "${optionText}" tidak ditemukan.`);
    const pickedLabel = textOf(option);

    // Sama seperti pickSelect2Option: klik sintetis kadang tidak terdaftar oleh widget ini,
    // jadi coba klik biasa dulu lalu eskalasi ke klik OS asli sebelum menyerah.
    let confirmed = false;
    for (let attempt = 0; attempt < 3 && !confirmed; attempt += 1) {
      if (attempt > 0) {
        await humanPause(200, 400);
        const stillOpen = document.body.contains(option) && option.offsetParent !== null;
        if (!stillOpen) {
          await humanClick(dropdownEl);
          await humanPause(250, 500);
          option = await waitFor(findOption, 2000, 150);
          if (!option) break;
        }
      }
      if (attempt < 2) {
        await humanClick(option);
      } else {
        const clicked = await requestRealClick(option);
        if (!clicked) await humanClick(option);
      }
      confirmed = await waitFor(() => (textOf(dropdownEl).includes(pickedLabel) ? true : null), 2500, 150);
    }

    if (!confirmed) {
      throw new Error(
        `pickDropdownOption: pilihan "${pickedLabel}" sudah dicoba diklik beberapa kali (termasuk klik OS asli) tapi elemen dropdown masih menampilkan "${textOf(dropdownEl)}" — pilihan tampaknya tidak benar-benar tersimpan.`
      );
    }
  }

  PCB.select2 = {
    fmtDateDDMMYYYY,
    escapeRegex,
    pickDate,
    pickSelect2Option,
    pickSelect2ById,
    pickDropdownOption,
  };
})(window);
