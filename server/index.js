#!/usr/bin/env node
// index.js — Google Flow MCP sunucusu: araçları tanımlar ve Chrome eklentisi üzerinden Flow'u kontrol eder // dosyanın amacı
import fs from "node:fs"; // dosya boyutu kontrolü için
import path from "node:path"; // yol işlemleri için
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // MCP sunucu sınıfı
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // stdio taşıma katmanı
import { z } from "zod"; // araç parametre şemaları için
import { Bridge } from "./bridge.js"; // eklenti köprüsü
import { readAsPayload, resolveInput, mimeOf, saveBase64, DOWNLOAD_DIR, DATA_DIR } from "./files.js"; // dosya yardımcıları
import { upsertCharacter, getCharacter, listCharacters, deleteCharacter } from "./characters.js"; // karakter kütüphanesi

const PORT = Number(process.env.FLOW_MCP_PORT || 17345); // köprü portu
const INPUT_MODE = (process.env.FLOW_MCP_INPUT_MODE || "dom").toLowerCase(); // dom: sentetik olaylar, cdp: gerçek tarayıcı girdisi
const CDP_UPLOAD_MB = Number(process.env.FLOW_MCP_CDP_UPLOAD_MB || 40); // bu boyuttan büyük dosyalar CDP ile (yoldan) yüklenir
const bridge = new Bridge(PORT); // köprü örneği
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // bekleme yardımcısı
const call = (action, params = {}, timeout = 60000) => bridge.call(action, params, timeout); // eklentiye komut gönderme kısayolu
let lastJob = null; // son başlatılan üretim işi (sonuç beklemek ve indirmek için)

const HINTS = { // ayar adlarına göre arayüzde aranacak etiket ipuçları (Türkçe + İngilizce)
  mode: ["mod", "mode", "tür", "type", "text to video", "metinden", "frames", "kare", "ingredients", "malzeme", "öğe", "video", "görsel", "image"], // üretim modu
  model: ["model", "veo", "imagen", "nano banana", "omni", "gemini"], // model seçici
  aspectRatio: ["en boy", "aspect", "oran", "ratio", "16:9", "9:16", "1:1", "4:3", "3:4", "yatay", "dikey", "landscape", "portrait", "kare", "square"], // en-boy oranı
  count: ["çıkış", "output", "sayı", "adet", "count", "istem başına", "per prompt", "x1", "x2", "x3", "x4", "varyasyon"], // üretim sayısı
  duration: ["süre", "duration", "saniye", "sec", "4s", "6s", "8s"], // video süresi
  resolution: ["çözünürlük", "resolution", "720p", "1080p", "4k", "kalite", "quality"], // çözünürlük
}; // HINTS sonu

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] }); // başarılı araç cevabı üretir
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `HATA: ${e?.message || e}` }] }); // hatalı araç cevabı üretir
const safe = (fn) => async (args, extra) => { try { return await fn(args || {}, extra); } catch (e) { return fail(e); } }; // araç gövdesini hata yakalayıcıyla sarar

function target(t) { // "e12" / "css:..." / "metin" biçimindeki hedefi eklenti parametresine çevirir
  if (!t) return {}; // hedef yoksa boş
  if (/^e\d+$/.test(t)) return { ref: t }; // ref biçimi
  if (t.startsWith("css:")) return { selector: t.slice(4) }; // CSS seçici biçimi
  return { text: t }; // aksi halde görünür metin/etiket
} // target sonu

async function progress(extra, p, total, message) { // istemciye ilerleme bildirimi gönderir (uzun işlemlerde zaman aşımını önler)
  const token = extra?._meta?.progressToken; if (token == null) return; // istemci ilerleme istemediyse çık
  try { await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: p, total, message } }); } catch {} // bildirimi gönder
} // progress sonu

async function applySettings(s) { // mod/model/oran/sayı/süre/çözünürlük ve özel ayarları sırayla uygular
  const results = []; // sonuç listesi
  const list = []; // uygulanacak (değer, ipuçları) çiftleri
  for (const k of ["mode", "model", "aspectRatio", "resolution", "duration", "count"]) if (s[k] != null && s[k] !== "") list.push({ name: k, value: String(s[k]), hints: HINTS[k] }); // bilinen ayarlar
  for (const [k, v] of Object.entries(s.settings || {})) list.push({ name: k, value: String(v), hints: [k] }); // kullanıcı tanımlı ayarlar (etiket -> değer)
  for (const it of list) { // her ayar için
    try { results.push({ setting: it.name, ...(await call("applyChoice", { value: it.value, hints: it.hints }, 30000)) }); } // eklentide uygula
    catch (e) { results.push({ setting: it.name, value: it.value, status: "error", error: e.message }); } // hatayı kaydet
  } // döngü sonu
  return results; // tüm sonuçlar
} // applySettings sonu

async function uploadFiles(paths, { tgt, method = "auto" } = {}) { // yerel dosyaları Flow'a referans olarak yükler
  const out = []; // sonuçlar
  for (const p of paths) { // dosyaları tek tek yükle (Flow genelde tek dosyalık slot kullanır)
    const abs = resolveInput(p); const sizeMb = fs.statSync(abs).size / 1048576; // yol ve boyut
    const useCdp = INPUT_MODE === "cdp" || method === "cdp" || sizeMb > CDP_UPLOAD_MB; // büyük dosya veya cdp modu ise CDP ile yükle
    let r; // tek dosyanın sonucu
    if (useCdp) { const t = target(tgt); r = await call("cdp.upload", { paths: [abs], mime: mimeOf(abs), ...(t.ref || t.selector ? t : {}), trigger: t.text ? t : undefined }, 60000); } // CDP: dosya yolunu doğrudan tarayıcıya ver
    else r = await call("upload", { files: [readAsPayload(abs)], method: method === "cdp" ? "auto" : method, ...target(tgt) }, 120000); // DOM: base64 olarak gönder
    out.push({ file: abs, ...r }); // sonucu ekle
    await sleep(1500); // Flow'un yüklemeyi işlemesi için kısa bekleme
  } // döngü sonu
  return out; // sonuçlar
} // uploadFiles sonu

async function mediaKeys() { return new Set((await call("listMedia", {}, 20000)).map((m) => m.key)); } // sayfadaki mevcut medya anahtarlarını toplar

async function waitForResults({ timeoutSec = 180, extra } = {}) { // son işin sonuçlarının oluşmasını bekler
  if (!lastJob) throw new Error("Bekleyen üretim işi yok. Önce flow_generate_video / flow_generate_image / flow_send_prompt kullan."); // iş yoksa hata
  const end = Date.now() + timeoutSec * 1000; let stableIdle = 0; let fresh = [], st = {}; // bitiş zamanı, boşta sayaç, yeni medya, durum
  while (Date.now() < end) { // süre dolana kadar
    await sleep(4000); // 4 saniyede bir kontrol et
    const media = await call("listMedia", {}, 20000); st = await call("status", {}, 20000); // medya ve durumu oku
    fresh = media.filter((m) => !lastJob.baseline.has(m.key)); // işten sonra ortaya çıkan medya
    const ofKind = lastJob.kind ? fresh.filter((m) => m.kind === lastJob.kind) : fresh; // istenen türdekiler
    const busy = st.progress.length > 0; // yüzde göstergesi varsa üretim sürüyor
    const newFailures = st.failures.filter((f) => !lastJob.failures.includes(f)); // işten sonra çıkan hata mesajları
    stableIdle = busy ? 0 : stableIdle + 1; // boşta geçen ardışık kontrol sayısı
    const elapsed = Math.round((Date.now() - lastJob.startedAt) / 1000); // geçen süre
    await progress(extra, elapsed, undefined, `${ofKind.length}/${lastJob.expected} sonuç, ilerleme: ${st.progress.join(", ") || "-"}`); // ilerleme bildir
    if (ofKind.length >= lastJob.expected && stableIdle >= 2) return { done: true, elapsedSec: elapsed, results: ofKind, alerts: st.alerts }; // beklenen sayıya ulaşıldı
    if (ofKind.length > 0 && stableIdle >= 4) return { done: true, partial: true, elapsedSec: elapsed, results: ofKind, alerts: st.alerts }; // daha az sonuç ama üretim durmuş
    if (newFailures.length && !busy && stableIdle >= 2) return { done: false, failed: true, elapsedSec: elapsed, failures: newFailures, results: ofKind, alerts: st.alerts }; // hata mesajı çıktı
  } // döngü sonu
  return { done: false, stillRunning: true, message: "Üretim henüz bitmedi. flow_wait_for_results'u tekrar çağır.", results: fresh, progress: st.progress, alerts: st.alerts }; // zaman aşımı: tekrar beklenebilir
} // waitForResults sonu

async function downloadItems(items, { dir = DOWNLOAD_DIR, prefix = "flow" } = {}) { // medya öğelerini diske indirir
  const saved = []; // kaydedilen dosyalar
  for (const [i, m] of items.entries()) { // her öğe için
    try { // tek öğe indirme
      const data = m.src && /^https?:/.test(m.src) ? await call("fetch", { url: m.src }, 300000) : await call("mediaToBase64", { ref: m.ref }, 300000); // http ise arka plandan, blob/data ise sayfa içinden oku
      const file = saveBase64(data.base64, { dir, filename: `${prefix}-${Date.now()}-${i + 1}`, mime: data.mime || (m.kind === "video" ? "video/mp4" : "image/png") }); // diske kaydet
      saved.push({ ref: m.ref, kind: m.kind, file, sizeKb: Math.round((data.size || 0) / 1024) }); // sonucu ekle
    } catch (e) { saved.push({ ref: m.ref, kind: m.kind, error: e.message }); } // hata kaydı
  } // döngü sonu
  return saved; // sonuç listesi
} // downloadItems sonu

async function runGeneration(kind, a, extra) { // video/görsel üretiminin tüm adımlarını yürütür
  const report = { kind, steps: [] }; // adım raporu
  const tab = await call("tab.open", { focus: true, url: a.projectUrl }, 45000); report.tab = tab; // Flow sekmesini aç
  if (a.newProject) { report.steps.push({ newProject: await call("click", { text: "/yeni proje|new project|add_2|^\\+ ?yeni/" }) }); await sleep(3500); } // istenirse yeni proje oluştur
  report.settings = await applySettings(a); // ayarları uygula
  const chars = (a.characters || []).map(getCharacter); // karakterleri kütüphaneden al
  const refs = [...chars.flatMap((c) => c.images), ...(a.references || [])]; // karakter görselleri + kullanıcı referansları
  if (a.firstFrame) report.firstFrame = await uploadFiles([a.firstFrame], { tgt: a.firstFrameTarget || "/ilk kare|first frame|başlangıç|start frame/", method: a.uploadMethod }); // ilk kare (video)
  if (a.lastFrame) report.lastFrame = await uploadFiles([a.lastFrame], { tgt: a.lastFrameTarget || "/son kare|last frame|bitiş|end frame/", method: a.uploadMethod }); // son kare (video)
  if (refs.length) report.references = await uploadFiles(refs, { tgt: a.referenceTarget, method: a.uploadMethod }); // referans dosyaları yükle
  const charText = chars.filter((c) => c.description).map((c) => `${c.name}: ${c.description}`).join("\n"); // karakter açıklamaları
  const prompt = charText ? `${charText}\n\n${a.prompt}` : a.prompt; // açıklamaları prompt'un başına ekle
  const baseline = await mediaKeys(); const st0 = await call("status", {}, 20000); // gönderim öncesi medya ve hata durumu
  report.prompt = INPUT_MODE === "cdp" ? await call("cdp.type", { ...(await call("setPrompt", { text: "" })), value: prompt, clear: true }) : await call("setPrompt", { text: prompt }); // prompt'u yaz
  await sleep(500); // arayüzün butonu aktifleştirmesi için bekle
  const submitTgt = a.submitTarget ? target(a.submitTarget) : { text: "/^(oluştur|create|generate|gönder|send)$|arrow_forward|send/" }; // değişti: gönder hedefi (verilmediyse tipik buton adları)
  report.submit = INPUT_MODE === "cdp" ? await call("cdp.click", submitTgt) : await call("submit", target(a.submitTarget)); // değişti: cdp modunda gerçek tıklama, dom modunda akıllı buton bulma
  lastJob = { kind: kind === "any" ? null : kind, baseline, failures: st0.failures, expected: Number(String(a.count || 1).replace(/\D/g, "")) || 1, startedAt: Date.now(), prompt }; // işi kaydet
  if (a.wait === false) return { ...report, message: "Gönderildi. Sonuç için flow_wait_for_results kullan." }; // beklenmeyecekse dön
  report.result = await waitForResults({ timeoutSec: a.timeoutSec || (kind === "video" ? 240 : 120), extra }); // sonuçları bekle
  if (a.download && report.result.results?.length) report.downloads = await downloadItems(report.result.results, { dir: a.downloadDir || DOWNLOAD_DIR, prefix: a.filenamePrefix || `flow-${kind}` }); // istenirse indir
  return report; // raporu döndür
} // runGeneration sonu

const server = new McpServer({ name: "flow-mcp", version: "1.0.0" }, { // MCP sunucusunu oluştur
  instructions: [ // modele verilen kullanım rehberi
    "Bu sunucu kullanıcının kendi Chrome'undaki Google Flow (flow.google.com) sekmesini 'Flow MCP Bridge' eklentisi üzerinden kontrol eder.", // genel açıklama
    "Önerilen akış: flow_status -> flow_open -> (gerekirse flow_new_project) -> flow_generate_video / flow_generate_image -> flow_wait_for_results -> flow_download_media.", // önerilen sıra
    "Flow arayüzü sık değişir. Yüksek seviye araçlar sezgisel çalışır; bir adım 'not_found' dönerse flow_snapshot (ve gerekirse flow_screenshot) ile ekrana bak, sonra flow_click / flow_type / flow_upload_references araçlarını ref (ör. e12) vererek kullan.", // yedek strateji
    "Hedef parametreleri: 'e12' = snapshot ref'i, 'css:...' = CSS seçici, diğer her şey = görünür metin/etiket (\"/regex/\" de olur).", // hedef biçimi
    "Karakter tutarlılığı için flow_character_create ile karakter kaydet ve üretim araçlarına characters:[\"Ad\"] ver.", // karakter kullanımı
  ].join("\n"), // satırları birleştir
}); // sunucu sonu

const tgtDesc = "Hedef: 'e12' (snapshot ref), 'css:<seçici>' veya görünür metin/etiket ('/regex/' desteklenir)"; // ortak hedef açıklaması
const genShape = { // video ve görsel üretimi için ortak parametreler
  prompt: z.string().describe("Üretim prompt'u"), // prompt
  mode: z.string().optional().describe("Flow'daki üretim modu etiketi, ör. 'Text to Video', 'Frames to Video', 'Ingredients to Video', 'Metinden Videoya', 'Görsel'"), // mod
  model: z.string().optional().describe("Model etiketi, ör. 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana', 'Imagen 4'"), // model
  aspectRatio: z.string().optional().describe("En-boy oranı, ör. '16:9', '9:16', '1:1'"), // oran
  count: z.union([z.number(), z.string()]).optional().describe("İstem başına çıktı sayısı (1-4)"), // sayı
  resolution: z.string().optional().describe("Çözünürlük/kalite etiketi, ör. '720p', '1080p'"), // çözünürlük
  settings: z.record(z.string(), z.string()).optional().describe("Ek ayarlar: { 'ayar etiketi': 'seçilecek değer' }"), // özel ayarlar
  references: z.array(z.string()).optional().describe("Referans olarak yüklenecek yerel dosya yolları (görsel/video)"), // referanslar
  referenceTarget: z.string().optional().describe("Referans yükleme butonu/alanı. " + tgtDesc), // referans hedefi
  characters: z.array(z.string()).optional().describe("Kütüphanedeki karakter adları; görselleri referans olarak yüklenir, açıklamaları prompt'a eklenir"), // karakterler
  uploadMethod: z.enum(["auto", "drop", "paste", "click", "cdp"]).optional().describe("Dosya yükleme yöntemi (varsayılan auto)"), // yükleme yöntemi
  submitTarget: z.string().optional().describe("Gönder butonu (otomatik bulunamazsa). " + tgtDesc), // gönder hedefi
  newProject: z.boolean().optional().describe("Önce yeni proje oluştur"), // yeni proje
  projectUrl: z.string().optional().describe("Açılacak Flow proje URL'si"), // proje adresi
  wait: z.boolean().optional().describe("Sonuçları bekle (varsayılan true)"), // bekle
  timeoutSec: z.number().optional().describe("Bekleme süresi saniye (video 240, görsel 120 varsayılan)"), // zaman aşımı
  download: z.boolean().optional().describe("Bitince indir (varsayılan false)"), // indir
  downloadDir: z.string().optional().describe(`İndirme klasörü (varsayılan ${DOWNLOAD_DIR})`), // indirme klasörü
  filenamePrefix: z.string().optional().describe("İndirilen dosya adı öneki"), // dosya öneki
}; // genShape sonu

server.registerTool("flow_status", { title: "Bağlantı durumu", description: "MCP köprüsü, Chrome eklentisi ve Flow sekmesinin durumunu gösterir.", inputSchema: {} }, safe(async () => { // durum aracı
  const s = { bridgeMode: bridge.mode, port: PORT, extensionConnected: bridge.isConnected(), extension: bridge.extInfo?.version, inputMode: INPUT_MODE, downloadDir: DOWNLOAD_DIR, dataDir: DATA_DIR }; // köprü bilgisi
  if (s.extensionConnected) { try { s.flowTabs = await call("tab.list", {}, 10000); s.page = await call("status", {}, 15000); } catch (e) { s.pageError = e.message; } } // sekme ve sayfa bilgisi
  else s.help = "Chrome'da chrome://extensions > Geliştirici modu > 'Paketlenmemiş öğe yükle' ile flow-mcp/extension klasörünü yükle."; // kurulum ipucu
  return ok(s); // sonucu döndür
})); // flow_status sonu

server.registerTool("flow_open", { title: "Flow'u aç", description: "Flow sekmesini açar/öne getirir; isteğe bağlı olarak bir URL'ye (ör. proje linki) gider veya sayfayı yeniler.", inputSchema: { url: z.string().optional(), reload: z.boolean().optional() } }, safe(async (a) => { // açma aracı
  const t = await call("tab.open", { url: a.url, reload: a.reload, focus: true }, 45000); await sleep(1500); // sekmeyi aç
  return ok({ ...t, page: await call("status", {}, 15000).catch(() => null) }); // sekme ve durum bilgisi
})); // flow_open sonu

server.registerTool("flow_tabs", { title: "Flow sekmeleri", description: "Açık Flow sekmelerini listeler veya tabId ile birini aktif hedef yapar.", inputSchema: { selectTabId: z.number().optional() } }, safe(async (a) => ok(a.selectTabId ? await call("tab.select", { tabId: a.selectTabId }) : await call("tab.list")))); // sekme aracı

server.registerTool("flow_new_project", { title: "Yeni proje", description: "Flow ana sayfasında yeni proje oluşturur (butonu metinle arar). Olmazsa flow_snapshot + flow_click kullan.", inputSchema: { buttonText: z.string().optional().describe("Varsayılan: /yeni proje|new project/") } }, safe(async (a) => { // yeni proje aracı
  await call("tab.open", { focus: true }, 45000); // sekmeyi aç
  const r = await call("click", { text: a.buttonText || "/yeni proje|new project|add_2/" }); await sleep(3500); // butona bas ve bekle
  return ok({ clicked: r, page: await call("status", {}, 15000) }); // sonuç
})); // flow_new_project sonu

server.registerTool("flow_snapshot", { title: "Sayfa görüntüsü (metin)", description: "Flow sayfasındaki görünür etkileşimli elemanları [ref] ile listeler. Diğer araçlarda bu ref'leri (ör. e12) hedef olarak kullan.", inputSchema: { query: z.string().optional().describe("Sadece adı bu metni içerenler"), limit: z.number().optional(), includeText: z.boolean().optional().describe("Sayfa metnini de ekle") } }, safe(async (a) => { // snapshot aracı
  const s = await call("snapshot", a, 20000); // eklentiden snapshot al
  return ok(`URL: ${s.url}\nBaşlık: ${s.title}\nPrompt kutusu: ${s.promptRef || "bulunamadı"}\n\n${s.elements}${s.text ? "\n\n--- SAYFA METNİ ---\n" + s.text : ""}`); // okunur metin olarak döndür
})); // flow_snapshot sonu

server.registerTool("flow_screenshot", { title: "Ekran görüntüsü", description: "Flow sekmesinin görünür alanının ekran görüntüsünü döndürür.", inputSchema: { format: z.enum(["png", "jpeg"]).optional() } }, safe(async (a) => { // ekran görüntüsü aracı
  const s = await call("screenshot", { format: a.format || "jpeg" }, 20000); // görüntüyü al
  return { content: [{ type: "image", data: s.base64, mimeType: s.mime || "image/jpeg" }] }; // görsel içerik olarak döndür
})); // flow_screenshot sonu

server.registerTool("flow_click", { title: "Tıkla", description: "Bir elemana tıklar. " + tgtDesc, inputSchema: { target: z.string(), index: z.number().optional().describe("Birden çok eşleşmede kaçıncısı (0'dan)"), exact: z.boolean().optional(), mode: z.enum(["dom", "cdp"]).optional().describe("cdp = gerçek fare tıklaması (sentetik tıklama işe yaramazsa)") } }, safe(async (a) => { // tıklama aracı
  const p = { ...target(a.target), index: a.index, exact: a.exact }; // parametreler
  const r = await call((a.mode || INPUT_MODE) === "cdp" ? "cdp.click" : "click", p); await sleep(600); // tıkla ve bekle
  return ok(r); // sonuç
})); // flow_click sonu

server.registerTool("flow_hover", { title: "Üzerine gel", description: "Elemanın üzerine fareyle gelir (kart üzerindeki gizli butonları göstermek için). " + tgtDesc, inputSchema: { target: z.string() } }, safe(async (a) => ok(await call("hover", target(a.target))))); // hover aracı

server.registerTool("flow_type", { title: "Yaz", description: "Bir metin alanına yazar. Hedef verilmezse odaktaki elemana yazar. " + tgtDesc, inputSchema: { value: z.string(), target: z.string().optional(), clear: z.boolean().optional().describe("Önce temizle (varsayılan true)"), pressEnter: z.boolean().optional(), mode: z.enum(["dom", "cdp"]).optional() } }, safe(async (a) => { // yazma aracı
  if ((a.mode || INPUT_MODE) === "cdp") { const r = await call("cdp.type", { ...target(a.target), value: a.value, clear: a.clear !== false }); if (a.pressEnter) await call("cdp.key", { key: "Enter" }); return ok(r); } // CDP ile gerçek yazma
  return ok(await call("type", { ...target(a.target), value: a.value, clear: a.clear, pressEnter: a.pressEnter })); // DOM ile yazma
})); // flow_type sonu

server.registerTool("flow_press_key", { title: "Tuşa bas", description: "Klavye tuşu gönderir (Enter, Escape, Tab, ArrowDown...).", inputSchema: { key: z.string(), target: z.string().optional(), ctrl: z.boolean().optional(), shift: z.boolean().optional(), alt: z.boolean().optional(), mode: z.enum(["dom", "cdp"]).optional() } }, safe(async (a) => ok(await call((a.mode || INPUT_MODE) === "cdp" ? "cdp.key" : "key", { ...target(a.target), key: a.key, ctrl: a.ctrl, shift: a.shift, alt: a.alt })))); // tuş aracı

server.registerTool("flow_scroll", { title: "Kaydır", description: "Sayfayı veya bir elemanı kaydırır (eski üretimleri görmek için).", inputSchema: { direction: z.enum(["up", "down"]).optional(), amount: z.number().optional(), target: z.string().optional(), intoView: z.boolean().optional() } }, safe(async (a) => ok(await call("scroll", { ...target(a.target), direction: a.direction, amount: a.amount, intoView: a.intoView })))); // kaydırma aracı

server.registerTool("flow_wait_for", { title: "Bekle", description: "Bir metin veya CSS seçici görünene (gone=true ise kaybolana) kadar bekler.", inputSchema: { text: z.string().optional(), selector: z.string().optional(), gone: z.boolean().optional(), timeoutSec: z.number().optional() } }, safe(async (a) => ok(await call("waitFor", { text: a.text, selector: a.selector, gone: a.gone, timeout: (a.timeoutSec || 15) * 1000 }, 70000)))); // bekleme aracı

server.registerTool("flow_set_prompt", { title: "Prompt yaz", description: "Flow'un prompt kutusuna metni yazar (göndermez).", inputSchema: { text: z.string(), target: z.string().optional().describe("Prompt kutusu bulunamazsa. " + tgtDesc) } }, safe(async (a) => ok(await call("setPrompt", { text: a.text, ...target(a.target) })))); // prompt yazma aracı

server.registerTool("flow_submit", { title: "Gönder", description: "Prompt'u gönderir (oluştur butonuna basar, yoksa Enter). Sonra flow_wait_for_results ile bekle.", inputSchema: { target: z.string().optional().describe("Gönder butonu. " + tgtDesc), kind: z.enum(["video", "image", "any"]).optional(), expected: z.number().optional() } }, safe(async (a) => { // gönderme aracı
  const baseline = await mediaKeys(); const st0 = await call("status"); // gönderim öncesi durum
  const r = await call("submit", target(a.target)); // gönder
  lastJob = { kind: a.kind && a.kind !== "any" ? a.kind : null, baseline, failures: st0.failures, expected: a.expected || 1, startedAt: Date.now() }; // işi kaydet
  return ok({ submitted: r, next: "flow_wait_for_results" }); // sonuç
})); // flow_submit sonu

server.registerTool("flow_send_prompt", { title: "Prompt gönder", description: "Prompt'u yazar ve gönderir (ayar/referans uygulamadan). İstenirse sonucu bekler.", inputSchema: { prompt: z.string(), kind: z.enum(["video", "image", "any"]).optional(), wait: z.boolean().optional(), timeoutSec: z.number().optional(), download: z.boolean().optional() } }, safe(async (a, extra) => ok(await runGeneration(a.kind || "any", { prompt: a.prompt, wait: a.wait ?? false, timeoutSec: a.timeoutSec, download: a.download }, extra)))); // prompt gönderme aracı

server.registerTool("flow_apply_settings", { title: "Ayarları uygula", description: "Üretim modu, model, en-boy oranı, çıktı sayısı, süre, çözünürlük ve özel ayarları seçer. Her ayar için durum döner (already/selected/clicked/not_found).", inputSchema: { mode: genShape.mode, model: genShape.model, aspectRatio: genShape.aspectRatio, count: genShape.count, resolution: genShape.resolution, duration: z.string().optional().describe("Video süresi etiketi, ör. '8s'"), settings: genShape.settings } }, safe(async (a) => { await call("tab.open", { focus: true }, 45000); return ok(await applySettings(a)); })); // ayar aracı

server.registerTool("flow_upload_references", { title: "Referans yükle", description: "Yerel görsel/video dosyalarını Flow'a referans (ingredient, ilk/son kare, stil vb.) olarak yükler. Büyük videolar otomatik olarak CDP ile yüklenir.", inputSchema: { paths: z.array(z.string()), target: z.string().optional().describe("Yükleme butonu/alanı veya dosya inputu. " + tgtDesc), method: genShape.uploadMethod } }, safe(async (a) => ok(await uploadFiles(a.paths, { tgt: a.target, method: a.method })))); // yükleme aracı

server.registerTool("flow_generate_video", { title: "Video üret", description: "Flow'da video üretir: ayarları uygular, referans/ilk-son kare yükler, prompt'u gönderir, sonucu bekler ve istenirse indirir.", inputSchema: { ...genShape, duration: z.string().optional().describe("Video süresi etiketi"), firstFrame: z.string().optional().describe("İlk kare görseli (yerel yol)"), lastFrame: z.string().optional().describe("Son kare görseli (yerel yol)"), firstFrameTarget: z.string().optional(), lastFrameTarget: z.string().optional() } }, safe(async (a, extra) => ok(await runGeneration("video", a, extra)))); // video aracı

server.registerTool("flow_generate_image", { title: "Görsel üret", description: "Flow'da görsel üretir: ayarları uygular, referans görselleri yükler, prompt'u gönderir, sonucu bekler ve istenirse indirir.", inputSchema: genShape }, safe(async (a, extra) => ok(await runGeneration("image", a, extra)))); // görsel aracı

server.registerTool("flow_wait_for_results", { title: "Sonuçları bekle", description: "Son gönderilen üretimin bitmesini bekler; yeni video/görselleri döndürür. stillRunning dönerse tekrar çağır.", inputSchema: { timeoutSec: z.number().optional().describe("Varsayılan 180"), download: z.boolean().optional(), downloadDir: z.string().optional() } }, safe(async (a, extra) => { // bekleme aracı
  const r = await waitForResults({ timeoutSec: a.timeoutSec || 180, extra }); // bekle
  if (a.download && r.results?.length) r.downloads = await downloadItems(r.results, { dir: a.downloadDir || DOWNLOAD_DIR, prefix: `flow-${lastJob?.kind || "media"}` }); // istenirse indir
  return ok(r); // sonuç
})); // flow_wait_for_results sonu

server.registerTool("flow_list_media", { title: "Medyaları listele", description: "Sayfadaki video ve görselleri (ref, src, boyut, etiket) listeler. sinceLastJob=true ise sadece son işten sonra çıkanlar.", inputSchema: { kind: z.enum(["video", "image"]).optional(), sinceLastJob: z.boolean().optional(), limit: z.number().optional() } }, safe(async (a) => { // medya listesi aracı
  let m = await call("listMedia", { kind: a.kind }, 20000); // listeyi al
  if (a.sinceLastJob && lastJob) m = m.filter((x) => !lastJob.baseline.has(x.key)); // son işten sonrakiler
  return ok(m.slice(0, a.limit || 50)); // sınırla ve döndür
})); // flow_list_media sonu

server.registerTool("flow_download_media", { title: "Medya indir", description: "Videoları/görselleri diske indirir. refs verilmezse son işin sonuçlarını, o da yoksa sayfadaki ilk 'latest' medyayı indirir.", inputSchema: { refs: z.array(z.string()).optional().describe("flow_list_media ref'leri"), urls: z.array(z.string()).optional().describe("Doğrudan medya URL'leri"), latest: z.number().optional(), kind: z.enum(["video", "image"]).optional(), dir: z.string().optional(), filenamePrefix: z.string().optional() } }, safe(async (a) => { // indirme aracı
  const all = await call("listMedia", { kind: a.kind }, 20000); // sayfadaki medya
  let items; // indirilecekler
  if (a.urls?.length) items = a.urls.map((u) => ({ src: u, kind: /\.(mp4|webm|mov)/i.test(u) ? "video" : "image" })); // URL listesi
  else if (a.refs?.length) items = all.filter((m) => a.refs.includes(m.ref)); // ref listesi
  else if (lastJob && !a.latest) items = all.filter((m) => !lastJob.baseline.has(m.key)); // son işin sonuçları
  else items = all.slice(0, a.latest || 1); // sayfadaki ilk N medya
  if (!items.length) throw new Error("İndirilecek medya bulunamadı. flow_list_media ile kontrol et."); // boşsa hata
  return ok(await downloadItems(items, { dir: a.dir || DOWNLOAD_DIR, prefix: a.filenamePrefix || "flow" })); // indir
})); // flow_download_media sonu

server.registerTool("flow_download_via_ui", { title: "Arayüzden indir", description: "Medya kartındaki Flow'un kendi 'İndir' butonunu kullanır (ör. 1080p/upscale seçenekleri için). Dosya Chrome'un indirme klasörüne gider.", inputSchema: { ref: z.string().describe("Medya ref'i (flow_list_media)"), buttonText: z.string().optional().describe("Varsayılan /indir|download/"), quality: z.string().optional().describe("Açılan menüde seçilecek seçenek, ör. '1080p', '720p', 'GIF', 'Orijinal'") } }, safe(async (a) => { // arayüzden indirme aracı
  const r = { button: await call("clickWithin", { ref: a.ref, text: a.buttonText || "/indir|download/" }) }; await sleep(800); // kart içindeki indir butonuna bas
  if (a.quality) { r.quality = await call("click", { text: a.quality }); await sleep(800); } // kalite seçeneğine bas
  return ok({ ...r, note: "Dosya Chrome'un varsayılan indirme klasörüne kaydedilir. Upscale gerekiyorsa birkaç dakika sürebilir." }); // sonuç
})); // flow_download_via_ui sonu

server.registerTool("flow_character_create", { title: "Karakter oluştur", description: "Tutarlı kullanım için karakter kaydeder (ad + açıklama + referans görseller). imagePaths yoksa generate=true ile karakter görseli Flow'da üretilip indirilir ve karaktere eklenir.", inputSchema: { name: z.string(), description: z.string().describe("Görünüş, kıyafet, yaş, stil vb. detaylı tanım"), imagePaths: z.array(z.string()).optional(), generate: z.boolean().optional().describe("Flow'da karakter referans görseli üret"), generatePrompt: z.string().optional().describe("Üretim için ek prompt"), aspectRatio: z.string().optional(), count: z.number().optional(), notes: z.string().optional() } }, safe(async (a, extra) => { // karakter oluşturma aracı
  let images = a.imagePaths || []; let gen = null; // görseller ve üretim raporu
  if (a.generate) { // Flow'da üretilecekse
    gen = await runGeneration("image", { prompt: `Character reference sheet, full body and close-up portrait, neutral background, consistent design. ${a.description}. ${a.generatePrompt || ""}`, aspectRatio: a.aspectRatio, count: a.count, wait: true, download: true, downloadDir: path.join(DATA_DIR, "characters", "_generated"), filenamePrefix: a.name.replace(/\W+/g, "_") }, extra); // görsel üret ve indir
    images = [...images, ...(gen.downloads || []).filter((d) => d.file).map((d) => d.file)]; // indirilen dosyaları ekle
  } // üretim bloğu sonu
  const c = upsertCharacter({ name: a.name, description: a.description, imagePaths: images, notes: a.notes }); // kütüphaneye kaydet
  return ok({ character: c, generation: gen ? { result: gen.result, downloads: gen.downloads } : undefined, usage: `Üretimlerde characters: ["${c.name}"] kullan.` }); // sonuç
})); // flow_character_create sonu

server.registerTool("flow_character_list", { title: "Karakterler", description: "Kayıtlı karakterleri listeler.", inputSchema: {} }, safe(async () => ok(listCharacters()))); // karakter listeleme aracı
server.registerTool("flow_character_delete", { title: "Karakter sil", description: "Karakteri kütüphaneden siler.", inputSchema: { name: z.string() } }, safe(async (a) => ok({ deleted: deleteCharacter(a.name) }))); // karakter silme aracı

server.registerTool("flow_release_debugger", { title: "Debugger'ı bırak", description: "CDP modu kullanıldıysa Chrome'daki 'bu tarayıcıda hata ayıklanıyor' çubuğunu kaldırır.", inputSchema: {} }, safe(async () => ok(await call("cdp.detach")))); // debugger bırakma aracı

await bridge.start(); // WebSocket köprüsünü başlat
await server.connect(new StdioServerTransport()); // MCP'yi stdio üzerinden başlat
console.error(`[flow-mcp] hazır (port ${PORT}, mod ${bridge.mode}, girdi ${INPUT_MODE})`); // hazır logu
