// Message dispatcher — the only thing background.js talks to directly. Registered at
// document_idle on every pcarejkn.bpjs-kesehatan.go.id page load; a fresh instance of
// this whole content-script bundle runs after every navigation (that's expected and is
// exactly why all cross-page sequencing lives in background.js, not here).
(function () {
  const PCB = window.PCB;

  function log(level, message) {
    chrome.runtime.sendMessage({ type: 'PCB_LOG', level, message }, () => {
      void chrome.runtime.lastError;
    });
  }

  async function handleAction(action, payload) {
    PCB.dom.resetStopFlag(); // a fresh action starting now should never inherit a stop from a previous one
    // Every shared DOM helper (humanClick, humanType, waitForPaceLoading, ...) logs
    // through this one "active logger" instead of needing `log` threaded into every call
    // site across both flow files — see setActiveLogger()'s definition in domHelpers.js.
    PCB.dom.setActiveLogger(log);
    switch (action) {
      case 'PING':
        return { url: location.href, title: document.title };
      case 'LOGIN_FILL_AND_SUBMIT':
        return PCB.login.fillAndSubmit(payload, log);
      case 'PENDAFTARAN_VIA_RUJUKAN':
        return PCB.pendaftaran.viaRujukan(payload, log);
      case 'PENDAFTARAN_VIA_BARU':
        return PCB.pendaftaran.viaBaru(payload, log);
      case 'PENDAFTARAN_CHECK_DATE':
        return PCB.pendaftaran.pelayananCheckDate(payload, log);
      case 'PELAYANAN_RUN':
        return PCB.pelayanan.run(payload, log);
      case 'PELAYANAN_READ_CURRENT_VITALS':
        return PCB.pelayanan.readCurrentVitals();
      case 'CETAK_SEARCH_AND_OPEN':
        return PCB.cetak.searchAndOpen(payload, log);
      case 'CETAK_CLICK_SPP':
        return PCB.cetak.clickSpp(log);
      case 'CETAK_CLICK_FKPP':
        return PCB.cetak.clickFkpp(log);
      default:
        throw new Error(`Aksi tidak dikenal dari background: ${action}`);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return undefined;
    if (msg.type === 'PCB_STOP') {
      PCB.dom.requestStop();
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.target !== 'content') return undefined;
    handleAction(msg.action, msg.payload).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err), stopped: !!err?.pcbStopped })
    );
    return true; // keep the message channel open for the async response above
  });

  chrome.runtime.sendMessage({ type: 'PCB_CONTENT_READY', url: location.href }, () => {
    void chrome.runtime.lastError;
  });
})();
