import { Worker } from "node:worker_threads";

/** Text extraction is isolated from the API thread and never executes document scripts. */
export async function pdfDocumentText(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const worker = new Worker(PDF_WORKER, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 128 },
    stderr: true,
    stdout: true,
    workerData: {
      bytes: new Uint8Array(bytes),
      moduleUrl: import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
    },
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      cancel = () => reject(new Error("PDF text extraction was cancelled."));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
      }
      timer = setTimeout(
        () => reject(new Error("PDF text extraction exceeded 20 seconds.")),
        20_000
      );
      worker.once("error", reject);
      worker.once("exit", (code) =>
        reject(
          new Error(
            `PDF text extraction stopped before returning a result (${code}).`
          )
        )
      );
      worker.once("message", (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "text" in value &&
          typeof value.text === "string"
        ) {
          resolve(value.text);
        } else if (
          value &&
          typeof value === "object" &&
          "error" in value &&
          typeof value.error === "string"
        ) {
          reject(new Error(value.error));
        } else {
          reject(new Error("PDF text extraction returned an invalid result."));
        }
      });
    });
  } finally {
    if (cancel) {
      signal?.removeEventListener("abort", cancel);
    }
    clearTimeout(timer);
    await worker.terminate();
  }
}

const PDF_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { getDocument } = await import(workerData.moduleUrl);
  const task = getDocument({ data: workerData.bytes, isEvalSupported: false, enableScripting: false,
    useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages > 500) throw new Error('PDF exceeds the 500-page text-extraction limit. Split the document before attaching it.');
    const pages = [];
    let size = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\\n' : ' ')).join('');
      size += Buffer.byteLength(text);
      if (size > 2 * 1024 * 1024) throw new Error('PDF extracted text exceeds 2 MiB. Split the document before attaching it.');
      pages.push('## Page ' + number + '\\n' + text);
      page.cleanup();
    }
    if (size === 0) throw new Error('This PDF has no extractable text. OCR or a vision-capable reader is required; the original file is preserved.');
    parentPort.postMessage({ text: pages.join('\\n\\n') });
  } finally { await task.destroy(); }
})().catch(error => parentPort.postMessage({ error: error instanceof Error ? error.message : 'PDF extraction failed.' }));
`;
