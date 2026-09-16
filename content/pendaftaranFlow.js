// Ported from src/pcare/pendaftaran.js. Each exported function assumes the background
// service worker has ALREADY navigated this tab to the Pendaftaran page for this call
// (see background.js's navigateAndCall) — content scripts can't survive their own
// navigation, so all cross-page sequencing lives in the background script.
(function (global) {
  const PCB = global.PCB || (global.PCB = {});
  const { humanClick, humanType, humanPause, byText, allByText, byPlaceholder, byRoleButton, inputFollowingText, waitForInputFollowingText, waitForId, pressEnterAndValidateFormat, fillAndSearchWithRetry, waitForTurnstileToken, waitForPaceLoading, getNotifyMessage, dismissReminderPopup, waitFor, textOf, isVisible, diagnosticSnapshot, fireEscapeKeyEvent } = PCB.dom;

  const TURNSTILE_RESPONSE_SELECTOR = 'input[name="cf-turnstile-response"]';

  /**
   * The "Pendaftaran" search widget (tanggal + No.Antrian/No.Kartu + tombol cari) is a
   * shared component embedded on both EntriDaftarDokkel and EntriKunjunganDokkel — DOM
   * confirmed live: date field is `#txttanggal`, the search button is icon-only
   * (`#btnCariPendaftaran`, no visible "Cari" text at all, which is why byRoleButton(/cari/i)
   * could never find it). Prefer these confirmed ids; fall back to the fuzzy lookups only
   * if a page turns out not to use this exact widget.
   */
  async function findTanggalPendaftaranInput(fallbackLabel, timeoutMs) {
    const byId = await waitForId('txttanggal', 3000);
    if (byId) return byId;
    return waitForInputFollowingText(fallbackLabel, timeoutMs);
  }
  async function findCariButton() {
    return document.getElementById('btnCariPendaftaran') || byRoleButton(/cari/i);
  }

  // The very first field looked up on a freshly navigated page — the one most exposed to
  // slow server responses on this government system — gets a longer, more patient wait
  // than AJAX-driven lookups elsewhere in the same flow.
  const ANCHOR_FIELD_TIMEOUT_MS = 15000;
  const { pickDate, fmtDateDDMMYYYY } = PCB.select2;

  async function setPerawatanPromotifDanSimpan(log) {
    // Confirmed real ids (both the pasted live DOM and the reference project's Selenium
    // code, which targets this exact same PCare system): #tkp50 / #btnSimpanPendaftaran.
    // Both can sit disabled for a moment after the rujukan/search step loads, so wait for
    // enabled rather than clicking the instant the element exists in the DOM.
    const promotif = await waitFor(() => {
      const el = document.getElementById('tkp50');
      return el && !el.disabled ? el : null;
    }, 10000, 200);
    if (!promotif) throw new Error('Radio "Promotif Preventif" (#tkp50) tidak ditemukan atau tetap disabled.');
    await humanClick(promotif);

    const simpanBtn = await waitFor(() => {
      const el = document.getElementById('btnSimpanPendaftaran');
      return el && !el.disabled ? el : null;
    }, 10000, 200);
    if (!simpanBtn) throw new Error('Tombol "Simpan" (#btnSimpanPendaftaran) tidak ditemukan atau tetap disabled.');
    await humanClick(simpanBtn);
    await waitForPaceLoading(20000);

    // Confirmed exact toast text via the reference project: "Data Pendaftaran Berhasil
    // disimpan" — checking the dedicated [data-notify='message'] element directly (like
    // pelayananFlow.js's waitForSaveNotify) is more precise than a full-page text search.
    const toastMsg = await waitFor(() => (/berhasil disimpan/i.test(getNotifyMessage()) ? getNotifyMessage() : null), 8000, 200);
    if (!toastMsg) throw new Error(`Toast konfirmasi simpan pendaftaran tidak muncul (notifikasi saat ini: "${getNotifyMessage()}").`);
    log('info', `Pendaftaran tersimpan (${toastMsg}).`);
  }

  /**
   * Registers via "Rujukan": search an existing horizontal referral by BPJS card, pick the
   * row, follow ITS visit date (not necessarily the one we assumed), then save.
   *
   * Every selector below is a confirmed real id — either from the user's own pasted live
   * DOM, or cross-checked against the reference project's Selenium code for this exact
   * PCare system (which already worked against this exact modal). The previous version of
   * this function guessed at "..." as literal button text; the real button
   * (#btnQueryPesertaLain) is icon-only (a `<i class="fa fa-ellipsis-h">` glyph, not text),
   * so that text search could never match — confirmed the actual root cause of "Tombol
   * '...' tidak ditemukan" reported live.
   */
  async function viaRujukan({ patient, targetDate }, log) {
    await humanPause(500, 1100);
    await dismissReminderPopup(log);

    const tanggalInput = await findTanggalPendaftaranInput('Tanggal', ANCHOR_FIELD_TIMEOUT_MS);
    if (!tanggalInput) {
      log('warn', `Diagnostik halaman: ${JSON.stringify(diagnosticSnapshot())}`);
      throw new Error('Input tanggal pendaftaran tidak ditemukan.');
    }
    await pickDate(tanggalInput, targetDate);

    const rujukanRadio = document.getElementById('rborizon') || byText('Rujukan', { exact: true });
    if (!rujukanRadio) throw new Error('Radio "Rujukan" (#rborizon) tidak ditemukan.');
    await humanClick(rujukanRadio);

    const dotsBtn = await waitForId('btnQueryPesertaLain', 8000);
    if (!dotsBtn) throw new Error('Tombol pencarian rujukan (#btnQueryPesertaLain) tidak ditemukan.');
    await humanClick(dotsBtn);

    const modal = await waitFor(() => {
      const el = document.getElementById('cariRujukanHorizontal_modal');
      return el && isVisible(el) ? el : null;
    }, 8000, 200);
    if (!modal) throw new Error('Modal pencarian rujukan (#cariRujukanHorizontal_modal) tidak terbuka.');

    const modalInput = await waitFor(() => document.getElementById('noKartuHorizon_txt'), 5000, 150);
    if (!modalInput) throw new Error('Input No.Kartu BPJS (#noKartuHorizon_txt) tidak ditemukan di modal rujukan.');
    // Confirmed live: this field's own auto-pad (onfocusout="onFocusOutNokaLeadingZero")
    // doesn't reliably fire from either a synthetic Enter or a scripted .blur() call —
    // rather than keep chasing which trigger it actually responds to, pad the number to
    // the field's real length OURSELVES before typing, leaving nothing for that handler to
    // still need to do.
    const paddedBpjs = patient.noBpjs.padStart(modalInput.maxLength || 13, '0');
    await humanType(modalInput, paddedBpjs);
    modalInput.blur(); // still blur once in case other validation on this page cares
    await humanPause(200, 400);
    if (modalInput.value !== paddedBpjs) {
      throw new Error(
        `Input No.Kartu BPJS di modal rujukan menunjukkan "${modalInput.value}", bukan angka yang diketik ("${paddedBpjs}") — periksa apakah field ini mengubah/menolak nilai.`
      );
    }

    const modalCari = document.getElementById('cariRujukanByNoka_btn');
    if (!modalCari) throw new Error('Tombol Cari (#cariRujukanByNoka_btn) tidak ditemukan di modal rujukan.');
    await humanClick(modalCari);
    await waitForPaceLoading(15000);
    await humanPause(500, 900); // let DataTables actually finish re-rendering rows

    const rujukanTable = document.getElementById('daftarRujukan_tbl');
    if (!rujukanTable) throw new Error('Tabel hasil pencarian rujukan (#daftarRujukan_tbl) tidak ditemukan.');

    const emptyState = await waitFor(() => {
      const emptyCell = rujukanTable.querySelector('tbody .dataTables_empty');
      if (emptyCell) return 'empty';
      const row = rujukanTable.querySelector('tbody tr');
      return row ? 'has-row' : null;
    }, 8000, 200);

    if (emptyState === 'empty') {
      const reason = `Tidak ada data rujukan horizontal untuk No.BPJS ${patient.noBpjs}.`;
      log('warn', `${patient.nama}: ${reason}`);
      const batal = document.getElementById('batalRujukan_btn');
      if (batal) await humanClick(batal).catch(() => {});
      return { found: false, reason };
    }
    if (!emptyState) throw new Error('Tabel hasil pencarian rujukan tidak pernah selesai memuat (bukan kosong, bukan berisi baris).');

    const firstRow = rujukanTable.querySelector('tbody tr');
    const pilihBtn = firstRow.querySelector('td:nth-child(1) button[onclick*="rujukanHorizontalSelected"]');
    if (!pilihBtn) throw new Error('Tombol No Rujukan di baris pertama tabel tidak ditemukan.');
    const namaTabel = textOf(firstRow.querySelectorAll('td')[2] || document.createElement('span')); // NAMA PESERTA
    const tglKunjunganTabel = textOf(firstRow.querySelectorAll('td')[4] || document.createElement('span')); // TGL KUNJUNGAN

    // Soft crosscheck (warns, doesn't block) — same spirit as pelayananFlow.js's
    // searchByBpjs: catches a genuinely wrong row without reintroducing an exact-string-
    // match bug against PCare's own formatting/punctuation.
    const normalize = (s) => (s || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (namaTabel && normalize(namaTabel) !== normalize(patient.nama)) {
      log('warn', `${patient.nama}: nama di tabel rujukan ("${namaTabel}") berbeda — periksa apakah ini baris yang benar.`);
    }

    await humanClick(pilihBtn);
    // Confirmed by the user live: this click kicks off an AJAX load that fills in several
    // fields in stages (No.Kartu, Nama, Tahun Lahir, Kelamin, PPK, ...) — not all at once.
    // Wait for Pace.js's own "still loading" indicator to clear FIRST, before even checking
    // for the name label, instead of racing that first AJAX call.
    await waitForPaceLoading(15000);

    // Confirmed real id (also used by the Pelayanan search widget — same shared component):
    // wait for the dedicated name label to populate, not a raw text match against the whole
    // page, which silently fails on formatting/punctuation differences (confirmed bug
    // fixed the same way in pelayananFlow.js's searchByBpjs earlier).
    const nameShown = await waitFor(() => {
      const el = document.getElementById('lblnmpst');
      return el && textOf(el) ? el : null;
    }, 12000, 250);
    if (!nameShown) throw new Error(`Nama pasien "${patient.nama}" tidak muncul setelah memilih rujukan.`);
    // The name is only the FIRST field to populate — give the rest of the form (used right
    // after this: the date field, then the Promotif Preventif radio) a moment to settle too,
    // rather than touching them the instant the name alone appears.
    await humanPause(900, 1500);

    // Confirmed against the reference project: the visit's OWN date (from the table) must
    // win over whatever date we originally assumed — PCare only lets this registration
    // proceed against that specific referral's real Tgl.Kunjungan. If they already match,
    // touching the field again is unnecessary (and risks an accidental re-trigger of the
    // datepicker's own AJAX). No need to re-click Cari either — we already found the
    // correct row; changing the date only re-targets which visit gets registered.
    const wantedDisplay = fmtDateDDMMYYYY(targetDate);
    if (tglKunjunganTabel && tglKunjunganTabel !== wantedDisplay) {
      log(
        'warn',
        `${patient.nama}: Tgl.Kunjungan rujukan (${tglKunjunganTabel}) berbeda dari tanggal yang direncanakan (${wantedDisplay}) — mengikuti data rujukan.`
      );
      const tglField = document.getElementById('txttanggal');
      if (!tglField) throw new Error('Input tanggal pendaftaran (#txttanggal) tidak ditemukan untuk penyesuaian tanggal.');
      await humanType(tglField, tglKunjunganTabel);
      fireEscapeKeyEvent(tglField); // closes the datepicker popup typing opens, without selecting a day
      await humanPause(300, 600);
    }

    await setPerawatanPromotifDanSimpan(log);
    return { found: true, tanggalLayanan: tglKunjunganTabel || wantedDisplay };
  }

  /** Registers via "Baru" directly by BPJS card number. */
  async function viaBaru({ patient, targetDate }, log) {
    await humanPause(500, 1100);
    await dismissReminderPopup(log);

    const tanggalInput = await findTanggalPendaftaranInput('Tanggal', ANCHOR_FIELD_TIMEOUT_MS);
    if (!tanggalInput) {
      log('warn', `Diagnostik halaman: ${JSON.stringify(diagnosticSnapshot())}`);
      throw new Error('Input tanggal pendaftaran tidak ditemukan.');
    }
    await pickDate(tanggalInput, targetDate);

    const baruRadio = document.getElementById('rbpendaftaranbaru') || byText('Baru', { exact: true });
    if (!baruRadio) throw new Error('Radio "Baru" (#rbpendaftaranbaru) tidak ditemukan.');
    await humanClick(baruRadio);

    const noPencarian = byPlaceholder('Nomor', { nth: 0 });
    // Same fix as pelayananFlow.js's searchByBpjs and viaRujukan above: check the dedicated
    // #lblnmpst name label is populated, not a raw text match against the whole page (which
    // silently fails whenever PCare renders the name with different punctuation than the
    // Excel source, e.g. "ABD. LATIF" vs "ABD LATIF").
    const found = await fillAndSearchWithRetry(
      noPencarian,
      findCariButton,
      patient.noBpjs,
      async () =>
        !!(await waitFor(() => {
          const el = document.getElementById('lblnmpst');
          return el && textOf(el) ? el : null;
        }, 8000, 200)),
      log
    );
    if (!found) throw new Error(`Nama pasien "${patient.nama}" tidak muncul setelah pencarian.`);

    await setPerawatanPromotifDanSimpan(log);
    return { registered: true };
  }

  /**
   * Assumes the tab is already on the Pelayanan page. Sets the tanggal pendaftaran and
   * searches by No.Kartu; if "Data tidak ditemukan" (or the rujukan step failed), opens
   * Riwayat Pelayanan Peserta and reads the real tanggal layanan terakhir.
   */
  async function pelayananCheckDate({ patient, targetDate, rujukanFound }, log) {
    await humanPause(500, 1100);
    await dismissReminderPopup(log);

    const tanggalInput = await findTanggalPendaftaranInput('Tanggal Pendaftaran', ANCHOR_FIELD_TIMEOUT_MS);
    if (!tanggalInput) {
      log('warn', `Diagnostik halaman: ${JSON.stringify(diagnosticSnapshot())}`);
      throw new Error('Input "Tanggal Pendaftaran" tidak ditemukan.');
    }
    await pickDate(tanggalInput, targetDate);

    const noKartuRadio = byText('No.Kartu', { exact: true }) || document.getElementById('rbkartu');
    if (!noKartuRadio) throw new Error('Radio "No.Kartu" tidak ditemukan.');
    await humanClick(noKartuRadio);

    const bpjsInput = byPlaceholder('Nomor', { nth: 0 });
    await humanType(bpjsInput, patient.noBpjs);
    await pressEnterAndValidateFormat(bpjsInput); // lets PCare's own JS zero-pad the number to 13 digits before we search

    // Never click Cari while Turnstile hasn't genuinely finished — the server flatly
    // rejects the request ("Verifikasi keamanan gagal...") instead of returning a normal
    // search result, and that rejection must not be misread as "data tidak ditemukan".
    let tokenReady = await waitForTurnstileToken(log, 12000);
    if (!tokenReady) {
      log('warn', 'Turnstile belum selesai — menunggu lebih lama sebelum klik Cari.');
      await humanPause(2000, 4000);
      tokenReady = await waitForTurnstileToken(log, 15000);
    }

    const cariBtn = await findCariButton();
    if (!cariBtn) throw new Error('Tombol cari tidak ditemukan.');

    let tokenBeforeClick = document.querySelector(TURNSTILE_RESPONSE_SELECTOR)?.value || null;
    await humanClick(cariBtn);
    await waitForPaceLoading(20000); // Pace.js's global loading indicator — more reliable than a fixed pause
    await humanPause(500, 900);

    let notifyMsg = getNotifyMessage();
    if (notifyMsg && /captcha|verifikasi/i.test(notifyMsg)) {
      log('warn', `Server menolak pencarian: "${notifyMsg}" — menunggu token Turnstile baru lalu mencoba sekali lagi.`);
      await waitFor(() => {
        const el = document.querySelector(TURNSTILE_RESPONSE_SELECTOR);
        return el && el.value && el.value !== tokenBeforeClick ? true : null;
      }, 15000, 300);
      await humanPause(1500, 2500);
      tokenBeforeClick = document.querySelector(TURNSTILE_RESPONSE_SELECTOR)?.value || null;
      await humanClick(cariBtn);
      await waitForPaceLoading(20000);
      await humanPause(500, 900);
      notifyMsg = getNotifyMessage();
      if (notifyMsg && /captcha|verifikasi/i.test(notifyMsg)) {
        throw new Error(`Server menolak pencarian dua kali berturut-turut: "${notifyMsg}". Coba jalankan ulang nanti.`);
      }
    }

    const notFoundEl = byText('data tidak ditemukan', {});
    const notFound = !!notFoundEl;

    if (!notFound && rujukanFound) {
      log('info', `${patient.nama}: tanggal layanan = tanggal pendaftaran awal (${fmtDateDDMMYYYY(targetDate)}).`);
      return { notFound: false, correctedDate: null };
    }

    log('info', `${patient.nama}: mengecek riwayat pelayanan untuk tanggal layanan sebenarnya...`);
    const tampilkan = byText('Tampilkan data riwayat pelayanan', {});
    if (!tampilkan) throw new Error('Tautan "Tampilkan data riwayat pelayanan" tidak ditemukan.');
    await humanClick(tampilkan);

    const firstRow = await waitFor(() => document.querySelector('table tbody tr'), 8000, 200);
    if (!firstRow) throw new Error('Tabel riwayat pelayanan tidak muncul.');

    const tglCell = firstRow.querySelectorAll('td')[3]; // No.Kunjungan | Faskes | Poli | Tgl.Layan
    const text = textOf(tglCell || document.createElement('span'));
    if (!text) throw new Error(`${patient.nama}: tidak dapat menemukan tanggal layanan dari riwayat pelayanan.`);
    const [dd, mm, yyyy] = text.split('-').map(Number);
    const correctedDate = new Date(yyyy, mm - 1, dd).toISOString();
    log('info', `${patient.nama}: tanggal layanan terakhir = ${text}.`);
    return { notFound: true, correctedDate };
  }

  PCB.pendaftaran = { viaRujukan, viaBaru, pelayananCheckDate };
})(window);
