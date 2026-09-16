// Ported from src/pcare/login.js. Runs once per page load of the login page — the
// background service worker detects the resulting redirect itself (see background.js),
// since a navigation away from /login destroys this content-script instance entirely.
(function (global) {
  const PCB = global.PCB || (global.PCB = {});
  const { humanClick, humanType, humanPause, waitFor, byPlaceholder, byRoleButton, waitForVisible } = PCB.dom;

  const TURNSTILE_SELECTOR = 'input[name="cf-turnstile-response"]';

  function turnstileTokenPresent() {
    const el = document.querySelector(TURNSTILE_SELECTOR);
    return !!(el && el.value);
  }

  /**
   * Waits for Cloudflare Turnstile to genuinely finish (its hidden response token is
   * non-empty) before we ever submit the form. Never attempts to solve it — if an
   * interactive checkbox challenge is showing, we just wait longer and let a human
   * click it in this same real tab.
   */
  async function waitForTurnstile(log) {
    const widgetExists = () => !!document.querySelector(TURNSTILE_SELECTOR);
    if (!widgetExists()) return; // no Turnstile on this load at all

    const gotTokenShort = await waitFor(() => turnstileTokenPresent(), 8000, 250);
    if (gotTokenShort) {
      log('info', 'Verifikasi Cloudflare Turnstile selesai (token terbit otomatis).');
      return;
    }

    const challengeFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (challengeFrame) {
      log(
        'warn',
        'Verifikasi keamanan (Turnstile) meminta interaksi manual. Silakan klik centang "Verify you are human" di tab ini — bot menunggu, tidak akan mencoba menyelesaikannya sendiri.'
      );
    } else {
      log('info', 'Menunggu verifikasi Cloudflare Turnstile selesai di latar belakang...');
    }

    const gotTokenLong = await waitFor(() => turnstileTokenPresent(), 120000, 500);
    if (!gotTokenLong) {
      throw new Error('Verifikasi Cloudflare Turnstile tidak selesai dalam 2 menit. Selesaikan manual lalu coba lagi.');
    }
    log('info', 'Verifikasi Cloudflare Turnstile selesai.');
  }

  /**
   * Fills credentials, waits for Turnstile, and clicks Sign In. Does NOT wait for the
   * resulting redirect — the background service worker watches this tab's URL for that,
   * since a successful login navigates away and would tear down this content script
   * mid-await anyway.
   */
  async function fillAndSubmit({ username, password }, log) {
    await humanPause(600, 1300); // a person looks at the page before touching anything

    const usernameField = await waitForVisible(() => byPlaceholder('Username'), 10000);
    const passwordField = byPlaceholder('Password');
    if (!usernameField || !passwordField) {
      throw new Error(`Form login tidak ditemukan di halaman ini (URL: ${location.href}).`);
    }

    await humanType(usernameField, username);
    await humanType(passwordField, password);

    await waitForTurnstile(log);

    const signInBtn = byRoleButton(/sign in/i);
    if (!signInBtn) throw new Error('Tombol "Sign In" tidak ditemukan.');
    await humanClick(signInBtn);

    return { submitted: true };
  }

  PCB.login = { fillAndSubmit };
})(window);
