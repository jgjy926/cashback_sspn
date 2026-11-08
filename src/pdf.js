// PDF support for receipt / bill scanning (e-receipts, e-invoices, utility bills, SSPN
// statements…). Each PDF page becomes one "photo" in the existing multi-photo flow:
//   - The page is rendered to a JPEG, so storage in Koofr, thumbnails, the image viewer
//     and the gateway's OCR route all work exactly as they do for camera photos.
//   - If the page already carries a digital text layer (most e-receipts / e-statements),
//     that text is used directly — exact, instant, and no OCR call. Scanned PDFs (image
//     only) fall through to the normal OCR route.
// pdf.js is lazy-loaded on the first PDF, so normal page loads don't pay for it.
// window.PDFJS_BASE (set in index.html) points at the CDN; the Android build rewrites it
// to the bundled ./vendor/pdfjs/ copy so it works offline.

const DEFAULT_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
export const MAX_PDF_PAGES = 10;
// Below this many non-space characters a page's text layer is treated as "no text"
// (e.g. a scanned page with only a page number), and the page is OCR'd instead.
const MIN_TEXT_CHARS = 25;

let loading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (loading) return loading;
  const base = window.PDFJS_BASE || DEFAULT_BASE;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = base + 'pdf.min.js';
    s.onload = () => {
      if (!window.pdfjsLib) { reject(new Error('PDF reader failed to load.')); return; }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { loading = null; reject(new Error('Could not load the PDF reader — check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading;
}

export function isPdfFile(file) {
  return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

// Rebuild reading-order lines from pdf.js text items: group by baseline (y), then sort by x.
function textFromItems(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 8;
    let row = rows.find(r => Math.abs(r.y - y) <= h * 0.5);
    if (!row) { row = { y, h, parts: [] }; rows.push(row); }
    row.parts.push({ x, str: it.str, w: it.width || 0 });
  }
  rows.sort((a, b) => b.y - a.y); // PDF y grows upwards
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    let line = '', end = null;
    for (const p of r.parts) {
      if (end !== null) {
        const gap = p.x - end;
        line += gap > r.h * 1.5 ? '   ' : (gap > r.h * 0.15 && !line.endsWith(' ') && !p.str.startsWith(' ') ? ' ' : '');
      }
      line += p.str;
      end = p.x + p.w;
    }
    return line.replace(/\s+$/, '');
  }).join('\n');
}

// Returns [{ image: Blob (JPEG), text: string, pageNo, pageCount }], one per page (max MAX_PDF_PAGES).
// `onProgress(pageNo, pageCount)` is called before each page.
export async function readPdfPages(file, { maxEdge = 2400, onProgress } = {}) {
  const pdfjsLib = await loadPdfJs();
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new Error(`"${file.name}" is password-protected. Save an unlocked copy (print to PDF) and try again.`);
    }
    throw new Error(`Could not open "${file.name}" as a PDF.`);
  }
  const count = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages = [];
  for (let n = 1; n <= count; n++) {
    onProgress?.(n, count);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxEdge / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // PDFs are transparent by default; JPEG needs a white page
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const image = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    let text = '';
    try { text = textFromItems((await page.getTextContent()).items); } catch { /* scanned page */ }
    if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) text = '';
    pages.push({ image, text, pageNo: n, pageCount: doc.numPages });
    page.cleanup();
  }
  doc.destroy();
  return pages;
}
