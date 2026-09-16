# PCare Bot — Ekstensi Chrome

**Penulis:** Ahda Firly Barori

Otomasi input data pasien Prolanis/PRB ke P-Care, berjalan **langsung di dalam Chrome Anda
sendiri** — bukan browser terpisah yang dikendalikan dari luar. Ini menggantikan pendekatan
Electron+Playwright sebelumnya, yang bermasalah saat memakai profil Chrome asli (tab kosong
tak bisa diarahkan, konflik profil sedang dipakai, dsb). Dengan ekstensi, tidak ada proses
browser kedua sama sekali — bot benar-benar mengetik dan mengklik di tab yang Anda lihat.

Dibuat khusus untuk LABKESDA Sumenep, tapi strukturnya cukup umum untuk faskes lain yang
memakai P-Care dengan penyesuaian.

## Tiga alur yang terpisah

1. **Pendaftaran** — mendaftarkan pasien Prolanis/PRB via Rujukan di halaman
   `EntriDaftarDokkel`.
2. **Pelayanan** — mengisi form Kunjungan & hasil lab Non Kapitasi di halaman
   `EntriKunjunganDokkel`.
3. **Print SPP & FKPP** — mencetak/menyimpan dokumen kunjungan yang sudah dilayani.

Sengaja dipisah tiga: tiap alur lebih sederhana dan lebih gampang dilacak kalau ada yang
gagal, dibanding satu alur besar yang mengerjakan semuanya sekaligus.

## Cara kerja singkat

- **`background.js`** (service worker): satu-satunya bagian yang tahu urutan halaman mana
  ke halaman mana. Setiap kali tab berpindah URL, content script lama "mati" dan yang baru
  otomatis dimuat — jadi semua logika alur multi-halaman (Login → Pendaftaran → Pelayanan)
  hidup di sini, bukan di content script.
- **`content/*.js`**: berjalan di dalam halaman PCare, isi form / klik tombol / baca tabel
  langsung lewat DOM asli (bukan lewat CDP seperti Playwright). Setiap klik yang bot lakukan
  adalah klik sungguhan yang dilihat browser sebagai klik pengguna.
- **`sidepanel/`**: panel di sisi jendela Chrome (bukan jendela Electron terpisah) — tempat
  pilih file Excel, atur alur, centang pasien mana yang diproses, lihat log, dan
  start/pause/resume/stop. Panel inilah yang membaca & menulis file Excel langsung (lewat
  File System Access API), sehingga status per-pasien tetap tersimpan di file Excel itu
  sendiri — bisa lanjut di komputer lain seperti sebelumnya.
- **`native-host/`** (folder terpisah, TIDAK ada di repo ini — lihat bagian Instalasi):
  program kecil opsional di luar Chrome yang HANYA menangani dua hal yang tidak bisa
  dilakukan ekstensi murni: mencetak PDF ke printer, dan (sebagai cadangan langka) klik OS
  asli untuk satu-dua widget yang terbukti tidak selalu merespons klik dari skrip (kalender
  tanggal). Lihat bagian "Yang berbeda" di bawah untuk soal kursor.

## Instalasi (sekali saja per komputer)

1. **Muat ekstensi di Chrome**:
   - Buka `chrome://extensions`
   - Aktifkan "Developer mode" (kanan atas)
   - Klik "Load unpacked", pilih folder hasil clone/download repo ini
   - Klik ikon ekstensi di toolbar untuk membuka panel sisi (side panel)

2. **Atur login**: di panel, klik tombol "⚙ Login", isi username/password PCare, simpan.

3. **Pilih Excel**, pilih alur (Pendaftaran / Pelayanan / Print SPP & FKPP), centang pasien
   yang mau diproses, klik Mulai.

4. *(Opsional)* **Native host** — hanya perlu kalau ingin cetak otomatis ke printer fisik
   (tanpa ini, cetak tetap jalan tapi hasilnya hanya tersimpan sebagai PDF di Downloads).
   Kodenya ada terpisah, tidak termasuk di repo ini karena berisi kunci privat khusus
   instalasi (`ext-key.pem`) yang tidak boleh dibagikan. Kalau dibutuhkan, buat ulang sesuai
   `background.js`/`content/domHelpers.js` (cari `NATIVE_HOST_NAME`,
   `chrome.runtime.connectNative`) — protokolnya native messaging standar Chrome
   (`cmd: 'click'`, `'pressEnter'`, `'print'`, `'listPrinters'`, lihat komentar di kode).

## Yang berbeda dari versi Electron sebelumnya

- Tidak perlu menutup Chrome Anda — bot memakai tab baru di jendela Chrome yang sedang
  terbuka, bukan proses browser terpisah.
- Cloudflare Turnstile tetap tidak pernah dicoba diselesaikan otomatis — bot menunggu token
  aslinya muncul (`input[name="cf-turnstile-response"]`), dan kalau muncul tantangan
  interaktif, Anda yang klik langsung di tab yang sama.
- Kursor yang terlihat bergerak sebelum tiap klik adalah ikon gambar milik ekstensi ini
  sendiri (lihat dropdown "Kursor bot" di panel) — bukan kursor mouse OS Anda. Klik OS asli
  hanya dipakai sebagai cadangan terakhir untuk satu-dua widget yang terbukti tidak selalu
  merespons klik dari skrip, dan itu pun perlu native host opsional (lihat Instalasi #4).
- Cetak SPP & FKPP kini alur terpisah (bukan otomatis nempel di akhir alur Pelayanan): PCare
  selalu membuka PDF di tab baru; bot menyimpannya otomatis ke `Downloads/PCareBot_SPP/` dan
  `Downloads/PCareBot_FKPP/`, dan hanya mengirim ke printer kalau Anda mencentang "Hubungkan
  ke printer" di panel DAN native host terpasang.

## Yang BELUM diverifikasi live (bawaan dari versi sebelumnya, belum berubah)

- Opsi dropdown "Gula Darah Puasa" dan "HbA1c" (`shared/pcareData.js`) — teks pastinya di
  dropdown PCare belum dikonfirmasi untuk pasien DM. Cocokkan saat pasien DM pertama
  diproses, perbaiki di `shared/pcareData.js` kalau beda.
- Selector dropdown generik (Riwayat Alergi, Prognosa, Status Pulang, Jenis Pelayanan)
  memakai pencarian "elemen pertama setelah teks label" — cukup rapuh kalau PCare mengubah
  markup. Kalau ada langkah yang tiba-tiba gagal menemukan elemen, ini kandidat pertama yang
  perlu dicek manual di DevTools.

## Batasan yang disengaja

- Bot tidak pernah mencoba menyelesaikan Cloudflare Turnstile sendiri.
- Bot tidak pernah mengklik/mengubah apa pun yang tidak diminta secara eksplisit dalam alur
  Pendaftaran/Pelayanan/Print SPP & FKPP.
- Kredensial disimpan di `chrome.storage.local` milik ekstensi ini — dilindungi Chrome pada
  level sistem operasi seperti data ekstensi lain, tapi bukan enkripsi tambahan di atas itu.
