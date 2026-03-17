import { OmeTiffAsOmeZarrStore, TiffAsOmeZarrStore } from '../src/index.js';

/**
 * AsyncReadable that reads byte ranges from a browser File using slice().
 * The full file is never loaded — only the requested byte ranges are read.
 */
class FileSource {
  constructor(file) {
    this.file = file;
    this._getRangeCalls = [];
  }

  // Full-file get is intentionally not implemented; the store should always
  // use getRange for minimal reads.
  async get(_key) {
    return undefined;
  }

  async getRange(_key, range) {
    let offset, length;
    if ('suffixLength' in range) {
      offset = Math.max(0, this.file.size - range.suffixLength);
      length = this.file.size - offset;
    } else {
      offset = range.offset;
      length = range.length;
    }
    const safeLength = Math.min(length, this.file.size - offset);
    if (safeLength <= 0) return new Uint8Array(0);
    const blob = this.file.slice(offset, offset + safeLength);
    const ab = await blob.arrayBuffer();
    this._getRangeCalls.push({ offset, length: ab.byteLength });
    return new Uint8Array(ab);
  }

  uniqueBytesFetched() {
    if (this._getRangeCalls.length === 0) return 0;
    const intervals = this._getRangeCalls
      .map(({ offset, length }) => [offset, offset + length])
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [curStart, curEnd] = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      const [start, end] = intervals[i];
      if (start <= curEnd) {
        curEnd = Math.max(curEnd, end);
      } else {
        total += curEnd - curStart;
        curStart = start;
        curEnd = end;
      }
    }
    return total + (curEnd - curStart);
  }
}

// ── DOM references ─────────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const status = document.getElementById('status');
const outputNgff = document.getElementById('output-ngff');
const outputConsolidated = document.getElementById('output-consolidated');
const downloadNgff = document.getElementById('download-ngff');
const downloadConsolidated = document.getElementById('download-consolidated');

let ngffJson = null;
let consolidatedJson = null;
let fileName = '';

// ── Drag & drop ────────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) processFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) processFile(file);
});

// ── Download buttons ───────────────────────────────────────────────────────────
downloadNgff.addEventListener('click', () => {
  if (!ngffJson) return;
  triggerDownload(ngffJson, fileName.replace(/\.[^.]+$/, '') + '.zarr.json');
});
downloadConsolidated.addEventListener('click', () => {
  if (!consolidatedJson) return;
  triggerDownload(consolidatedJson, fileName.replace(/\.[^.]+$/, '') + '.consolidated.json');
});

function triggerDownload(jsonStr, downloadName) {
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = downloadName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 100);
}

// ── Main processing ────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  return (n / 1024).toFixed(1) + ' KB';
}

async function processFile(file) {
  ngffJson = null;
  consolidatedJson = null;
  downloadNgff.disabled = true;
  downloadConsolidated.disabled = true;
  outputNgff.textContent = '';
  outputConsolidated.textContent = '';
  fileName = file.name;
  status.textContent = 'Processing…';

  try {
    const source = new FileSource(file);
    const lowerName = file.name.toLowerCase();
    const isOmeTiff = lowerName.endsWith('.ome.tif') || lowerName.endsWith('.ome.tiff');
    let store;
    if (isOmeTiff) {
      store = await OmeTiffAsOmeZarrStore.fromStore(source);
    } else {
      try {
        store = await OmeTiffAsOmeZarrStore.fromStore(source);
      } catch {
        store = await TiffAsOmeZarrStore.fromStore(source);
      }
    }

    // Read OME-NGFF root metadata
    const ngffBytes = await store.get('/zarr.json');
    const ngffObj = JSON.parse(new TextDecoder().decode(ngffBytes));
    ngffJson = JSON.stringify(ngffObj, null, 2);
    outputNgff.textContent = ngffJson;
    downloadNgff.disabled = false;

    // Read consolidated metadata
    const consolidatedObj = await store.getConsolidatedMetadata();
    consolidatedJson = JSON.stringify(consolidatedObj, null, 2);
    outputConsolidated.textContent = consolidatedJson;
    downloadConsolidated.disabled = false;

    const bytesRead = source.uniqueBytesFetched();
    const pct = ((bytesRead / file.size) * 100).toFixed(1);
    status.textContent = `Done — read ${fmt(bytesRead)} of ${fmt(file.size)} (${pct}% of file)`;
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    console.error(err);
  }
}
