// Browser-side port of src/excelStore.js, using SheetJS (vendor/xlsx.full.min.js) instead
// of exceljs/Node fs, and the File System Access API instead of a file path — reads/writes
// go straight back to the SAME file on disk the user picked, so status columns written
// here are exactly what makes a job resumable later, on this computer or another.
const PcbExcel = (() => {
  const TANGGAL_LAYANAN_HEADER = 'TANGGAL_LAYANAN';
  const STATUS_PENDAFTARAN_HEADER = 'STATUS_PENDAFTARAN';
  const STATUS_PELAYANAN_HEADER = 'STATUS_PELAYANAN';
  const PESAN_PENDAFTARAN_HEADER = 'PESAN_PENDAFTARAN';
  const PESAN_PELAYANAN_HEADER = 'PESAN_PELAYANAN';

  function cellAt(sheet, r, c) {
    if (c === undefined || c === null) return undefined;
    const cell = sheet[XLSX.utils.encode_cell({ r, c })];
    return cell ? cell.v : undefined;
  }

  function findHeaderRow(sheet) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    for (let r = range.s.r; r <= range.e.r; r++) {
      const a = String(cellAt(sheet, r, 0) ?? '').trim().toUpperCase();
      const b = String(cellAt(sheet, r, 1) ?? '').trim().toUpperCase();
      if (a === 'NO' && b === 'NAMA') return r;
    }
    throw new Error('Header tidak ditemukan (baris dengan kolom A="NO" dan kolom B="NAMA"). Periksa format sheet.');
  }

  function buildColumnIndex(sheet, headerRow) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const index = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const name = String(cellAt(sheet, headerRow, c) ?? '').trim().toUpperCase();
      if (name) index[name] = c;
    }
    return index;
  }

  function setCell(sheet, r, c, value) {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (value instanceof Date) {
      sheet[addr] = { t: 'd', v: value, z: 'dd-mm-yyyy' };
    } else if (typeof value === 'number') {
      sheet[addr] = { t: 'n', v: value };
    } else {
      sheet[addr] = { t: 's', v: String(value ?? '') };
    }
    const range = XLSX.utils.decode_range(sheet['!ref']);
    range.s.r = Math.min(range.s.r, r);
    range.e.r = Math.max(range.e.r, r);
    range.s.c = Math.min(range.s.c, c);
    range.e.c = Math.max(range.e.c, c);
    sheet['!ref'] = XLSX.utils.encode_range(range);
  }

  function ensureColumn(sheet, headerRow, headerName) {
    const col = buildColumnIndex(sheet, headerRow);
    let c = col[headerName.toUpperCase()];
    if (c === undefined) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      c = range.e.c + 1;
      setCell(sheet, headerRow, c, headerName);
    }
    return c;
  }

  async function loadWorkbook(fileHandle) {
    const file = await fileHandle.getFile();
    const buf = await file.arrayBuffer();
    return XLSX.read(buf, { type: 'array', cellDates: true });
  }

  async function saveWorkbook(fileHandle, workbook) {
    const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellDates: true });
    const writable = await fileHandle.createWritable();
    await writable.write(out);
    await writable.close();
  }

  function readPatients(sheet) {
    const headerRow = findHeaderRow(sheet);
    const col = buildColumnIndex(sheet, headerRow);
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const get = (r, key) => cellAt(sheet, r, col[key]);

    const patients = [];
    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const no = get(r, 'NO');
      if (typeof no !== 'number') continue;
      patients.push({
        rowNumber: r,
        no,
        nama: String(get(r, 'NAMA') ?? '').trim(),
        dmHt: String(get(r, 'DM/HT') ?? '').trim().toUpperCase(),
        noBpjs: String(get(r, 'NO.BPJS') ?? '').trim(),
        nik: get(r, 'NIK'),
        alamat: get(r, 'ALAMAT'),
        umur: get(r, 'UMUR'),
        gdp: get(r, 'GDP'),
        ch: get(r, 'CH'),
        tg: get(r, 'TG'),
        ur: get(r, 'UR'),
        cr: get(r, 'CR'),
        hdl: get(r, 'HDL'),
        ldl: get(r, 'LDL'),
        hba1c: get(r, 'HBA1C'),
        micro: get(r, 'MICRO'),
        tanggalLayanan: get(r, TANGGAL_LAYANAN_HEADER) || null,
        statusPendaftaran: String(get(r, STATUS_PENDAFTARAN_HEADER) ?? '').trim().toLowerCase(),
        statusPelayanan: String(get(r, STATUS_PELAYANAN_HEADER) ?? '').trim().toLowerCase(),
        pesanPendaftaran: get(r, PESAN_PENDAFTARAN_HEADER) ?? '',
        pesanPelayanan: get(r, PESAN_PELAYANAN_HEADER) ?? '',
      });
    }
    return { patients, headerRow };
  }

  function readBatchDate(sheet, headerRow) {
    for (let r = 0; r < headerRow; r++) {
      const v = cellAt(sheet, r, 1);
      if (v instanceof Date) return v;
    }
    return null;
  }

  function writeTanggalLayanan(sheet, headerRow, rowNumber, dateValue) {
    const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
    setCell(sheet, rowNumber, ensureColumn(sheet, headerRow, TANGGAL_LAYANAN_HEADER), d);
  }

  function writeStatus(sheet, headerRow, rowNumber, stage, status, message = '') {
    const statusHeader = stage === 'pendaftaran' ? STATUS_PENDAFTARAN_HEADER : STATUS_PELAYANAN_HEADER;
    const msgHeader = stage === 'pendaftaran' ? PESAN_PENDAFTARAN_HEADER : PESAN_PELAYANAN_HEADER;
    setCell(sheet, rowNumber, ensureColumn(sheet, headerRow, statusHeader), status);
    setCell(sheet, rowNumber, ensureColumn(sheet, headerRow, msgHeader), message);
  }

  return {
    loadWorkbook,
    saveWorkbook,
    findHeaderRow,
    readPatients,
    readBatchDate,
    writeTanggalLayanan,
    writeStatus,
  };
})();
