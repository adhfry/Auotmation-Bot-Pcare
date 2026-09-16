// Ported from src/pcare/pelayanan.js. Assumes the background service worker has already
// navigated this tab to the Pelayanan page once before calling `run()` — everything
// after that is AJAX-only on the same page load (search, fill, save), so this whole flow
// executes as ONE content-script message handler.
(function (global) {
  const PCB = global.PCB || (global.PCB = {});
  const {
    humanClick,
    humanType,
    humanPause,
    byText,
    byPlaceholder,
    byRoleButton,
    waitForInputFollowingText,
    waitForId,
    fillAndSearchWithRetry,
    waitForPaceLoading,
    requestRealClick,
    requestRealEnter,
    dismissReminderPopup,
    waitFor,
    textOf,
    isVisible,
    getNotifyMessage,
    diagnosticSnapshot,
    recentPageErrors,
    recentNetworkCalls,
    fireEnterKeyEvent,
  } = PCB.dom;
  const { pickDate, pickSelect2ById, fmtDateDDMMYYYY } = PCB.select2;
  const { NON_KAPITASI_TABS, nonKapitasiSelectionFor } = PCB;

  const ANCHOR_FIELD_TIMEOUT_MS = 15000;

  // Same shared "Pendaftaran" search widget as pendaftaranFlow.js — confirmed live DOM:
  // date field is #txttanggal, search button is icon-only #btnCariPendaftaran (no visible
  // "Cari" text, so byRoleButton(/cari/i) alone could never find it).
  async function findTanggalPendaftaranInput(fallbackLabel, timeoutMs) {
    const byId = await waitForId("txttanggal", 3000);
    if (byId) return byId;
    return waitForInputFollowingText(fallbackLabel, timeoutMs);
  }
  async function findCariButton() {
    return (
      document.getElementById("btnCariPendaftaran") || byRoleButton(/cari/i)
    );
  }

  async function searchByBpjs(patient, tanggalLayanan, log) {
    await humanPause(500, 1100);
    await dismissReminderPopup(log);

    const tanggalInput = await findTanggalPendaftaranInput(
      "Tanggal Pendaftaran",
      ANCHOR_FIELD_TIMEOUT_MS,
    );
    if (!tanggalInput) {
      log(
        "warn",
        `Diagnostik halaman: ${JSON.stringify(diagnosticSnapshot())}`,
      );
      throw new Error('Input "Tanggal Pendaftaran" tidak ditemukan.');
    }
    await pickDate(tanggalInput, tanggalLayanan);

    const noKartuRadio =
      byText("No.Kartu", { exact: true }) || document.getElementById("rbkartu");
    if (!noKartuRadio) throw new Error('Radio "No.Kartu" tidak ditemukan.');
    await humanClick(noKartuRadio);

    const bpjsInput = byPlaceholder("Nomor", { nth: 0 });
    const found = await fillAndSearchWithRetry(
      bpjsInput,
      findCariButton,
      patient.noBpjs,
      // Confirmed live: PCare can render the name with different punctuation than the
      // Excel source (e.g. "ABD. LATIF" vs Excel's "ABD LATIF") — matching the raw name
      // string against the whole page silently fails on these formatting differences and
      // wrongly reports "not found" even though the correct patient loaded. Check the
      // dedicated #lblnmpst name label is populated instead (the same reliable signal the
      // identity crosscheck right below already uses), not a hand-formatted text match.
      async () => {
        if (byText("data tidak ditemukan", {})) return false;
        return !!(await waitFor(
          () => {
            const el = document.getElementById("lblnmpst");
            return el && textOf(el) ? el : null;
          },
          8000,
          200,
        ));
      },
      log,
    );
    if (!found) {
      throw new Error(
        `${patient.nama}: "Data tidak ditemukan" untuk tanggal ${fmtDateDDMMYYYY(tanggalLayanan)}. ` +
          "Jalankan alur Pendaftaran dulu untuk tanggal ini, atau perbaiki TANGGAL_LAYANAN di Excel.",
      );
    }

    // Soft crosscheck (warns, doesn't block): the loaded name should at least resemble the
    // expected one once punctuation/spacing differences are normalized away — catches a
    // genuinely wrong record without reintroducing the exact-string-match bug above.
    const loadedNama = textOf(
      document.getElementById("lblnmpst") || document.createElement("span"),
    );
    const normalizeNama = (s) => (s || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (
      loadedNama &&
      normalizeNama(loadedNama) !== normalizeNama(patient.nama)
    ) {
      log(
        "warn",
        `Nama pasien yang termuat ("${loadedNama}") berbeda dari data Excel ("${patient.nama}") — periksa apakah ini pasien yang benar.`,
      );
    }

    // Crosscheck requested explicitly: confirm the real "No.Kartu BPJS <nomor> - Prolanis"
    // pattern has actually rendered (#lblnokartu + #prb_lbl, confirmed live DOM) before
    // trusting the search succeeded — not just that the labels exist (they do, empty,
    // from page load) or that "Prolanis" appears anywhere on the page.
    const identityReady = await waitFor(
      () => {
        const nama = document.getElementById("lblnmpst");
        const noKartu = document.getElementById("lblnokartu");
        const prb = document.getElementById("prb_lbl");
        return nama &&
          textOf(nama) &&
          noKartu &&
          textOf(noKartu) &&
          prb &&
          /prolanis/i.test(textOf(prb))
          ? true
          : null;
      },
      12000,
      200,
    );
    if (!identityReady) {
      const noKartuNow = textOf(
        document.getElementById("lblnokartu") || document.createElement("span"),
      );
      const prbNow = textOf(
        document.getElementById("prb_lbl") || document.createElement("span"),
      );
      throw new Error(
        `${patient.nama}: pola "No.Kartu BPJS ... - Prolanis" belum muncul setelah pencarian ` +
          `(No.Kartu saat ini: "${noKartuNow}", label Prolanis: "${prbNow}").`,
      );
    }
    await humanPause(400, 900);
  }

  /**
   * Opens Riwayat Pelayanan Peserta and reads the puskesmas-asal vitals. IMPORTANT:
   * viewing that panel clobbers our own Kunjungan form, so the caller re-runs
   * searchByBpjs() afterward to get a fresh, empty form again.
   *
   * Every wait below checks for genuinely POPULATED content, not mere DOM presence — the
   * riwayat table container and the vitals inputs both already exist (empty/disabled) the
   * instant the page loads, well before any of their real data does. Reading too early
   * silently returns nulls/zeros instead of a clear error, which is exactly what happened
   * live before this fix.
   */
  async function lookupVitalsFromRiwayat(tanggalLayanan, log) {
    // #linkRiwayat is this link's real, confirmed container id — prefer it over the fuzzy
    // text match, falling back to that only if a page turns out not to use this id.
    const tampilkan =
      document.querySelector("#linkRiwayat a") ||
      byText("Tampilkan data riwayat pelayanan", {});
    if (!tampilkan)
      throw new Error(
        'Tautan "Tampilkan data riwayat pelayanan" tidak ditemukan.',
      );
    await humanClick(tampilkan);
    await waitForPaceLoading(20000); // Pace.js's global loading indicator, not a guessed pause

    // Scope to the actual #riwayatPelayanan table specifically — this page has several
    // other <table><tbody><tr> structures (e.g. the hidden skrining-detail modal), so an
    // unscoped selector risks matching the wrong one. Also require a real Tgl.Layan value
    // in each row, since DataTables briefly shows a "Processing..." placeholder state
    // before rows actually populate.
    const realRows = await waitFor(
      () => {
        const trs = Array.from(
          document.querySelectorAll("#riwayatPelayanan tbody tr"),
        );
        const withData = trs.filter((tr) =>
          textOf(
            tr.querySelectorAll("td")[3] || document.createElement("span"),
          ),
        );
        return withData.length ? withData : null;
      },
      10000,
      250,
    );
    if (!realRows)
      throw new Error(
        "Tabel riwayat pelayanan tidak muncul / belum berisi data.",
      );
    await humanPause(300, 600);

    const wanted = fmtDateDDMMYYYY(tanggalLayanan);
    const rowsForDate = realRows.filter(
      (row) => textOf(row.querySelectorAll("td")[3]) === wanted,
    );
    if (!rowsForDate.length)
      throw new Error(
        `Tidak ada No.Kunjungan dengan Tgl.Layan ${wanted} di riwayat.`,
      );

    // Confirmed live: PCare can list BOTH the referring puskesmas's row (e.g. GULUK-GULUK)
    // AND LABKESDA's own row for the SAME date at once. If a LABKESDA row for this exact
    // date already exists, that means pelayanan for today was already registered (by an
    // earlier run, or manually) — creating another Kunjungan would duplicate it. Always
    // prefer that row when present; the caller uses `alreadyRegisteredToday` to skip
    // straight to Non Kapitasi instead of filling/saving a brand-new Kunjungan.
    const labkesdaRowToday = rowsForDate.find((row) =>
      /labkes/i.test(
        textOf(row.querySelectorAll("td")[1] || document.createElement("span")),
      ),
    );
    const matchRow = labkesdaRowToday || rowsForDate[0];
    const alreadyRegisteredToday = !!labkesdaRowToday;

    const kunjunganBtn = matchRow.querySelector("button");
    if (!kunjunganBtn)
      throw new Error("Tombol No.Kunjungan tidak ditemukan di baris riwayat.");

    // The earlier failures here were never actually about the click — the loading
    // indicator always fired, proving the click registered. The real bug was
    // readCurrentVitals()'s old label-proximity lookups silently resolving to the WRONG
    // element (confirmed live via the panel's on-demand button once it was switched to
    // real ids). Now that reading is fixed, automation can safely resume: click, wait,
    // read by id — with the same click-retry + real-OS-click fallback as before, since
    // that part was always sound.
    let suhuInput = null;
    for (let attempt = 0; attempt < 3 && !suhuInput; attempt += 1) {
      if (attempt > 0) await humanPause(500, 900);
      if (attempt < 2) {
        await humanClick(kunjunganBtn);
      } else {
        const clicked = await requestRealClick(kunjunganBtn);
        if (!clicked) await humanClick(kunjunganBtn); // native host unavailable — fall back
      }
      await waitForPaceLoading(15000);
      suhuInput = await waitFor(
        () => {
          const input = document.getElementById("suhu_txt");
          return input && !input.disabled && input.value ? input : null;
        },
        12000,
        300,
      );
    }
    if (!suhuInput) {
      const el = document.getElementById("suhu_txt");
      const pageErrors = recentPageErrors();
      const netCalls = recentNetworkCalls();
      throw new Error(
        `Data riwayat Kunjungan (vital sign) belum termuat setelah beberapa percobaan klik No.Kunjungan, termasuk klik OS asli ` +
          `(field Suhu: disabled=${el?.disabled}, value="${el?.value}")` +
          (pageErrors.length
            ? `. Error JS dari halaman PCare: ${pageErrors.join(" | ")}`
            : ". Tidak ada error JS dari halaman PCare yang tertangkap.") +
          (netCalls.length
            ? ` Request AJAX terkait: ${netCalls.join(" || ")}`
            : " Tidak ada request AJAX terkait yang tertangkap."),
      );
    }
    await humanPause(850, 1200); // let the rest of the fields (Tinggi/Berat/Sistole/dst) finish populating too

    // Crosscheck: confirm the visit that actually loaded is for the SAME date we searched
    // for, not just trusting the riwayat table's own row text. NOTE: #txttanggalkunjungan's
    // placeholder says "yyyy-MM-dd" but its REAL populated value is dd-mm-yyyy (confirmed
    // live: "20-08-2026") — the placeholder does not describe the runtime format. Compare
    // using fmtDateDDMMYYYY (the same format used everywhere else in this codebase), not a
    // hand-rolled ISO string — an earlier version of this check compared against the wrong
    // format and rejected perfectly correct matches as "wrong date".
    const wantedDisplay = fmtDateDDMMYYYY(tanggalLayanan);
    const tglKunjunganValue =
      document.getElementById("txttanggalkunjungan")?.value || "";
    if (tglKunjunganValue !== wantedDisplay) {
      throw new Error(
        `Kunjungan yang terbuka bertanggal "${tglKunjunganValue || "(kosong)"}", bukan tanggal yang dicari (${wantedDisplay}) — ` +
          "salah kunjungan yang ter-load, data vital sign tidak bisa dipercaya.",
      );
    }
    log(
      "debug",
      `Tanggal kunjungan terverifikasi cocok: ${tglKunjunganValue}.`,
    );

    const num = (id) => {
      const v = document.getElementById(id)?.value;
      return v ? Number(v) : null;
    };
    const vitals = {
      suhu: num("suhu_txt"),
      tinggiBadan: num("tinggiBadan"),
      beratBadan: num("beratBadan"),
      lingkarPerut: num("lingkarPerut"),
      sistole: num("sistole"),
      diastole: num("diastole"),
      respiratoryRate: num("respRate"),
      heartRate: num("heartRate"),
    };

    log("debug", `Vital sign dari riwayat: ${JSON.stringify(vitals)}`);
    return { vitals, alreadyRegisteredToday };
  }

  async function fillKunjunganForm(patient, vitals, tenagaMedis, log) {
    // Same "disabled until real data/state has loaded" pattern as the riwayat vitals
    // panel — after the fresh re-search, the Kunjungan panel's fields need a moment
    // before they're actually enabled for input; typing into a still-disabled field
    // wouldn't properly register with the page's own JS (select2 sync, validation, etc.).
    // Confirmed real ids throughout this function (from live DOM, pasted directly by the
    // user) instead of the fragile "find the label, walk forward to the next input"
    // approach — that approach silently breaks for any label wrapping a nested child (the
    // red "*" required-marker span makes EVERY one of these labels non-leaf), falling
    // through to a cruder fallback that can walk forward from entirely the wrong starting
    // point. Confirmed live: this was actually returning the SAME wrong element for
    // several different fields at once (Tinggi Badan/Sistole/Diastole/Heart Rate/Diagnosa
    // all resolved to one one shared wrong input) — not a timing problem at all.
    const byId = (id) => document.getElementById(id);

    const keluhanReady = await waitFor(
      () => {
        const el = byId("keluhan");
        return el && !el.disabled ? el : null;
      },
      10000,
      250,
    );
    if (!keluhanReady)
      throw new Error(
        "Form Kunjungan belum aktif (field Keluhan masih disabled) setelah pencarian ulang.",
      );
    await humanPause(300, 600);

    const isDm = patient.dmHt === "DM";
    const keluhanText = isDm ? "Diabetes Mellitus" : "Hipertensi";
    const diagnosaCode = isDm ? "E11.9" : "I10";

    await humanType(byId("keluhan"), keluhanText);
    await humanType(byId("anamnesa_txt"), keluhanText);

    // Confirmed live DOM: these "plain-looking" dropdowns are actually select2 widgets
    // with known ids (alergiMakan_slc/alergiUdara_slc/alergiObat_slc, prognosa_slc) — using
    // pickSelect2ById targets the real clickable box directly instead of guessing at
    // "whatever's near this label", and crosschecks the pick actually landed.
    for (const slcId of [
      "alergiMakan_slc",
      "alergiUdara_slc",
      "alergiObat_slc",
    ]) {
      await pickSelect2ById(slcId, "Tidak Ada", { exact: true }).catch(
        (err) => {
          log("warn", `Riwayat Alergi (${slcId}): ${err.message}`);
        },
      );
    }

    await pickSelect2ById("prognosa_slc", "Bonam (Baik)", { exact: true });

    await humanType(byId("terapiMedikamentosa_txt"), "----");
    await humanType(byId("terapiNonMedikamentosa_txt"), "----");

    // The description field only populates via onfocusout="...readNamaDiagnosa(...)" — an
    // AJAX lookup triggered by BLUR, not by typing (same class of bug as the BPJS number's
    // zero-padding earlier: typing alone never fires it). Confirmed live by the user: on the
    // real page this is actually triggered by pressing Enter after typing the code — so fire
    // a synthetic Enter first (also blur as a cheap belt-and-suspenders since the handler is
    // wired to onfocusout), then escalate to a real OS-level Enter if the lookup still hasn't
    // fired, same escalation pattern used for the datepicker/select2/riwayat-button clicks.
    const diagnosaInput = byId("kddiagnosa1");
    await humanType(diagnosaInput, diagnosaCode);
    fireEnterKeyEvent(diagnosaInput);
    diagnosaInput.blur();
    let diagnosaDesc = await waitFor(
      () => {
        const el = byId("nmdiagnosa1");
        return el && el.value ? el : null;
      },
      6000,
      250,
    );
    if (!diagnosaDesc) {
      const realEnterSent = await requestRealEnter(diagnosaInput);
      if (realEnterSent) {
        diagnosaDesc = await waitFor(
          () => {
            const el = byId("nmdiagnosa1");
            return el && el.value ? el : null;
          },
          6000,
          250,
        );
      }
    }
    if (!diagnosaDesc) {
      throw new Error(
        `Diagnosa ${diagnosaCode}: deskripsi tidak muncul otomatis — periksa apakah kode diagnosa benar.`,
      );
    }
    log("info", `Diagnosa: ${diagnosaCode} - ${diagnosaDesc.value}`);

    const fillNum = async (id, value) => {
      if (value === null || value === undefined) return;
      const input = byId(id);
      if (input) await humanType(input, value);
    };
    await fillNum("suhu_txt", vitals.suhu);
    await fillNum("tinggiBadan", vitals.tinggiBadan);
    await fillNum("beratBadan", vitals.beratBadan);
    await fillNum("lingkarPerut", vitals.lingkarPerut);
    await fillNum("sistole", vitals.sistole);
    await fillNum("diastole", vitals.diastole);
    await fillNum("respRate", vitals.respiratoryRate);
    await fillNum("heartRate", vitals.heartRate);

    // Confirmed against PCare's real DOM: Tenaga Medis is a select2 widget whose
    // underlying <select> has id="tenagamedis".
    await pickSelect2ById("tenagamedis", tenagaMedis, { exact: false });

    // Confirmed against PCare's real DOM: id="listNonKapitasi_slc" — a multi-select select2.
    // Each tag is appended (not replaced) since more than one non-kapitasi item can be
    // selected for the same visit.
    const nonKapitasiTags = nonKapitasiSelectionFor(patient.dmHt);
    for (const tag of nonKapitasiTags) {
      await pickSelect2ById("listNonKapitasi_slc", tag, {
        exact: false,
        append: true,
      });
    }

    // Confirmed live: Status Pulang is also select2 (id="statuspulang").
    await pickSelect2ById("statuspulang", "Berobat Jalan", { exact: true });

    const simpanBtn = byRoleButton(/^simpan$/i);
    await humanClick(simpanBtn);
    await waitForPaceLoading(20000);
    const toast = await waitFor(
      () => byText("data kunjungan berhasil disimpan", {}),
      8000,
      200,
    );
    if (!toast)
      throw new Error("Toast konfirmasi simpan kunjungan tidak muncul.");
    log("info", `${patient.nama}: data kunjungan tersimpan.`);

    return { nonKapitasiTags };
  }

  // Confirmed against PCare's real DOM (pasted live) — each non-kapitasi service has its
  // own fixed tab-pane id, addressed by the tab <a>'s href, which is far more reliable than
  // matching the tab's visible text (the <a> also contains a decorative icon span).
  const NON_KAPITASI_TAB_IDS = {
    "Pelayanan Gula Darah": "tabDet_10",
    "Pelayanan HbA1c": "tabDet_11",
    "Pelayanan Kimia Darah": "tabDet_12",
  };

  async function openNonKapitasiTab(tabName) {
    const tabId = NON_KAPITASI_TAB_IDS[tabName];
    if (!tabId) throw new Error(`Tab non-kapitasi "${tabName}" tidak dikenal.`);
    const tabLink = document.querySelector(`a[href="#${tabId}"]`);
    if (!tabLink)
      throw new Error(
        `Tab "${tabName}" (#${tabId}) tidak ditemukan di halaman.`,
      );
    await humanClick(tabLink);
    const pane = await waitFor(
      () => {
        const el = document.getElementById(tabId);
        return el && isVisible(el) ? el : null;
      },
      8000,
      150,
    );
    if (!pane)
      throw new Error(
        `Tab "${tabName}" tidak terbuka/terlihat setelah diklik.`,
      );
    await humanPause(200, 400);
    return pane;
  }

  /**
   * Waits for PCare's save toast and classifies it — ported from the reference project's
   * tunggu_hasil_simpan(): a toast containing "berhasil disimpan" means success; ANY other
   * toast text is a real business-rule rejection (duplicate item, plafon exceeded, etc.)
   * that must be surfaced as a failure, never silently treated as success just because the
   * AJAX round-trip finished.
   */
  async function waitForSaveNotify(timeoutMs = 8000) {
    await waitForPaceLoading(timeoutMs);
    const msg = await waitFor(() => getNotifyMessage() || null, timeoutMs, 200);
    if (!msg) return { ok: false, message: "" };
    return { ok: /berhasil disimpan/i.test(msg), message: msg };
  }

  // Confirmed live: Kimia Darah toggles between a LIST view (#listKimiaDarah_lyt, with the
  // "+Tambah Data Baru" button and the results table) and a FORM view (#contentKimiaDarah_lyt)
  // — after each save it reverts to the list view, so this must run again before every item.
  async function pastikanFormKimiaDarah() {
    const list = document.getElementById("listKimiaDarah_lyt");
    const content = document.getElementById("contentKimiaDarah_lyt");
    if (content && isVisible(content) && !(list && isVisible(list))) return;
    const tambahBtn = document.getElementById("tambahPelayanan_btn");
    if (tambahBtn && isVisible(tambahBtn)) {
      await humanClick(tambahBtn);
      await humanPause(300, 600);
    }
  }

  async function fillKimiaDarahItem(itemLabel, rawValue, patient, log) {
    await pastikanFormKimiaDarah();
    await pickSelect2ById("jnsPelayanan_slc", itemLabel, { exact: false });

    const hasilInput = document.querySelector("#tabDet_12 #hasil_txt");
    if (!hasilInput)
      throw new Error(
        `Field Hasil untuk "${itemLabel}" (Kimia Darah) tidak ditemukan.`,
      );
    await humanType(hasilInput, String(rawValue).replace(",", "."));

    const simpanBtn = document.querySelector("#tabDet_12 button#simpan_btn");
    if (!simpanBtn)
      throw new Error("Tombol Simpan (Kimia Darah) tidak ditemukan.");
    await humanClick(simpanBtn);

    const { ok, message } = await waitForSaveNotify();
    if (!ok) {
      throw new Error(
        `${patient.nama}: gagal menyimpan "${itemLabel}" (Kimia Darah)` +
          (message
            ? ` — ${message}`
            : " (tidak ada notifikasi konfirmasi dari PCare)."),
      );
    }
    log(
      "info",
      `${patient.nama}: Kimia Darah "${itemLabel}" = ${rawValue} tersimpan (${message}).`,
    );
  }

  // Confirmed live: this dropdown is a PLAIN <select> (not select2), so a direct
  // value+change is both correct and simpler/more reliable than the select2 machinery.
  async function fillGulaDarahPuasa(rawValue, patient, log) {
    const listBtnWrap = document.getElementById(
      "div_tambahPelayananGulaDarah_btn",
    );
    if (listBtnWrap && isVisible(listBtnWrap)) {
      const tambahBtn = document.getElementById("tambahPelayananGulaDarah_btn");
      if (tambahBtn) {
        await humanClick(tambahBtn);
        await humanPause(300, 600);
      }
    }

    const jenisSelect = document.getElementById("cb_jns_pemeriksaan_darah");
    if (!jenisSelect)
      throw new Error("Dropdown Jns.Pemeriksaan (Gula Darah) tidak ditemukan.");
    const option = Array.from(jenisSelect.options).find((o) =>
      /puasa/i.test(o.textContent),
    );
    if (!option)
      throw new Error(
        'Opsi "Gula Darah Puasa" tidak ditemukan di dropdown Jns.Pemeriksaan.',
      );
    jenisSelect.value = option.value;
    jenisSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await humanPause(200, 400);

    const hasilInput = document.querySelector("#tabDet_10 #hasil_txt");
    if (!hasilInput)
      throw new Error("Field Hasil (Gula Darah Puasa) tidak ditemukan.");
    await humanType(hasilInput, String(rawValue).replace(",", "."));

    const simpanBtn = document.querySelector("#tabDet_10 button#simpan_btn");
    if (!simpanBtn)
      throw new Error("Tombol Simpan (Gula Darah) tidak ditemukan.");
    await humanClick(simpanBtn);

    const { ok, message } = await waitForSaveNotify();
    if (!ok) {
      throw new Error(
        `${patient.nama}: gagal menyimpan Gula Darah Puasa` +
          (message
            ? ` — ${message}`
            : " (tidak ada notifikasi konfirmasi dari PCare)."),
      );
    }
    log(
      "info",
      `${patient.nama}: Gula Darah Puasa = ${rawValue} tersimpan (${message}).`,
    );
  }

  async function fillHbA1c(rawValue, patient, log) {
    const hasilInput = document.querySelector("#tabDet_11 #hasil_txt");
    if (!hasilInput) throw new Error("Field Hasil (HbA1c) tidak ditemukan.");
    await humanType(hasilInput, String(rawValue).replace(",", "."));

    const simpanBtn = document.querySelector("#tabDet_11 button#simpan_btn");
    if (!simpanBtn) throw new Error("Tombol Simpan (HbA1c) tidak ditemukan.");
    await humanClick(simpanBtn);

    const { ok, message } = await waitForSaveNotify();
    if (!ok) {
      throw new Error(
        `${patient.nama}: gagal menyimpan HbA1c` +
          (message
            ? ` — ${message}`
            : " (tidak ada notifikasi konfirmasi dari PCare)."),
      );
    }
    log("info", `${patient.nama}: HbA1c = ${rawValue} tersimpan (${message}).`);
  }

  // Ported from the reference project's ambil_nama_pelayanan_dari_tabel()/daftar_mengandung():
  // reads the "Nama Pelayanan" column of a results table so already-entered items can be
  // detected and skipped, instead of blindly re-adding (and re-submitting) something that's
  // already there — confirmed live this matters: a LABKESDA visit for today can already
  // exist with SOME lab results filled in from an earlier run.
  function existingPelayananNames(tableId) {
    const rows = Array.from(document.querySelectorAll(`#${tableId} tbody tr`));
    const names = [];
    for (const row of rows) {
      if (/no data available/i.test(textOf(row))) continue;
      const firstCell = row.querySelector("td");
      const name = firstCell ? textOf(firstCell) : "";
      if (name) names.push(name);
    }
    return names;
  }

  function containsLabel(names, label) {
    const wanted = label.toLowerCase();
    return names.some(
      (n) =>
        n.toLowerCase().includes(wanted) || wanted.includes(n.toLowerCase()),
    );
  }

  async function fillNonKapitasiResults(patient, nonKapitasiTags, log) {
    for (const tabName of nonKapitasiTags) {
      const mapping = NON_KAPITASI_TABS[tabName];
      if (!mapping) continue;

      await openNonKapitasiTab(tabName);
      await waitForPaceLoading(10000);
      await humanPause(300, 600);

      for (const [col, itemLabel] of Object.entries(mapping.columns)) {
        const raw = patient[col];
        if (raw === null || raw === undefined || raw === "") continue;

        if (tabName === "Pelayanan Kimia Darah") {
          const existing = existingPelayananNames("daftarPelayanan_tbl");
          if (containsLabel(existing, itemLabel)) {
            log(
              "info",
              `${patient.nama}: Kimia Darah "${itemLabel}" sudah ada di riwayat pelayanan — dilewati.`,
            );
            continue;
          }
          await fillKimiaDarahItem(itemLabel, raw, patient, log);
        } else if (tabName === "Pelayanan Gula Darah") {
          const existing = existingPelayananNames("daftarPelayananGulaDarah");
          if (containsLabel(existing, "Gula Darah Puasa")) {
            log(
              "info",
              `${patient.nama}: Gula Darah Puasa sudah ada di riwayat pelayanan — dilewati.`,
            );
            continue;
          }
          await fillGulaDarahPuasa(raw, patient, log);
        } else if (tabName === "Pelayanan HbA1c") {
          // Confirmed live pattern (reference project): once HbA1c is already saved for
          // this visit, PCare disables its Simpan button rather than showing a list/table
          // like the other two tabs — a disabled button here means "already entered".
          const simpanBtn = document.querySelector(
            "#tabDet_11 button#simpan_btn",
          );
          if (simpanBtn && simpanBtn.disabled) {
            log(
              "info",
              `${patient.nama}: HbA1c sudah ada di riwayat pelayanan — dilewati.`,
            );
            continue;
          }
          await fillHbA1c(raw, patient, log);
        }
        await humanPause(400, 700);
      }
    }
  }

  /**
   * Clicks "Cetak FKPP", which PCare opens as a NEW browser tab showing the PDF. We don't
   * try to touch that tab's content from here (cross-origin/PDF-viewer content scripts
   * can't run inside it anyway) — we just report back that it was clicked, and the
   * background service worker (which sees chrome.tabs.onCreated) takes it from there:
   * saving the PDF via chrome.downloads and, if a printer was configured, handing it to
   * the native host for a silent print.
   */
  async function clickCetakFkpp(log) {
    const cetakBtn = byRoleButton(/cetak fkpp/i);
    if (!cetakBtn) throw new Error('Tombol "Cetak FKPP" tidak ditemukan.');
    await humanClick(cetakBtn);
    log("info", 'Tombol "Cetak FKPP" diklik — menunggu tab PDF terbuka...');
    return { clicked: true };
  }

  /** Full Pelayanan flow for one patient, up to (not including) the cetak/print step. */
  async function run({ patient, tanggalLayanan, tenagaMedis }, log) {
    if (!tanggalLayanan) {
      throw new Error(
        `${patient.nama}: TANGGAL_LAYANAN belum ada — jalankan alur Pendaftaran dulu.`,
      );
    }

    await searchByBpjs(patient, tanggalLayanan, log);
    const { vitals, alreadyRegisteredToday } = await lookupVitalsFromRiwayat(
      tanggalLayanan,
      log,
    );

    // Confirmed by the user against a live case: a LABKESDA Kunjungan for this exact date
    // can already exist (e.g. from an earlier run) even though Non Kapitasi lab results
    // haven't been filled in yet. Creating another Kunjungan here would duplicate the visit
    // — the correct move is to open that SAME existing record (already done inside
    // lookupVitalsFromRiwayat, which always prefers the LABKESDA row when present) and go
    // straight to Non Kapitasi, skipping fillKunjunganForm entirely.
    if (alreadyRegisteredToday) {
      log(
        "info",
        `${patient.nama}: kunjungan LABKESDA untuk tanggal ${fmtDateDDMMYYYY(tanggalLayanan)} sudah ada — tidak membuat kunjungan baru, langsung cek & lengkapi hasil Non Kapitasi.`,
      );
      const faskesOk = await waitFor(
        () => {
          const el = document.getElementById("faskesPelayan_lbl");
          return el && /labkes/i.test(textOf(el)) ? true : null;
        },
        8000,
        250,
      );
      if (!faskesOk) {
        const el = document.getElementById("faskesPelayan_lbl");
        throw new Error(
          `${patient.nama}: kunjungan LABKESDA hari ini terdeteksi di riwayat, tapi form yang terbuka menunjukkan Faskes "${el ? textOf(el) : "-"}" — tidak aman melanjutkan tanpa kepastian ini kunjungan yang benar.`,
        );
      }
      const nonKapitasiTags = nonKapitasiSelectionFor(patient.dmHt);
      await fillNonKapitasiResults(patient, nonKapitasiTags, log);
      log("info", `${patient.nama}: hasil Non Kapitasi selesai. Cetak FKPP/SPP ditangani lewat fitur cetak terpisah.`);
      return { done: true };
    }

    // Viewing the riwayat can leave the Kunjungan panel still referencing that OLD visit's
    // context (e.g. the referring puskesmas) instead of resetting to a genuine, fresh,
    // LABKESDA-context entry — confirmed against a prior automation project for this exact
    // system, which hit the same "form silently stuck on the wrong visit" failure mode.
    // The one reliable tell is the "Faskes Pelayanan" label: it must show LABKESDA before
    // touching any field. If a re-search doesn't produce that, re-search again rather than
    // filling a form that's still pointed at the wrong record.
    let faskesReady = false;
    for (let attempt = 1; attempt <= 3 && !faskesReady; attempt += 1) {
      await searchByBpjs(patient, tanggalLayanan, log);
      faskesReady = await waitFor(
        () => {
          const el = document.getElementById("faskesPelayan_lbl");
          return el && /labkes/i.test(textOf(el)) ? true : null;
        },
        8000,
        250,
      );
      if (!faskesReady) {
        const el = document.getElementById("faskesPelayan_lbl");
        log(
          "warn",
          `Faskes Pelayanan masih "${el ? textOf(el) : "-"}" (bukan LABKESDA) — mencari ulang (percobaan ${attempt}/3)...`,
        );
      }
    }
    if (!faskesReady) {
      const el = document.getElementById("faskesPelayan_lbl");
      throw new Error(
        `${patient.nama}: Faskes Pelayanan tetap menunjukkan "${el ? textOf(el) : "-"}" (bukan LABKESDA) setelah 3x pencarian ulang — form Kunjungan tidak pernah reset ke entri yang benar.`,
      );
    }

    const { nonKapitasiTags } = await fillKunjunganForm(
      patient,
      vitals,
      tenagaMedis,
      log,
    );
    await fillNonKapitasiResults(patient, nonKapitasiTags, log);

    log("info", `${patient.nama}: hasil Non Kapitasi selesai. Cetak FKPP/SPP ditangani lewat fitur cetak terpisah.`);
    return { done: true };
  }

  /**
   * Reads whatever the Kunjungan panel's context/vitals fields show RIGHT NOW — no
   * clicking, no waiting, just a snapshot of the live DOM. Meant to be triggered on demand
   * by the panel's "🔍 Ambil Data Kunjungan Sebelumnya" button, AFTER a human has manually
   * clicked a riwayat row and can see with their own eyes that the data has loaded —
   * sidesteps needing the bot to reliably detect when that specific async load finishes,
   * which repeated automated attempts (including a real OS-level click) never managed.
   */
  function readCurrentVitals() {
    // Confirmed real ids (from live DOM, pasted directly by the user) — NOT the fragile
    // "find the label, walk forward to the next input" approach. That approach silently
    // breaks for every field whose label wraps a nested child (the red "*" required-marker
    // span makes EVERY vitals label non-leaf), which falls through to a much cruder
    // fallback match and can walk forward from the wrong starting point entirely. This is
    // very likely the REAL cause behind the vitals/diagnosa reads being wrong all along —
    // not clicking or timing at all. Direct ids have no such ambiguity.
    const val = (id) => document.getElementById(id)?.value ?? "";
    const num = (id) => {
      const v = val(id);
      return v !== "" ? Number(v) : null;
    };

    const diagCode = val("kddiagnosa1");
    const diagDesc = val("nmdiagnosa1");

    return {
      faskesPelayanan: textOf(
        document.getElementById("faskesPelayan_lbl") ||
          document.createElement("span"),
      ),
      tanggalKunjungan: val("txttanggalkunjungan"),
      keluhan: val("keluhan"),
      anamnesa: val("anamnesa_txt"),
      diagnosa: diagCode ? `${diagCode} - ${diagDesc}` : "",
      vitals: {
        suhu: num("suhu_txt"),
        tinggiBadan: num("tinggiBadan"),
        beratBadan: num("beratBadan"),
        lingkarPerut: num("lingkarPerut"),
        sistole: num("sistole"),
        diastole: num("diastole"),
        respiratoryRate: num("respRate"),
        heartRate: num("heartRate"),
      },
      pageErrors: recentPageErrors(),
      networkCalls: recentNetworkCalls(),
    };
  }

  PCB.pelayanan = { run, readCurrentVitals, searchByBpjs };
})(window);
