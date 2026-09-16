// Side panel controller: owns the Excel file (via File System Access API) and drives
// background.js through a long-lived port. This replaces the old Electron GUI — same
// job, but living inside the user's real Chrome as a panel next to the PCare tab.
(function () {
  const state = {
    fileHandle: null,
    workbook: null,
    sheet: null,
    sheetName: null,
    headerRow: null,
    patients: [],
    selected: new Set(),
    tanggalOverride: new Map(), // rowNumber -> 'YYYY-MM-DD', per-patient Pendaftaran target date override
    lastRunMode: null, // mode of the most recently started batch — used by the proactive retry/next-stage recommendation
    lastRunRowNumbers: [], // which patients that batch covered
  };

  // MV3 service workers get torn down after ~30s idle, which silently kills this port —
  // Chrome throws "Attempting to use a disconnected port object" on the next postMessage,
  // with no visible error to the user (it's an uncaught exception inside a click handler).
  // That's the leading suspect for "klik Mulai kadang tidak terjadi apa-apa": the panel
  // sat open for a while, the background woke back up for something else in the meantime,
  // and the OLD port is now dead. So: reconnect automatically on disconnect, and route
  // every send through sendToBackground() so a still-dead port at send time gets one retry
  // instead of throwing silently.
  let port;
  function connectPort() {
    port = chrome.runtime.connect({ name: 'pcb' });
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
      appendLog('warn', 'Koneksi ke background terputus — menyambung ulang...');
      setTimeout(connectPort, 300);
    });
  }

  function sendToBackground(msg) {
    try {
      port.postMessage(msg);
    } catch (_) {
      connectPort();
      setTimeout(() => {
        try {
          port.postMessage(msg);
        } catch (err) {
          appendLog('error', `Gagal mengirim perintah ke background: ${err.message}`);
        }
      }, 300);
    }
  }

  // ---- tiny IndexedDB helper, just to remember the last file handle across panel opens ----
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('pcb-bot', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- log panel ----
  /** `lineId` lets a countdown ("dimulai dalam 3 detik" -> "2 detik" -> "1 detik") update
   * the SAME log line in place each second instead of spamming a new one every tick. */
  function appendLog(level, message, lineId) {
    const el = document.getElementById('logPanel');
    const time = new Date().toLocaleTimeString('id-ID');
    if (lineId) {
      const existing = el.querySelector(`[data-line-id="${lineId}"]`);
      if (existing) {
        existing.textContent = `[${time}] ${message}`;
        el.scrollTop = el.scrollHeight;
        return;
      }
    }
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    if (lineId) line.dataset.lineId = lineId;
    line.textContent = `[${time}] ${message}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  // ---- Excel file picking ----
  async function populateSheetPicker() {
    const select = document.getElementById('sheetSelect');
    select.innerHTML = '';
    for (const name of state.workbook.SheetNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    document.getElementById('sheetPickerRow').classList.remove('hidden');
  }

  async function loadSheet(sheetName) {
    state.sheetName = sheetName;
    state.sheet = state.workbook.Sheets[sheetName];
    const { patients, headerRow } = PcbExcel.readPatients(state.sheet);
    state.patients = patients;
    state.headerRow = headerRow;
    state.selected = new Set();
    state.tanggalOverride = new Map(); // row numbers are sheet-specific, so overrides don't carry over

    const batchDate = PcbExcel.readBatchDate(state.sheet, headerRow);
    const syncedEl = document.getElementById('batchDateSynced');
    if (batchDate) {
      document.getElementById('batchDate').value = batchDate.toISOString().slice(0, 10);
      syncedEl.textContent = '🔄 tersinkron dari Excel';
    } else {
      syncedEl.textContent = '';
    }

    applySmartDefaults();
    renderPatientTable();
  }

  /** Loads a picked/restored handle into state once we're sure we hold write permission. */
  async function activateFileHandle(handle) {
    state.fileHandle = handle;
    document.getElementById('excelFileName').textContent = handle.name;
    document.getElementById('reconnectFileBtn').classList.add('hidden');
    state.workbook = await PcbExcel.loadWorkbook(handle);
    await populateSheetPicker();
    await loadSheet(state.workbook.SheetNames[0]);
  }

  async function pickExcelFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
      });
      // Request write permission NOW, while we still have the click's user activation —
      // every later write (including ones triggered async by background.js mid-run, which
      // have no activation of their own) needs this granted up front, or createWritable()
      // throws SecurityError instead of being able to prompt.
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        appendLog('error', 'Izin tulis file ditolak — bot tidak bisa mencatat status tanpa izin ini.');
        return;
      }
      await idbSet('lastFileHandle', handle);
      await activateFileHandle(handle);
      appendLog('info', `File dimuat: ${handle.name} (${state.patients.length} pasien di sheet "${state.sheetName}").`);
    } catch (err) {
      if (err?.name !== 'AbortError') appendLog('error', `Gagal membuka file: ${err.message}`);
    }
  }

  /** Re-requests write permission for the remembered file — needs a real click (this
   * button) to supply user activation, since it runs outside any file-picker gesture. */
  async function reconnectLastFile() {
    try {
      const handle = await idbGet('lastFileHandle');
      if (!handle) return;
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        appendLog('warn', 'Izin tulis belum diberikan — file belum bisa dipakai.');
        return;
      }
      await activateFileHandle(handle);
      appendLog('info', `File "${handle.name}" diaktifkan ulang.`);
    } catch (err) {
      appendLog('error', `Gagal mengaktifkan ulang file: ${err.message}`);
    }
  }

  async function tryRestoreLastFile() {
    try {
      const handle = await idbGet('lastFileHandle');
      if (!handle) return;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        // Can't silently request permission without a user gesture — show a button
        // instead of failing later, mid-run, with a confusing SecurityError.
        const btn = document.getElementById('reconnectFileBtn');
        btn.textContent = `🔓 Aktifkan lagi: ${handle.name}`;
        btn.classList.remove('hidden');
        return;
      }
      await activateFileHandle(handle);
      appendLog('info', `File terakhir dimuat ulang: ${handle.name}.`);
    } catch (_) {
      // silent — user just picks again
    }
  }

  async function persistSheet() {
    await PcbExcel.saveWorkbook(state.fileHandle, state.workbook);
  }

  // ---- patient table ----
  function shouldDefaultCheck(patient, mode) {
    if (mode === 'pendaftaran') return patient.statusPendaftaran !== 'done' && patient.statusPendaftaran !== 'manual';
    if (mode === 'print') {
      // Printing has no persisted status column of its own (see handlePortMessage) — the
      // only sensible default is "Pelayanan is already done", same prerequisite the print
      // flow itself checks live on the page.
      return patient.statusPelayanan === 'done' || patient.statusPelayanan === 'manual';
    }
    return (
      (patient.statusPendaftaran === 'done' || patient.statusPendaftaran === 'manual') &&
      patient.statusPelayanan !== 'done' &&
      patient.statusPelayanan !== 'manual'
    );
  }

  function applySmartDefaults() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    state.selected = new Set(state.patients.filter((p) => shouldDefaultCheck(p, mode)).map((p) => p.rowNumber));
  }

  function statusCell(patient, stage) {
    const wrap = document.createElement('div');
    wrap.className = 'status-cell';
    const status = stage === 'pendaftaran' ? patient.statusPendaftaran : patient.statusPelayanan;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = status === 'done' || status === 'manual';
    checkbox.title = 'Tandai selesai manual';
    checkbox.addEventListener('change', async () => {
      const newStatus = checkbox.checked ? 'manual' : '';
      PcbExcel.writeStatus(state.sheet, state.headerRow, patient.rowNumber, stage, newStatus, '');
      await persistSheet();
      if (stage === 'pendaftaran') patient.statusPendaftaran = newStatus;
      else patient.statusPelayanan = newStatus;
      renderPatientTable();
    });

    const pill = document.createElement('span');
    pill.className = `status-pill status-${status || 'empty'}`;
    pill.textContent = status || '-';
    // Requested explicitly: when a status is flagged (e.g. "no rujukan data" for this
    // patient), show WHY right where the red pill already draws the eye — real Excel cell
    // coloring isn't available (the bundled SheetJS build silently drops cell styles on
    // write, confirmed by testing it directly), so this + the message column are the
    // reason surfaced to the user.
    const message = stage === 'pendaftaran' ? patient.pesanPendaftaran : patient.pesanPelayanan;
    if (message) pill.title = message;

    wrap.appendChild(checkbox);
    wrap.appendChild(pill);
    return wrap;
  }

  // Header-click "toggle all" for a status column: if every patient already shows
  // done/manual for this stage, unchecking all; otherwise checking all (same all-or-
  // nothing convention as a standard "select all" checkbox — a partial state is treated
  // as "not yet all checked", so the first click always fills the rest in rather than
  // clearing the ones already set).
  async function toggleAllStatus(stage) {
    if (!state.patients.length) return;
    const isChecked = (p) => {
      const status = stage === 'pendaftaran' ? p.statusPendaftaran : p.statusPelayanan;
      return status === 'done' || status === 'manual';
    };
    const allChecked = state.patients.every(isChecked);
    const newStatus = allChecked ? '' : 'manual';

    for (const p of state.patients) {
      PcbExcel.writeStatus(state.sheet, state.headerRow, p.rowNumber, stage, newStatus, '');
      if (stage === 'pendaftaran') p.statusPendaftaran = newStatus;
      else p.statusPelayanan = newStatus;
    }
    await persistSheet();
    renderPatientTable();
  }

  function renderPatientTable() {
    const tbody = document.getElementById('patientTableBody');
    tbody.innerHTML = '';
    for (const p of state.patients) {
      const tr = document.createElement('tr');

      const selectTd = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(p.rowNumber);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(p.rowNumber);
        else state.selected.delete(p.rowNumber);
      });
      selectTd.appendChild(cb);
      tr.appendChild(selectTd);

      let tglDisplay;
      if (state.tanggalOverride.has(p.rowNumber)) {
        const [y, m, d] = state.tanggalOverride.get(p.rowNumber).split('-');
        tglDisplay = `${d}-${m}-${y} (override)`;
      } else {
        tglDisplay = p.tanggalLayanan ? new Date(p.tanggalLayanan).toLocaleDateString('id-ID') : '-';
      }

      const cells = [p.no, p.nama, p.dmHt, p.noBpjs, tglDisplay];
      for (const val of cells) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.appendChild(td);
      }

      const daftarTd = document.createElement('td');
      daftarTd.appendChild(statusCell(p, 'pendaftaran'));
      tr.appendChild(daftarTd);

      const layananTd = document.createElement('td');
      layananTd.appendChild(statusCell(p, 'pelayanan'));
      tr.appendChild(layananTd);

      tbody.appendChild(tr);
    }
    document.getElementById('patientCount').textContent = `${state.patients.length} pasien, ${state.selected.size} dipilih`;
  }

  // ---- tenaga medis dropdown ----
  function populateTenagaMedisSelect() {
    const select = document.getElementById('tenagaMedisSelect');
    select.innerHTML = '';
    for (const [group, names] of Object.entries(PCB.TENAGA_MEDIS_GROUPS)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group;
      for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        optgroup.appendChild(opt);
      }
      select.appendChild(optgroup);
    }
  }

  // ---- mode toggle ----
  function onModeChange() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    document.getElementById('pendaftaranOnly').classList.toggle('hidden', mode !== 'pendaftaran');
    document.getElementById('pelayananOnly').classList.toggle('hidden', mode !== 'pelayanan');
    document.getElementById('printOnly').classList.toggle('hidden', mode !== 'print');
    if (state.patients.length) {
      applySmartDefaults();
      renderPatientTable();
    }
  }

  // ---- credentials modal ----
  async function openLoginModal() {
    const stored = await chrome.storage.local.get(['pcbCredentials']);
    document.getElementById('usernameInput').value = stored.pcbCredentials?.username || '';
    document.getElementById('passwordInput').value = '';
    document.getElementById('loginModalOverlay').classList.remove('hidden');
  }
  function closeLoginModal() {
    document.getElementById('loginModalOverlay').classList.add('hidden');
  }
  async function saveCredentials() {
    const username = document.getElementById('usernameInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    if (!username || !password) {
      appendLog('warn', 'Username dan password wajib diisi.');
      return;
    }
    await chrome.storage.local.set({ pcbCredentials: { username, password } });
    appendLog('info', 'Kredensial PCare disimpan.');
    closeLoginModal();
  }
  async function clearCredentials() {
    await chrome.storage.local.remove('pcbCredentials');
    appendLog('info', 'Kredensial PCare dihapus.');
    closeLoginModal();
  }

  // ---- run control ----
  function setRunButtons(status) {
    const running = status === 'running';
    const paused = status === 'paused';
    document.getElementById('startBtn').disabled = running || paused;
    document.getElementById('pauseBtn').disabled = !running;
    document.getElementById('resumeBtn').disabled = !paused;
    document.getElementById('stopBtn').disabled = !(running || paused);
    document.getElementById('runStatus').textContent = status;
  }

  /** Starts a batch for an explicit patient list + mode, reusing whatever tenaga medis /
   * printer / batch date is currently set in the UI. Used both by the Mulai button (with
   * the checked rows) and by the recommendation modal (with a specific failed/succeeded
   * subset), so the "smart" auto-chained runs behave exactly like a manual run would. */
  function startBatch(mode, patientsList, { batchDateStr } = {}) {
    if (!patientsList.length) {
      appendLog('warn', 'Tidak ada pasien untuk diproses.');
      return false;
    }
    const payload = { mode };
    let finalPatients = patientsList;
    if (mode === 'pendaftaran') {
      const dateStr = batchDateStr || document.getElementById('batchDate').value;
      if (!dateStr) {
        appendLog('warn', 'Isi tanggal batch dulu.');
        return false;
      }
      payload.batchDate = dateStr;
      // Per-patient overrides (set via "Beda tanggal untuk pasien tertentu") win over the
      // single global batch date for whichever patients have one.
      finalPatients = patientsList.map((p) => {
        const override = state.tanggalOverride.get(p.rowNumber);
        return override ? { ...p, batchDateOverride: override } : p;
      });
    } else if (mode === 'print') {
      const connectPrinter = document.getElementById('connectPrinterChk').checked;
      payload.printerName = connectPrinter ? document.getElementById('printPrinterName').value.trim() || null : null;
    } else {
      payload.tenagaMedis = document.getElementById('tenagaMedisSelect').value;
    }
    payload.patients = finalPatients;
    // Remembered so the proactive recommendation modal (see checkRunCompletionRecommendations)
    // knows exactly which patients/mode this run covered once it finishes — needed to compute
    // "how many of THESE just failed/succeeded" from the current (cumulative-after-retries)
    // status in state.patients, not a stale per-run snapshot.
    state.lastRunMode = mode;
    state.lastRunRowNumbers = finalPatients.map((p) => p.rowNumber);
    sendToBackground({ cmd: 'START', payload });
    return true;
  }

  function startRun() {
    if (!state.patients.length) {
      appendLog('warn', 'Belum ada data pasien dimuat.');
      return;
    }
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const selectedPatients = state.patients.filter((p) => state.selected.has(p.rowNumber));
    if (!selectedPatients.length) {
      appendLog('warn', 'Tidak ada pasien yang dicentang.');
      return;
    }
    startBatch(mode, selectedPatients);
  }

  // ---- bulk "berikan tanggal pendaftaran" modal ----
  function openAssignDateModal() {
    const selectedPatients = state.patients.filter((p) => state.selected.has(p.rowNumber));
    if (!selectedPatients.length) {
      appendLog('warn', 'Centang pasien di tabel dulu sebelum memberi tanggal.');
      return;
    }
    const list = document.getElementById('assignDateList');
    list.innerHTML = '';
    for (const p of selectedPatients) {
      const row = document.createElement('div');
      row.className = 'assign-date-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.row = String(p.rowNumber);

      const label = document.createElement('span');
      label.textContent = `${p.nama} (${p.noBpjs})`;

      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      if (p.tanggalLayanan) dateInput.value = new Date(p.tanggalLayanan).toISOString().slice(0, 10);

      cb.addEventListener('change', () => {
        dateInput.disabled = !cb.checked;
      });

      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(dateInput);
      list.appendChild(row);
    }
    document.getElementById('assignSelectAll').checked = true;
    document.getElementById('assignDateModalOverlay').classList.remove('hidden');
  }

  function closeAssignDateModal() {
    document.getElementById('assignDateModalOverlay').classList.add('hidden');
  }

  async function saveAssignedDates() {
    const rows = document.querySelectorAll('#assignDateList .assign-date-row');
    let count = 0;
    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]');
      const dateInput = row.querySelector('input[type="date"]');
      if (!cb.checked || !dateInput.value) continue;

      const rowNumber = Number(cb.dataset.row);
      const patient = state.patients.find((p) => p.rowNumber === rowNumber);
      if (!patient) continue;

      const [y, m, d] = dateInput.value.split('-').map(Number);
      const dateObj = new Date(y, m - 1, d);
      PcbExcel.writeTanggalLayanan(state.sheet, state.headerRow, rowNumber, dateObj);
      PcbExcel.writeStatus(state.sheet, state.headerRow, rowNumber, 'pendaftaran', 'manual', '');
      patient.tanggalLayanan = dateObj.toISOString();
      patient.statusPendaftaran = 'manual';
      count += 1;
    }
    if (count > 0) {
      await persistSheet();
      renderPatientTable();
      appendLog('info', `${count} pasien diberi tanggal pendaftaran manual.`);
    }
    closeAssignDateModal();
  }

  // ---- per-patient Pendaftaran target-date override (before running, not written to Excel) ----
  function openOverrideDateModal() {
    const selectedPatients = state.patients.filter((p) => state.selected.has(p.rowNumber));
    if (!selectedPatients.length) {
      appendLog('warn', 'Centang pasien di tabel dulu.');
      return;
    }
    const globalBatch = document.getElementById('batchDate').value;
    const list = document.getElementById('overrideDateList');
    list.innerHTML = '';
    for (const p of selectedPatients) {
      const row = document.createElement('div');
      row.className = 'assign-date-row';

      const hasOverride = state.tanggalOverride.has(p.rowNumber);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = hasOverride;
      cb.dataset.row = String(p.rowNumber);

      const label = document.createElement('span');
      label.textContent = `${p.nama} (${p.noBpjs})`;

      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.value = hasOverride ? state.tanggalOverride.get(p.rowNumber) : globalBatch || '';
      dateInput.disabled = !cb.checked;

      cb.addEventListener('change', () => {
        dateInput.disabled = !cb.checked;
      });

      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(dateInput);
      list.appendChild(row);
    }
    document.getElementById('overrideDateModalOverlay').classList.remove('hidden');
  }

  function closeOverrideDateModal() {
    document.getElementById('overrideDateModalOverlay').classList.add('hidden');
  }

  function saveOverrideDates() {
    const rows = document.querySelectorAll('#overrideDateList .assign-date-row');
    let count = 0;
    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]');
      const dateInput = row.querySelector('input[type="date"]');
      const rowNumber = Number(cb.dataset.row);
      if (cb.checked && dateInput.value) {
        state.tanggalOverride.set(rowNumber, dateInput.value);
        count += 1;
      } else {
        state.tanggalOverride.delete(rowNumber);
      }
    }
    renderPatientTable();
    appendLog('info', `${count} pasien memakai tanggal pendaftaran berbeda dari Tanggal batch.`);
    closeOverrideDateModal();
  }

  function clearAllOverrides() {
    state.tanggalOverride.clear();
    renderPatientTable();
    appendLog('info', 'Semua override tanggal pendaftaran dihapus — semua pasien kembali memakai Tanggal batch.');
    closeOverrideDateModal();
  }

  // ---- smart recommendations ----
  /**
   * `opts.mode`: which mode to restart for kind === 'retry-failed' (the mode itself isn't
   * derivable from the patient refs alone). `opts.onDecline`: called after the user picks
   * "Nanti saja" — used to chain straight into the next relevant recommendation (e.g. after
   * declining a retry, still offer to move the patients that DID succeed on to the next
   * stage) instead of just closing and losing that opportunity.
   */
  function showRecommendation(kind, patientRefs, opts = {}) {
    const fullPatients = patientRefs
      .map((ref) => state.patients.find((p) => p.rowNumber === ref.rowNumber))
      .filter(Boolean);
    if (!fullPatients.length) {
      if (opts.onDecline) opts.onDecline();
      return;
    }

    const overlay = document.getElementById('recommendModalOverlay');
    const title = document.getElementById('recommendTitle');
    const body = document.getElementById('recommendBody');
    const list = document.getElementById('recommendPatientList');
    const yesBtn = document.getElementById('recommendYesBtn');
    list.textContent = fullPatients.map((p) => p.nama).join(', ');

    if (kind === 'retry-failed') {
      const modeLabel = { pendaftaran: 'Pendaftaran', pelayanan: 'Pelayanan' }[opts.mode] || opts.mode;
      title.textContent = `${fullPatients.length} pasien gagal di ${modeLabel}`;
      body.textContent = `Coba ulang sekarang untuk ${fullPatients.length} pasien yang gagal di alur ${modeLabel}?`;
      yesBtn.textContent = 'Ya, coba ulang';
      yesBtn.onclick = () => {
        const started = startBatch(opts.mode, fullPatients);
        if (started) overlay.classList.add('hidden');
      };
    } else if (kind === 'run-pendaftaran') {
      title.textContent = 'Sebagian pasien belum terdaftar';
      body.textContent = `${fullPatients.length} pasien gagal di alur Pelayanan karena tanggal layanan belum diketahui. Jalankan alur Pendaftaran untuk mereka sekarang (pakai Tanggal batch yang ada di bagian Alur)?`;
      yesBtn.textContent = 'Ya, jalankan Pendaftaran';
      yesBtn.onclick = () => {
        const started = startBatch('pendaftaran', fullPatients);
        if (started) overlay.classList.add('hidden');
      };
    } else if (kind === 'run-pelayanan') {
      title.textContent = 'Pendaftaran selesai';
      body.textContent = `${fullPatients.length} pasien berhasil didaftarkan (total sejauh ini, termasuk hasil percobaan ulang). Lanjut ke input Pelayanan untuk mereka sekarang?`;
      yesBtn.textContent = 'Ya, lanjut Pelayanan';
      yesBtn.onclick = () => {
        const started = startBatch('pelayanan', fullPatients);
        if (started) overlay.classList.add('hidden');
      };
    } else if (kind === 'run-print') {
      title.textContent = 'Pelayanan selesai';
      body.textContent = `${fullPatients.length} pasien berhasil dilayani (total sejauh ini, termasuk hasil percobaan ulang). Lanjut ke Print SPP & FKPP untuk mereka sekarang?`;
      yesBtn.textContent = 'Ya, lanjut Print SPP & FKPP';
      yesBtn.onclick = () => {
        const started = startBatch('print', fullPatients);
        if (started) overlay.classList.add('hidden');
      };
    }

    document.getElementById('recommendNoBtn').onclick = () => {
      overlay.classList.add('hidden');
      if (opts.onDecline) opts.onDecline();
    };
    overlay.classList.remove('hidden');
  }

  /** Offers the NEXT stage (Pendaftaran -> Pelayanan -> Print) for whichever of `relevant`
   * currently show a successful status for `mode` — cumulative across however many retry
   * rounds already happened, since it reads state.patients' current status, not a per-run
   * snapshot. */
  function maybeShowNextStageRecommendation(mode, relevant) {
    const toRef = (p) => ({ rowNumber: p.rowNumber, nama: p.nama });
    if (mode === 'pendaftaran') {
      const done = relevant.filter((p) => p.statusPendaftaran === 'done' || p.statusPendaftaran === 'manual');
      if (done.length > 0) showRecommendation('run-pelayanan', done.map(toRef));
    } else if (mode === 'pelayanan') {
      const done = relevant.filter((p) => p.statusPelayanan === 'done' || p.statusPelayanan === 'manual');
      if (done.length > 0) showRecommendation('run-print', done.map(toRef));
    }
  }

  /**
   * Requested explicitly: after a Pendaftaran or Pelayanan batch finishes, proactively ask
   * to retry whatever's still failed — and keep asking after every retry round, for as long
   * as failures remain, since starting a retry runs a brand-new batch whose own completion
   * re-enters this exact same check. Once nothing's left failing (or the user declines the
   * retry), offer the cumulative successes onward to the next stage instead.
   */
  function checkRunCompletionRecommendations() {
    const mode = state.lastRunMode;
    const rowNumbers = state.lastRunRowNumbers;
    if (!mode || !rowNumbers.length) return;
    const relevant = state.patients.filter((p) => rowNumbers.includes(p.rowNumber));

    if (mode === 'pendaftaran' || mode === 'pelayanan') {
      const statusFor = (p) => (mode === 'pendaftaran' ? p.statusPendaftaran : p.statusPelayanan);
      const failed = relevant.filter((p) => statusFor(p) === 'error');
      if (failed.length > 0) {
        showRecommendation(
          'retry-failed',
          failed.map((p) => ({ rowNumber: p.rowNumber, nama: p.nama })),
          { mode, onDecline: () => maybeShowNextStageRecommendation(mode, relevant) }
        );
        return;
      }
    }
    maybeShowNextStageRecommendation(mode, relevant);
  }

  async function handlePortMessage(msg) {
    if (msg.evt === 'log') {
      appendLog(msg.level, msg.message, msg.lineId);
    } else if (msg.evt === 'runStatus') {
      setRunButtons(msg.status);
      // Only on a clean finish — not 'stopped' (user explicitly asked to stop, don't nag)
      // or 'error' (something broke outside normal per-patient handling). By this point
      // every patientUpdate for the run has already landed (same ordered port), so
      // state.patients reflects this run's true final outcome.
      if (msg.status === 'done') checkRunCompletionRecommendations();
    } else if (msg.evt === 'patientUpdate') {
      const patient = state.patients.find((p) => p.rowNumber === msg.rowNumber);
      if (!patient) return;
      if (msg.tanggalLayanan) {
        PcbExcel.writeTanggalLayanan(state.sheet, state.headerRow, msg.rowNumber, new Date(msg.tanggalLayanan));
        patient.tanggalLayanan = msg.tanggalLayanan;
      }
      // 'print' isn't a real Excel status column (writeStatus only knows Pendaftaran/
      // Pelayanan) — writing it would silently corrupt the Pelayanan status/message cells.
      // Printing has no persisted per-patient state yet; the log panel is the record of it.
      if (msg.stage === 'pendaftaran' || msg.stage === 'pelayanan') {
        PcbExcel.writeStatus(state.sheet, state.headerRow, msg.rowNumber, msg.stage, msg.status, msg.message || '');
        if (msg.stage === 'pendaftaran') patient.statusPendaftaran = msg.status;
        else patient.statusPelayanan = msg.status;
        await persistSheet();
      }
      renderPatientTable();
    } else if (msg.evt === 'recommendation') {
      showRecommendation(msg.kind, msg.patients);
    } else if (msg.evt === 'vitalsSnapshot') {
      showVitalsSnapshot(msg.data);
    } else if (msg.evt === 'vitalsSnapshotError') {
      appendLog('error', `Gagal mengambil data kunjungan: ${msg.message}`);
    }
  }

  // ---- on-demand "Ambil Data Kunjungan Sebelumnya" ----
  function addVitalsRow(container, label, value) {
    const row = document.createElement('p');
    const b = document.createElement('b');
    b.textContent = `${label}: `;
    row.appendChild(b);
    row.appendChild(document.createTextNode(value === null || value === undefined || value === '' ? '-' : String(value)));
    container.appendChild(row);
  }

  function showVitalsSnapshot(data) {
    const body = document.getElementById('vitalsModalBody');
    body.innerHTML = '';
    const v = data.vitals || {};
    addVitalsRow(body, 'Faskes Pelayanan', data.faskesPelayanan);
    addVitalsRow(body, 'Tanggal Kunjungan', data.tanggalKunjungan);
    addVitalsRow(body, 'Keluhan', data.keluhan);
    addVitalsRow(body, 'Anamnesa', data.anamnesa);
    addVitalsRow(body, 'Diagnosa', data.diagnosa);
    body.appendChild(document.createElement('hr'));
    addVitalsRow(body, 'Suhu (°C)', v.suhu);
    addVitalsRow(body, 'Tinggi Badan (cm)', v.tinggiBadan);
    addVitalsRow(body, 'Berat Badan (kg)', v.beratBadan);
    addVitalsRow(body, 'Lingkar Perut (cm)', v.lingkarPerut);
    addVitalsRow(body, 'Sistole/Diastole (mmHg)', v.sistole != null || v.diastole != null ? `${v.sistole ?? '-'}/${v.diastole ?? '-'}` : null);
    addVitalsRow(body, 'Respiratory Rate', v.respiratoryRate);
    addVitalsRow(body, 'Heart Rate', v.heartRate);
    if (data.pageErrors?.length) {
      body.appendChild(document.createElement('hr'));
      addVitalsRow(body, 'Error JS halaman', data.pageErrors.join(' | '));
    }
    document.getElementById('vitalsModalOverlay').classList.remove('hidden');
    appendLog('info', 'Data kunjungan berhasil diambil dari halaman saat ini.');
  }

  // ---- wiring ----
  document.getElementById('connectPrinterChk').addEventListener('change', (e) => {
    document.getElementById('printPrinterName').disabled = !e.target.checked;
  });
  document.getElementById('pickExcelBtn').addEventListener('click', pickExcelFile);
  document.getElementById('reconnectFileBtn').addEventListener('click', reconnectLastFile);
  document.getElementById('sheetSelect').addEventListener('change', (e) => loadSheet(e.target.value));
  document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener('change', onModeChange));
  document.getElementById('selectAll').addEventListener('change', (e) => {
    if (e.target.checked) state.patients.forEach((p) => state.selected.add(p.rowNumber));
    else state.selected.clear();
    renderPatientTable();
  });
  document.getElementById('thStatusDaftar').addEventListener('click', () => toggleAllStatus('pendaftaran'));
  document.getElementById('thStatusLayanan').addEventListener('click', () => toggleAllStatus('pelayanan'));
  document.getElementById('startBtn').addEventListener('click', startRun);
  document.getElementById('pauseBtn').addEventListener('click', () => sendToBackground({ cmd: 'PAUSE' }));
  document.getElementById('resumeBtn').addEventListener('click', () => sendToBackground({ cmd: 'RESUME' }));
  document.getElementById('stopBtn').addEventListener('click', () => sendToBackground({ cmd: 'STOP' }));
  document.getElementById('loginSettingsBtn').addEventListener('click', openLoginModal);
  document.getElementById('closeCredsBtn').addEventListener('click', closeLoginModal);
  document.getElementById('saveCredsBtn').addEventListener('click', saveCredentials);
  document.getElementById('clearCredsBtn').addEventListener('click', clearCredentials);
  document.getElementById('assignDateBtn').addEventListener('click', openAssignDateModal);
  document.getElementById('assignDateCloseBtn').addEventListener('click', closeAssignDateModal);
  document.getElementById('assignDateSaveBtn').addEventListener('click', saveAssignedDates);
  document.getElementById('assignSelectAll').addEventListener('change', (e) => {
    document.querySelectorAll('#assignDateList .assign-date-row').forEach((row) => {
      const cb = row.querySelector('input[type="checkbox"]');
      const dateInput = row.querySelector('input[type="date"]');
      cb.checked = e.target.checked;
      dateInput.disabled = !cb.checked;
    });
  });
  document.getElementById('overrideDateBtn').addEventListener('click', openOverrideDateModal);
  document.getElementById('overrideDateCloseBtn').addEventListener('click', closeOverrideDateModal);
  document.getElementById('overrideDateSaveBtn').addEventListener('click', saveOverrideDates);
  document.getElementById('overrideDateClearBtn').addEventListener('click', clearAllOverrides);
  document.getElementById('assignDateBulkApplyBtn').addEventListener('click', () => {
    const val = document.getElementById('assignDateBulkValue').value;
    if (!val) return;
    document.querySelectorAll('#assignDateList .assign-date-row').forEach((row) => {
      const cb = row.querySelector('input[type="checkbox"]');
      const dateInput = row.querySelector('input[type="date"]');
      if (cb.checked) dateInput.value = val;
    });
  });

  document.getElementById('ambilDataKunjunganBtn').addEventListener('click', () => {
    appendLog('info', 'Mengambil data kunjungan dari halaman PCare saat ini...');
    sendToBackground({ cmd: 'READ_VITALS_NOW' });
  });
  document.getElementById('vitalsModalCloseBtn').addEventListener('click', () => {
    document.getElementById('vitalsModalOverlay').classList.add('hidden');
  });

  // Ikon kursor bot di halaman PCare (bukan kursor mouse asli pengguna — lihat
  // moveFakeCursorTo() di content/domHelpers.js) — dibaca langsung oleh content script
  // dari chrome.storage.local, jadi cukup simpan di sini, tidak perlu dikirim lewat port.
  const cursorIconSelect = document.getElementById('cursorIconSelect');
  const cursorIconPreview = document.getElementById('cursorIconPreview');
  const updateCursorPreview = () => {
    cursorIconPreview.src = chrome.runtime.getURL(`icons/${cursorIconSelect.value}`);
  };
  chrome.storage.local.get(['cursorIcon'], (res) => {
    if (res && res.cursorIcon) cursorIconSelect.value = res.cursorIcon;
    updateCursorPreview();
  });
  cursorIconSelect.addEventListener('change', () => {
    chrome.storage.local.set({ cursorIcon: cursorIconSelect.value });
    updateCursorPreview();
  });

  connectPort();
  populateTenagaMedisSelect();
  setRunButtons('idle');
  tryRestoreLastFile();
})();
