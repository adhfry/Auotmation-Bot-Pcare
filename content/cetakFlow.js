// Print flow (SPP + FKPP) — deliberately SEPARATE from pelayananFlow.js. Requested
// explicitly: registration (Pendaftaran), service entry (Pelayanan), and printing are
// three independent jobs, each simpler and less bug-prone on its own. This file
// duplicates the small amount of "open today's LABKESDA visit" logic it needs rather than
// reaching into pelayananFlow.js's internals (which already has its own hard-won,
// carefully-tuned version of this for reading vitals) — keeping this newer, less-tested
// flow from ever being able to destabilize the already-working Pelayanan flow.
//
// Button ids (#spp_btn, #cetakFKPP_btn) are ported from a prior automation project for
// this exact PCare system (Asisten-Cerdas-Smart-RPA) — same site, same real DOM ids —
// with a text-based fallback in case PCare ever renders them without those ids.
(function (global) {
  const PCB = global.PCB || (global.PCB = {});
  const {
    humanClick,
    humanPause,
    byText,
    byRoleButton,
    waitFor,
    waitForPaceLoading,
    textOf,
    requestRealClick,
    recentPageErrors,
    recentNetworkCalls,
  } = PCB.dom;
  const { fmtDateDDMMYYYY } = PCB.select2;

  /**
   * Opens "Riwayat Pelayanan Peserta" and loads the row whose Faskes is LABKESDA Sumenep
   * and whose Tgl.Layan matches `tanggalLayanan` — printing SPP/FKPP only ever makes sense
   * for a visit LABKESDA itself registered (never a referring puskesmas's own historical
   * row, which can share the same date but belongs to a different Faskes entirely).
   */
  async function openLabkesdaVisit(tanggalLayanan, log) {
    const tampilkan = document.querySelector('#linkRiwayat a') || byText('Tampilkan data riwayat pelayanan', {});
    if (!tampilkan) throw new Error('Tautan "Tampilkan data riwayat pelayanan" tidak ditemukan.');
    await humanClick(tampilkan);
    await waitForPaceLoading(20000);

    const realRows = await waitFor(() => {
      const trs = Array.from(document.querySelectorAll('#riwayatPelayanan tbody tr'));
      const withData = trs.filter((tr) => textOf(tr.querySelectorAll('td')[3] || document.createElement('span')));
      return withData.length ? withData : null;
    }, 10000, 250);
    if (!realRows) throw new Error('Tabel riwayat pelayanan tidak muncul / belum berisi data.');
    await humanPause(300, 600);

    const wanted = fmtDateDDMMYYYY(tanggalLayanan);
    const labkesdaRow = realRows.find(
      (row) =>
        textOf(row.querySelectorAll('td')[3]) === wanted &&
        /labkes/i.test(textOf(row.querySelectorAll('td')[1] || document.createElement('span')))
    );
    if (!labkesdaRow) {
      throw new Error(
        `Tidak ada kunjungan LABKESDA Sumenep dengan Tgl.Layan ${wanted} di riwayat — jalankan alur Pelayanan dulu untuk tanggal ini sebelum mencetak.`
      );
    }

    const kunjunganBtn = labkesdaRow.querySelector('button');
    if (!kunjunganBtn) throw new Error('Tombol No.Kunjungan tidak ditemukan di baris riwayat LABKESDA.');

    // Same click-retry + real-OS-click escalation pattern already proven in
    // pelayananFlow.js's lookupVitalsFromRiwayat() for this exact widget.
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
      if (attempt > 0) await humanPause(500, 900);
      if (attempt < 2) {
        await humanClick(kunjunganBtn);
      } else {
        const clicked = await requestRealClick(kunjunganBtn);
        if (!clicked) await humanClick(kunjunganBtn); // native host unavailable — fall back
      }
      await waitForPaceLoading(15000);
      opened = await waitFor(() => {
        const el = document.getElementById('faskesPelayan_lbl');
        return el && /labkes/i.test(textOf(el)) ? true : null;
      }, 12000, 300);
    }
    if (!opened) {
      const el = document.getElementById('faskesPelayan_lbl');
      const pageErrors = recentPageErrors();
      const netCalls = recentNetworkCalls();
      throw new Error(
        'Kunjungan LABKESDA belum termuat setelah beberapa percobaan klik No.Kunjungan, termasuk klik OS asli ' +
          `(Faskes Pelayanan saat ini: "${el ? textOf(el) : '-'}")` +
          (pageErrors.length ? `. Error JS dari halaman PCare: ${pageErrors.join(' | ')}` : '.') +
          (netCalls.length ? ` Request AJAX terkait: ${netCalls.join(' || ')}` : '')
      );
    }

    // Same date crosscheck as the rest of the codebase: #txttanggalkunjungan's REAL value
    // is dd-mm-yyyy (its placeholder misleadingly says yyyy-MM-dd) — compare with
    // fmtDateDDMMYYYY, never a hand-rolled format.
    const tglValue = document.getElementById('txttanggalkunjungan')?.value || '';
    if (tglValue !== wanted) {
      throw new Error(
        `Kunjungan yang terbuka bertanggal "${tglValue || '(kosong)'}", bukan tanggal yang dicari (${wanted}) — salah kunjungan yang ter-load.`
      );
    }
    log('info', `Kunjungan LABKESDA tanggal ${wanted} berhasil dibuka untuk dicetak.`);
  }

  /**
   * Searches for the patient (same widget/crosschecks as Pelayanan's own search) and opens
   * their LABKESDA visit for `tanggalLayanan`. Reuses PCB.pelayanan.searchByBpjs directly
   * rather than re-implementing the search — that function's Turnstile/retry/identity
   * crosschecks are already hard-won and shared verbatim, only the post-search step (open
   * riwayat + confirm LABKESDA) differs from what Pelayanan itself needs.
   */
  async function searchAndOpen({ patient, tanggalLayanan }, log) {
    if (!tanggalLayanan) {
      throw new Error(`${patient.nama}: TANGGAL_LAYANAN belum ada — jalankan alur Pendaftaran & Pelayanan dulu.`);
    }
    await PCB.pelayanan.searchByBpjs(patient, tanggalLayanan, log);
    await openLabkesdaVisit(tanggalLayanan, log);
    return { ready: true };
  }

  /**
   * Clicks a print-trigger button (SPP or FKPP). Both open PCare in a NEW tab showing a
   * PDF — we never touch that tab's content from here (cross-origin/PDF-viewer content
   * scripts can't run inside it anyway); background.js picks it up via chrome.tabs.onCreated
   * to either save it to Downloads or hand it to the native host for a silent print.
   */
  async function clickPrintButton(kind, idGuess, textPattern, log) {
    const btn = document.getElementById(idGuess) || byRoleButton(textPattern);
    if (!btn) throw new Error(`Tombol "${kind}" tidak ditemukan.`);
    await humanClick(btn);
    log('info', `Tombol "${kind}" diklik — menunggu tab cetak terbuka...`);
    return { clicked: true };
  }

  function clickSpp(log) {
    return clickPrintButton('SPP', 'spp_btn', /^spp$/i, log);
  }

  function clickFkpp(log) {
    return clickPrintButton('FKPP', 'cetakFKPP_btn', /cetak fkpp/i, log);
  }

  PCB.cetak = { searchAndOpen, clickSpp, clickFkpp };
})(window);
