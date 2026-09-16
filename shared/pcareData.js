// Static reference data, ported verbatim from src/pcare/labItems.js and
// src/pcare/tenagaMedisOptions.js. Loaded as a plain content-script file (no
// module.exports — browser extensions don't run these through CommonJS).
(function (global) {
  const PCB = global.PCB || (global.PCB = {});

  PCB.NON_KAPITASI_TABS = {
    'Pelayanan Kimia Darah': {
      columns: {
        ch: 'Kolesterol Total',
        tg: 'Trigliserida',
        ur: 'Ureum',
        cr: 'Kreatinin',
        hdl: 'Kolesterol HDL',
        ldl: 'Kolesterol LDL',
        micro: 'Microalbuminaria',
      },
    },
    'Pelayanan Gula Darah': {
      columns: {
        gdp: 'Gula Darah Puasa', // UNVERIFIED — confirm exact option text live
      },
    },
    'Pelayanan HbA1c': {
      columns: {
        hba1c: 'HbA1c', // UNVERIFIED — confirm exact option text live
      },
    },
  };

  PCB.nonKapitasiSelectionFor = function (dmHt) {
    if (dmHt === 'DM') return ['Pelayanan Gula Darah', 'Pelayanan Kimia Darah', 'Pelayanan HbA1c'];
    return ['Pelayanan Kimia Darah'];
  };

  PCB.TENAGA_MEDIS_GROUPS = {
    Dokter: ['dr. EKA WANDA ISTIANA MENTARI', 'dr.laos susantina'],
    'Ahli Teknologi Laboratorium Medik (ATLM)': [
      'ITSNA JAZILAH',
      'SAFIRA AYU HANDANI',
      'IDA NOVARINA',
      'ZAKIYAH LAILISSAUMI',
      'LISA MELAWATI OKTORA',
    ],
  };
  PCB.ALL_TENAGA_MEDIS = Object.values(PCB.TENAGA_MEDIS_GROUPS).flat();
})(window);
