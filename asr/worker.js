// Розпізнавання мовлення на самому телефоні: Whisper base.en (int8) через transformers.js, лише процесор (wasm).
// Працює у фоновому потоці, щоб екран не підвисав. Мережа не потрібна: усі файли лежать поруч і їх кешує
// service worker застосунку (кеш "asr-…", переживає оновлення застосунку).
// Повідомлення: { id } — лише завантажити модель; { id, pcm } — розпізнати 16 кГц моно Float32Array.
import { pipeline, env } from "./lib/transformers.min.js";

env.allowRemoteModels = false;
env.allowLocalModels = true;
// саме шлях, без адреси сайту: повну адресу transformers.js вважає віддаленою і не перевіряє локальні файли
env.localModelPath = new URL("./models/", import.meta.url).pathname;
env.useBrowserCache = false; // кешує service worker, удруге не зберігаємо
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm;
wasm.wasmPaths = {
  mjs: new URL("./lib/ort-wasm-simd-threaded.mjs", import.meta.url).href,
  wasm: new URL("./lib/ort-wasm-simd-threaded.wasm", import.meta.url).href
};
// кілька потоків лише в ізольованій сторінці (заголовки COOP/COEP ставить service worker); інакше один
const cores = (self.navigator && navigator.hardwareConcurrency) || 2;
wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
wasm.proxy = false;

let asr = null;
function load() {
  if (!asr) asr = pipeline("automatic-speech-recognition", "whisper-base.en", {
    device: "wasm",
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" }
  }).catch(e => { asr = null; throw e; });
  return asr;
}

self.onmessage = async ({ data }) => {
  const { id, pcm } = data || {};
  try {
    const run = await load();
    if (!pcm) { self.postMessage({ id, ready: true }); return; }
    const t0 = performance.now();
    const out = await run(pcm, { max_new_tokens: 96 });
    self.postMessage({ id, text: String((out && out.text) || "").trim(), ms: Math.round(performance.now() - t0), threads: wasm.numThreads });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
