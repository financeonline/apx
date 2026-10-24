// Copies the in-browser OCR files into public/ocr (ADR-175), so invoice reading never fetches code or
// language data from a CDN. Runs before `next dev` and `next build`; public/ocr is not committed.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'public', 'ocr');
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // The worker picks the variant the browser supports; all three are LSTM-only (the engine used).
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  // The integer "best" English model: more accurate than the fast one, and smaller (about 3 MB).
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
];

for (const [from, to] of files) {
  mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  copyFileSync(path.join(root, from), path.join(out, to));
}
process.stdout.write(`ocr assets: ${files.length} files in public/ocr\n`);
