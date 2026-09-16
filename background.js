// Background service worker: the ONLY place that knows how to move between PCare pages.
// Content scripts die on every navigation, so all sequencing (which page comes next, when
// login redirected successfully, when to move to the next patient) lives here. The side
// panel (sidepanel/sidepanel.js) is the GUI + owns the Excel file; it drives this via a
// long-lived port named "pcb".
const URLS = {
  LOGIN: 'https://pcarejkn.bpjs-kesehatan.go.id/eclaim/login',
  PENDAFTARAN: 'https://pcarejkn.bpjs-kesehatan.go.id/eclaim/EntriDaftarDokkel',
  PELAYANAN: 'https://pcarejkn.bpjs-kesehatan.go.id/eclaim/EntriKunjunganDokkel',
};

const NATIVE_HOST_NAME = 'com.labkesda.pcarebot_host';

const panels = new Set();
let currentRun = null; // { tabId, paused, stopped, generation }
let runGeneration = 0;
let nativePort = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a "YYYY-MM-DD" (from <input type="date">) as a LOCAL date, never via the UTC-based `new Date(string)` parse (which can shift the calendar day depending on timezone). */
function parseLocalDateInput(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Parses a "DD-MM-YYYY" (PCare's own on-page date format) as a LOCAL date. */
function parseDdMmYyyy(ddMmYyyy) {
  const [d, m, y] = ddMmYyyy.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function broadcast(msg) {
  for (const port of panels) {
    try {
      port.postMessage(msg);
    } catch (_) {
      panels.delete(port);
    }
  }
}

function log(level, message) {
  broadcast({ evt: 'log', level, message });
}

function postPatientUpdate(update) {
  broadcast({ evt: 'patientUpdate', ...update });
}

function postStatus(status) {
  broadcast({ evt: 'runStatus', status });
}

function currentStatusFor(run) {
  if (!run) return 'idle';
  return run.paused ? 'paused' : 'running';
}

/** Thrown internally when a run was stopped mid-flight — caught and treated as a clean
 * stop, never logged/recorded as a per-patient error (see checkStopRequested + its call
 * sites, and the catch block in processBatch's per-patient loop). */
class StopRequested extends Error {}

/** Checked between major steps (page navigations) of a single patient's processing, not
 * just between patients — so clicking Stop takes effect within seconds instead of having
 * to wait out an entire multi-page registration flow for the patient currently in progress. */
function checkStopRequested(myGeneration) {
  if (!currentRun || currentRun.generation !== myGeneration || currentRun.stopped) {
    throw new StopRequested();
  }
}

/**
 * Logs "Langkah Selanjutnya: <label> - dimulai dalam Ns detik" with a live countdown (the
 * same log line updates in place each second, via `lineId`) before a step actually starts —
 * per the user's request to always see what's about to happen and when.
 */
async function announceStep(label, seconds = 2) {
  const lineId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  for (let s = seconds; s >= 1; s -= 1) {
    broadcast({ evt: 'log', level: 'info', message: `Langkah Selanjutnya: ${label} — dimulai dalam ${s} detik`, lineId });
    await sleep(1000);
  }
  broadcast({ evt: 'log', level: 'info', message: `Langkah: ${label}`, lineId });
}

// ---- native host (printer + real OS cursor) — best-effort, never blocks automation ----

let nativeAckQueue = []; // host.js answers strictly one-at-a-time, in order (see its main() loop)

function getNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener((msg) => {
      const resolve = nativeAckQueue.shift();
      if (resolve) resolve(msg);
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      nativeAckQueue.forEach((resolve) => resolve(null));
      nativeAckQueue = [];
    });
    return nativePort;
  } catch (_) {
    return null;
  }
}

function nativeSend(msg) {
  const port = getNativePort();
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (_) {
    nativePort = null;
    return false;
  }
}

/** Like nativeSend, but waits for host.js's response (e.g. to confirm a real click actually happened). */
function nativeSendAwait(msg, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const port = getNativePort();
    if (!port) {
      resolve(null);
      return;
    }
    let settled = false;
    nativeAckQueue.push((res) => {
      settled = true;
      resolve(res);
    });
    try {
      port.postMessage(msg);
    } catch (_) {
      nativePort = null;
      settled = true;
      resolve(null);
      return;
    }
    setTimeout(() => {
      if (!settled) resolve(null);
    }, timeoutMs);
  });
}

// ---- tab navigation + content-script messaging ----

function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout menunggu halaman selesai dimuat.'));
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitUrlLeaves(tabId, substring, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && !tab.url.toLowerCase().includes(substring)) return tab.url;
    await sleep(400);
  }
  throw new Error('Login gagal: halaman tidak berpindah dari /login setelah submit.');
}

/** Sends one action to the content script, retrying briefly if it hasn't attached yet after a navigation. */
async function callTabWithRetry(tabId, action, payload, attachTimeoutMs = 15000) {
  const deadline = Date.now() + attachTimeoutMs;
  for (;;) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { target: 'content', action, payload });
      if (!res) throw new Error('Tidak ada respons dari content script (tab mungkin dinavigasi ulang).');
      if (!res.ok) {
        if (res.stopped) throw new StopRequested();
        throw new Error(res.error || 'Aksi gagal tanpa pesan error.');
      }
      return res.result;
    } catch (err) {
      const msg = String(err?.message || err);
      const notReadyYet = /Receiving end does not exist|Could not establish connection/i.test(msg);
      if (notReadyYet && Date.now() < deadline) {
        await sleep(300);
        continue;
      }
      throw err;
    }
  }
}

async function navigateAndCall(tabId, url, action, payload) {
  await chrome.tabs.update(tabId, { url });
  await waitTabComplete(tabId);
  await sleep(400 + Math.random() * 400); // let the content script attach & the page visually settle
  return callTabWithRetry(tabId, action, payload);
}

// ---- tab discovery ----

/** Reuses an already-open PCare tab if one exists, instead of always opening a new one. */
async function findOrCreateWorkingTab() {
  const existing = await chrome.tabs.query({ url: 'https://pcarejkn.bpjs-kesehatan.go.id/*' });
  if (existing.length > 0) {
    const tab = existing[0];
    log('info', `Tab PCare yang sudah terbuka ditemukan — melanjutkan di tab itu (bukan membuka tab baru).`);
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  return tab.id;
}

/** Used by the panel's on-demand "Ambil Data Kunjungan Sebelumnya" button — finds an
 * ALREADY-open PCare tab (never creates one; the human is expected to be looking at a
 * riwayat row they just clicked themselves) and asks its content script for a snapshot of
 * whatever the Kunjungan panel currently shows. */
async function readVitalsNow() {
  const existing = await chrome.tabs.query({ url: 'https://pcarejkn.bpjs-kesehatan.go.id/*' });
  if (existing.length === 0) {
    throw new Error('Tidak ada tab PCare yang terbuka.');
  }
  return callTabWithRetry(existing[0].id, 'PELAYANAN_READ_CURRENT_VITALS', {}, 5000);
}

// ---- login ----

async function doLogin(tabId, credentials) {
  await announceStep('Login ke PCare');
  await chrome.tabs.update(tabId, { url: URLS.LOGIN });
  await waitTabComplete(tabId);
  await sleep(500);
  try {
    await callTabWithRetry(tabId, 'LOGIN_FILL_AND_SUBMIT', credentials);
  } catch (err) {
    // Clicking "Sign In" triggers an immediate page navigation, which can tear down the
    // content script's own JS context before it manages to call sendResponse — Chrome
    // reports that exact race as "message channel closed before a response was
    // received"/"message port closed". That's actually a GOOD sign here (the click fired
    // and the page moved on); real confirmation of success is the URL check right below,
    // which is independent of this message response — so don't let this specific,
    // known-benign race kill the whole run.
    const msg = String(err?.message || err);
    if (!/message (channel|port) closed/i.test(msg)) throw err;
    log(
      'warn',
      'Koneksi ke halaman terputus saat klik Sign In (kemungkinan karena halaman langsung berpindah) — melanjutkan, verifikasi lewat URL.'
    );
  }
  const finalUrl = await waitUrlLeaves(tabId, '/login', 20000);
  log('info', `Login berhasil. URL saat ini: ${finalUrl}`);
}

/**
 * If the working tab is already sitting on a logged-in PCare page (e.g. it was reused
 * from an already-open tab), tries a real page first to confirm the session is still
 * valid before bothering with credentials at all. Falls back to a normal login whenever
 * that can't be confirmed (blank tab, logged out, session expired mid-way, etc).
 */
async function ensureLoggedIn(tabId, credentials) {
  const tab = await chrome.tabs.get(tabId);
  const looksLoggedIn =
    tab.url && tab.url.includes('pcarejkn.bpjs-kesehatan.go.id') && !tab.url.toLowerCase().includes('/login');

  if (looksLoggedIn) {
    log('info', 'Tab PCare yang sudah terbuka terlihat sudah login — memeriksa apakah sesinya masih aktif...');
    await chrome.tabs.update(tabId, { url: URLS.PENDAFTARAN });
    await waitTabComplete(tabId);
    await sleep(500);
    const afterUrl = (await chrome.tabs.get(tabId)).url || '';
    if (!afterUrl.toLowerCase().includes('/login')) {
      log('info', 'Sesi login PCare masih aktif — lanjut tanpa login ulang.');
      return;
    }
    log('info', 'Sesi login sudah tidak berlaku — login ulang.');
  }

  await doLogin(tabId, credentials);
}

// ---- pendaftaran ----

// Requested explicitly: Pendaftaran never leaves EntriDaftarDokkel. An earlier version of
// this function fell back to navigating to the Pelayanan page (to check the real tanggal
// layanan via riwayat) whenever the referral search came up empty, then re-registered via
// "Baru" — that cross-page trip is exactly what hung silently one run (no log line for
// ~34s before the background connection dropped). PENDAFTARAN_CHECK_DATE/PENDAFTARAN_VIA_BARU
// (see pendaftaranFlow.js) are left in place, unused, in case a future manual/separate
// flow wants them — just not wired into this automatic chain anymore.
async function runPendaftaranForPatient(tabId, patient, batchDate, myGeneration) {
  await announceStep(`Mendaftarkan ${patient.nama} via Rujukan`);
  const rujukanResult = await navigateAndCall(tabId, URLS.PENDAFTARAN, 'PENDAFTARAN_VIA_RUJUKAN', {
    patient,
    targetDate: batchDate,
  });
  checkStopRequested(myGeneration);

  if (!rujukanResult.found) {
    // No horizontal referral record for this BPJS number — a real failure for this
    // patient, reported the same way as any other (see processBatch's catch block), not
    // silently retried via a different page/flow.
    throw new Error(rujukanResult.reason || 'Rujukan tidak ditemukan untuk pasien ini.');
  }

  // viaRujukan follows the referral's OWN visit date when it differs from what we assumed
  // (confirmed real behavior: PCare only registers against that specific referral's real
  // Tgl.Kunjungan) — that's the true tanggalLayanan to record and use downstream.
  return rujukanResult.tanggalLayanan ? parseDdMmYyyy(rujukanResult.tanggalLayanan) : batchDate;
}

// ---- pelayanan ----
// Cetak FKPP/SPP is deliberately NOT part of this flow — requested explicitly:
// registration (Pendaftaran), service entry (Pelayanan), and printing are three
// independent jobs, each simpler and less bug-prone on its own. Printing lives in its own
// mode below (see runCetakForPatient), driven separately from the panel.
async function runPelayananForPatient(tabId, patient, tenagaMedis, myGeneration) {
  await announceStep(`Mengisi form Pelayanan & Kunjungan untuk ${patient.nama}`);
  await navigateAndCall(tabId, URLS.PELAYANAN, 'PELAYANAN_RUN', {
    patient,
    tanggalLayanan: patient.tanggalLayanan,
    tenagaMedis,
  });
  checkStopRequested(myGeneration);
}

// ---- cetak SPP & FKPP ----

/** Waits for the new tab PCare opens when a print button (SPP/FKPP) is clicked, as a child of `openerTabId`. */
function waitForChildTab(openerTabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onCreated.removeListener(listener);
      reject(new Error('Tab PDF tidak terbuka dalam waktu yang diharapkan.'));
    }, timeoutMs);
    function listener(tab) {
      if (tab.openerTabId === openerTabId) {
        clearTimeout(timer);
        chrome.tabs.onCreated.removeListener(listener);
        resolve(tab);
      }
    }
    chrome.tabs.onCreated.addListener(listener);
  });
}

/**
 * Saves the PDF tab a print click opened to Downloads, and — only if the user chose to
 * connect a printer — ALSO sends it to the native host for a silent print. The PDF is
 * always saved regardless of the printer choice: per the user's request, "not connected to
 * a printer" means fall back to a PDF, not skip the document entirely.
 */
async function saveOrPrintTab(tabId, patient, kind, printerName) {
  const pdfTab = await waitForChildTab(tabId).catch((err) => {
    log('warn', `${patient.nama}: ${err.message} — periksa manual apakah ${kind} tercetak/tersimpan.`);
    return null;
  });
  if (!pdfTab) return;

  await waitTabComplete(pdfTab.id, 15000).catch(() => {});
  const finalTab = await chrome.tabs.get(pdfTab.id).catch(() => pdfTab);
  const safeName = patient.nama.replace(/[^a-z0-9]+/gi, '_');
  const filename = `PCareBot_${kind}/${kind}_${safeName}_${patient.noBpjs}.pdf`;

  await new Promise((resolve) => {
    chrome.downloads.download({ url: finalTab.url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        log('error', `${patient.nama}: gagal menyimpan PDF ${kind} (${chrome.runtime.lastError?.message || 'unknown'}).`);
        resolve();
        return;
      }
      log('info', `${patient.nama}: ${kind} disimpan ke Downloads/${filename}.`);
      if (printerName) {
        const searchDeadline = Date.now() + 8000;
        const trySend = () => {
          chrome.downloads.search({ id: downloadId }, (items) => {
            const item = items && items[0];
            if (item && item.state === 'complete' && item.filename) {
              const sent = nativeSend({ cmd: 'print', path: item.filename, printer: printerName });
              if (sent) log('info', `${patient.nama}: ${kind} dikirim ke printer "${printerName}".`);
              else log('warn', `${patient.nama}: native host cetak tidak tersedia — ${kind} hanya tersimpan sebagai PDF.`);
            } else if (Date.now() < searchDeadline) {
              setTimeout(trySend, 400);
            } else {
              log('warn', `${patient.nama}: tidak dapat memastikan file PDF ${kind} selesai disimpan untuk dicetak.`);
            }
          });
        };
        trySend();
      }
      resolve();
    });
  });

  await chrome.tabs.remove(pdfTab.id).catch(() => {});
}

async function runCetakForPatient(tabId, patient, printerName, myGeneration) {
  await announceStep(`Mencari kunjungan LABKESDA untuk ${patient.nama}`);
  await navigateAndCall(tabId, URLS.PELAYANAN, 'CETAK_SEARCH_AND_OPEN', {
    patient,
    tanggalLayanan: patient.tanggalLayanan,
  });
  checkStopRequested(myGeneration);

  await announceStep(`Mencetak SPP untuk ${patient.nama}`);
  await callTabWithRetry(tabId, 'CETAK_CLICK_SPP', {});
  await saveOrPrintTab(tabId, patient, 'SPP', printerName);
  checkStopRequested(myGeneration);

  await announceStep(`Mencetak FKPP untuk ${patient.nama}`);
  await callTabWithRetry(tabId, 'CETAK_CLICK_FKPP', {});
  await saveOrPrintTab(tabId, patient, 'FKPP', printerName);
  checkStopRequested(myGeneration);
}

// ---- batch orchestration ----

async function waitWhilePaused() {
  while (currentRun && currentRun.paused) await sleep(400);
}

async function processBatch(payload, myGeneration) {
  const { patients, mode, batchDate, tenagaMedis, printerName } = payload;

  const stored = await chrome.storage.local.get(['pcbCredentials']);
  const credentials = stored.pcbCredentials;
  if (!credentials || !credentials.username || !credentials.password) {
    log('error', 'Kredensial PCare belum diatur. Buka pengaturan login di panel dulu.');
    if (currentRun && currentRun.generation === myGeneration) currentRun = null;
    postStatus('error');
    return;
  }

  // currentRun was already claimed SYNCHRONOUSLY by the caller (see the 'START' handler
  // below) before this function's first `await` — otherwise a second "Mulai" click (or
  // any other event) arriving while chrome.storage/chrome.tabs calls are still in flight
  // could slip past the "is a run active?" check and launch a second, conflicting batch
  // fighting over the same tab.
  const tabId = await findOrCreateWorkingTab();
  if (!currentRun || currentRun.generation !== myGeneration) return; // cancelled while the tab was opening
  currentRun.tabId = tabId;

  // If the working tab gets closed mid-run (by the user, or by accident), there's
  // otherwise nothing that notices — chrome.tabs.onUpdated/sendMessage calls waiting on
  // that tab either hang until their own timeout or reject slowly, leaving `currentRun`
  // set and every future "Mulai" click stuck answering "Proses sudah berjalan." forever.
  // Reacting to onRemoved immediately fixes that regardless of what the stalled promise
  // chain below eventually does.
  const onWorkingTabRemoved = (removedTabId) => {
    if (removedTabId !== tabId) return;
    if (!currentRun || currentRun.generation !== myGeneration) return;
    log('error', 'Tab kerja bot ditutup di tengah proses — proses dihentikan.');
    currentRun = null;
    postStatus('error');
  };
  chrome.tabs.onRemoved.addListener(onWorkingTabRemoved);

  const needsPendaftaran = [];

  try {
    await ensureLoggedIn(tabId, credentials);

    for (const patient of patients) {
      await waitWhilePaused();
      if (!currentRun || currentRun.generation !== myGeneration || currentRun.stopped) break;

      try {
        if (mode === 'pendaftaran') {
          // Per-patient override (set in the panel via "Beda tanggal untuk pasien
          // tertentu") wins over the single global batch date for whichever patients
          // have one — see sidepanel.js's startBatch().
          const targetDate = patient.batchDateOverride
            ? parseLocalDateInput(patient.batchDateOverride)
            : parseLocalDateInput(batchDate);
          if (patient.batchDateOverride) {
            log('info', `${patient.nama}: memakai tanggal pendaftaran ${patient.batchDateOverride} (override, bukan tanggal batch).`);
          }
          const tanggalLayanan = await runPendaftaranForPatient(tabId, patient, targetDate, myGeneration);
          postPatientUpdate({
            rowNumber: patient.rowNumber,
            stage: 'pendaftaran',
            status: 'done',
            tanggalLayanan: tanggalLayanan.toISOString(),
          });
        } else if (mode === 'print') {
          await runCetakForPatient(tabId, patient, printerName, myGeneration);
          postPatientUpdate({ rowNumber: patient.rowNumber, stage: 'print', status: 'done' });
        } else {
          await runPelayananForPatient(tabId, patient, tenagaMedis, myGeneration);
          postPatientUpdate({ rowNumber: patient.rowNumber, stage: 'pelayanan', status: 'done' });
        }
      } catch (err) {
        if (err instanceof StopRequested) break; // clean stop mid-patient — not a failure, don't record one
        const message = err?.message || String(err);
        log('error', `${patient.nama}: ${message}`);
        postPatientUpdate({ rowNumber: patient.rowNumber, stage: mode, status: 'error', message });
        // This specific message (see content/pelayananFlow.js's run()) means the patient
        // simply hasn't been registered for a known date yet — not a real failure, just a
        // missing prerequisite the Pendaftaran flow itself knows how to resolve safely
        // (it checks for an existing registration before creating a new one).
        if ((mode === 'pelayanan' || mode === 'print') && message.includes('TANGGAL_LAYANAN belum ada')) {
          needsPendaftaran.push(patient);
        }
      }
    }

    // If onRemoved already fired (tab closed mid-loop), currentRun is gone and that
    // handler already posted 'error' — don't overwrite it with a stale 'done'/'stopped'.
    if (currentRun && currentRun.generation === myGeneration) {
      const finalStatus = currentRun.stopped ? 'stopped' : 'done';
      postStatus(finalStatus);

      if (finalStatus === 'done') {
        if ((mode === 'pelayanan' || mode === 'print') && needsPendaftaran.length > 0) {
          broadcast({
            evt: 'recommendation',
            kind: 'run-pendaftaran',
            patients: needsPendaftaran.map((p) => ({ rowNumber: p.rowNumber, nama: p.nama })),
          });
        }
        // The "move successes on to the next stage" and "retry what's still failing"
        // recommendations are now computed client-side in sidepanel.js's
        // checkRunCompletionRecommendations(), triggered by the postStatus('done') call
        // above — it reads state.patients' CURRENT (cumulative-across-retries) status
        // instead of this single run's local `succeeded` list, which is what makes "20
        // total, 10 fail, retry, now 15 succeeded" recommend the true running total of 15,
        // not just whatever succeeded in the very last round.
      }
    }
  } catch (err) {
    if (currentRun && currentRun.generation === myGeneration) {
      log('error', err?.message || String(err));
      postStatus('error');
    }
  } finally {
    chrome.tabs.onRemoved.removeListener(onWorkingTabRemoved);
    if (currentRun && currentRun.generation === myGeneration) currentRun = null;
  }
}

// ---- messaging endpoints ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pcb') return;
  panels.add(port);
  // A panel can (re)connect while a run from an earlier connection is still going (e.g.
  // the side panel was closed/reopened, or its old port died — see sidepanel.js's
  // reconnect logic). Without this it silently shows "idle" while a run is actually live.
  if (currentRun) {
    port.postMessage({ evt: 'runStatus', status: currentRun.stopped ? 'stopped' : currentRun.paused ? 'paused' : 'running' });
  }
  port.onMessage.addListener((msg) => {
    if (msg.cmd === 'START') {
      if (currentRun) {
        log('warn', 'Proses sudah berjalan.');
        return;
      }
      // Claim the run SYNCHRONOUSLY, before processBatch's first `await` — otherwise a
      // second 'START' arriving while credentials/tab lookup are still in flight would
      // see `currentRun` still null and slip past this same check, launching a second,
      // conflicting batch on top of the first.
      const myGeneration = ++runGeneration;
      currentRun = { tabId: null, paused: false, stopped: false, generation: myGeneration };
      postStatus('running');
      processBatch(msg.payload, myGeneration).catch((err) => {
        if (currentRun && currentRun.generation === myGeneration) {
          log('error', `Gagal memulai proses: ${err?.message || err}`);
          currentRun = null;
          postStatus('error');
        }
      });
    } else if (msg.cmd === 'PAUSE') {
      if (currentRun) {
        currentRun.paused = true;
        postStatus('paused');
      }
    } else if (msg.cmd === 'RESUME') {
      if (currentRun) {
        currentRun.paused = false;
        postStatus('running');
      }
    } else if (msg.cmd === 'STOP') {
      if (currentRun) {
        currentRun.stopped = true;
        // Fire-and-forget: wakes up the content script's poll loops (waitFor) within one
        // tick instead of only being noticed after the current step's own timeout — see
        // content/main.js's PCB_STOP listener and domHelpers.js's stopRequested flag.
        if (currentRun.tabId) {
          chrome.tabs.sendMessage(currentRun.tabId, { type: 'PCB_STOP' }, () => {
            void chrome.runtime.lastError;
          });
        }
      }
    } else if (msg.cmd === 'READ_VITALS_NOW') {
      // On-demand, independent of any run: finds whatever PCare tab is already open (the
      // human is expected to have manually clicked a riwayat row themselves) and asks it
      // for a snapshot of the Kunjungan panel's current fields — no clicking, no waiting.
      readVitalsNow()
        .then((data) => broadcast({ evt: 'vitalsSnapshot', data }))
        .catch((err) => broadcast({ evt: 'vitalsSnapshotError', message: err?.message || String(err) }));
    }
  });
  port.onDisconnect.addListener(() => panels.delete(port));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'content') return undefined; // not ours
  if (msg.type === 'PCB_REAL_CLICK') {
    nativeSendAwait({ cmd: 'click', x: msg.x, y: msg.y }).then((res) => {
      sendResponse({ ok: !!(res && res.ok) });
    });
    return true; // async response
  }
  if (msg.type === 'PCB_REAL_ENTER') {
    nativeSendAwait({ cmd: 'pressEnter', x: msg.x, y: msg.y }).then((res) => {
      sendResponse({ ok: !!(res && res.ok) });
    });
    return true; // async response
  }
  if (msg.type === 'PCB_LOG') {
    log(msg.level, msg.message);
    sendResponse({ ok: true });
    return undefined;
  }
  if (msg.type === 'PCB_CONTENT_READY') {
    sendResponse({ ok: true });
    return undefined;
  }
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
