// Розпізнавання мовлення на самому телефоні: Whisper base.en (int8) через transformers.js, лише процесор (wasm).
// Працює у фоновому потоці, щоб екран не підвисав. Мережа не потрібна: усі файли лежать поруч і їх кешує
// service worker застосунку (кеш "asr-…", переживає оновлення застосунку).
//
// Перевірка проти очікуваної фрази. Ми знаємо, що людина мала сказати, тож окрім вільного розпізнавання
// модель оцінює, наскільки за цим самим записом імовірна саме очікувана фраза (середня лог-ймовірність
// на токен). Якщо вона майже така ж, як у почутого (різниця ≤ MARGIN), людина сказала правильно, а модель
// лише обрала інше написання чи омофон: petrol → «patrol», role → «roll», peach → «Peter».
// Пороги підібрано на стенді (krokly/v4/bench, e2e.js): кілька сотень записів у 5 умовах (чисто, шум, швидко,
// повільно, «дешевий мікрофон») і підступні неправильні варіанти (схожі слова, фраза з заміненим чи доданим словом).
//
// Оцінка — окремий крок ({ check }), бо потрібна лише тоді, коли звичайне розпізнавання не збіглося з фразою
// (рідко), а так кожна відповідь не чекає зайвих обчислень.
import { pipeline, env, Tensor } from "./lib/transformers.min.js";

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

// пороги з двох кіл стенду: у фраз неправильні варіанти не підходили ближче 1,2, у слів найближча пара desk/ask — 0,46
const MARGIN = 0.5, MARGIN_WORD = 0.3;
// м'якші пороги для «зрозумів, але з акцентом». Стенд bench/acc.js: 180 записів шістьма голосами без акценту,
// з легким і сильним українським акцентом (th, w, h, -ng, оглушення, голосні), чисто й «як у житті».
// Найближча неправильна фраза — 1,34 (it's up to you / it's not up to you), тож 1,2 для фраз і 0,7 для слів:
// легкий акцент 74 → 80%, сильний 54 → 69%, жодної неправильної фрази не зараховано
const SOFT = 1.2, SOFT_WORD = 0.7;
let asr = null;
function load() {
  if (!asr) asr = pipeline("automatic-speech-recognition", "whisper-base.en", {
    device: "wasm",
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" }
  }).catch(e => { asr = null; throw e; });
  return asr;
}

// як модель сама пише фразу: з великої літери й з крапкою, або без неї
function variants(t) {
  const s = String(t).trim(), cap = s.charAt(0).toUpperCase() + s.slice(1);
  return [...new Set([cap + (/[.!?]$/.test(s) ? "" : "."), cap, s])];
}
// середня лог-ймовірність токенів ids (після службового початку довжиною from) за виходом кодувальника enc
async function score(model, enc, ids, from) {
  const inp = new Tensor("int64", BigInt64Array.from(ids.slice(0, -1).map(BigInt)), [1, ids.length - 1]);
  const L = (await model({ encoder_outputs: enc, decoder_input_ids: inp })).logits, V = L.dims[2], data = L.data;
  let sum = 0, n = 0;
  for (let i = from - 1; i < ids.length - 1; i++) {
    const row = data.subarray(i * V, (i + 1) * V);
    let mx = -Infinity; for (let j = 0; j < V; j++) if (row[j] > mx) mx = row[j];
    let z = 0; for (let j = 0; j < V; j++) z += Math.exp(row[j] - mx);
    sum += row[ids[i + 1]] - mx - Math.log(z); n++;
  }
  return sum / Math.max(1, n);
}

// останній запис: вихід кодувальника й розпізнана послідовність, щоб оцінити очікувану фразу без повторної роботи
let last = null;
async function recognise(P, pcm) {
  const m = P.model, tok = P.tokenizer;
  const feats = await P.processor(pcm);
  // generate сам рахує кодувальник (готовий вихід через encoder_outputs Whisper ігнорує, перевірено на стенді),
  // тож для оцінки кодувальник рахуємо окремо й лише тоді, коли вона справді потрібна
  const gen = await m.generate({ inputs: feats.input_features, max_new_tokens: 96 });
  const seq = Array.from((gen.sequences || gen).tolist()[0], Number);
  const eos = m.generation_config.eos_token_id;
  let p = 0; while (p < seq.length && seq[p] > eos) p++; // службові токени на початку
  const hypIds = seq[seq.length - 1] === eos ? seq : seq.concat([eos]);
  const text = tok.decode(hypIds.slice(p, -1), { skip_special_tokens: true }).trim();
  last = { feats, hypIds, p, eos, enc: null };
  return { text };
}
// target — рядок або кілька прийнятних варіантів (show off / to show off)
async function check(P, target) {
  if (!last) return { accept: false };
  const m = P.model, tok = P.tokenizer, { hypIds, p, eos } = last;
  if (hypIds.length <= p + 1) return { accept: false }; // нічого не почуто
  if (!last.enc) last.enc = new Tensor((await m.sessions["model"].run({ input_features: last.feats.input_features.ort_tensor })).last_hidden_state);
  const enc = last.enc;
  const h = await score(m, enc, hypIds, p);
  let t = -Infinity;
  for (const v of [].concat(target).flatMap(variants)) {
    const ids = hypIds.slice(0, p).concat(tok.encode(" " + v, { add_special_tokens: false }), [eos]);
    t = Math.max(t, await score(m, enc, ids, p));
  }
  // окреме слово — обережніше: найближча неправильна пара на стенді desk/ask дала 0,46.
  // soft — м'якший поріг для вимови з акцентом (world → «velt», blog → «block»): фразу зрозуміло, але є що підтягнути
  const one = [].concat(target).every(x => !/\s/.test(String(x).trim())), d = h - t;
  return { accept: d <= (one ? MARGIN_WORD : MARGIN), soft: d <= (one ? SOFT_WORD : SOFT), d: Math.round(d * 100) / 100 };
}

// { id } — завантажити; { id, pcm } — розпізнати; { id, check: target } — оцінити очікувану фразу за останнім записом
self.onmessage = async ({ data }) => {
  const { id, pcm, check: target } = data || {};
  try {
    const P = await load();
    const t0 = performance.now();
    let r;
    if (target) {
      try { r = await check(P, target); } catch (e) { r = { accept: false, fallback: String((e && e.message) || e).slice(0, 200) }; }
    } else if (pcm) {
      try { r = await recognise(P, pcm); }
      catch (e) { // якщо щось пішло не так, звичайне розпізнавання все одно дає відповідь
        last = null;
        const out = await P(pcm, { max_new_tokens: 96 });
        r = { text: String((out && out.text) || "").trim(), fallback: String((e && e.message) || e).slice(0, 200) };
      }
    } else { self.postMessage({ id, ready: true }); return; }
    self.postMessage(Object.assign({ id, ms: Math.round(performance.now() - t0), threads: wasm.numThreads }, r));
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
