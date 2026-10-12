// background.js — eklentinin service worker'ı: MCP sunucusuna WebSocket ile bağlanır, komutları Flow sekmesine iletir // dosyanın amacı
const DEFAULT_PORT = 17345; // MCP sunucusunun varsayılan portu
const FLOW_URL = "https://flow.google.com/"; // Flow açılış adresi
const FLOW_PATTERNS = ["https://flow.google.com/*", "https://labs.google/fx/*"]; // Flow sekmelerini tanımak için URL kalıpları
let ws = null; // aktif WebSocket bağlantısı
let flowTabId = null; // son kullanılan Flow sekmesinin kimliği
let lastError = ""; // popup'ta gösterilecek son hata
const attached = new Set(); // debugger (CDP) bağlı sekmeler

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // bekleme yardımcısı
const getPort = async () => (await chrome.storage.local.get("port")).port || DEFAULT_PORT; // ayarlardan portu oku

async function connect() { // MCP sunucusuna bağlanır
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return; // zaten bağlıysa/bağlanıyorsa çık
  const port = await getPort(); // portu al
  try { ws = new WebSocket(`ws://127.0.0.1:${port}`); } catch (e) { lastError = e.message; return; } // bağlantıyı başlat
  ws.onopen = () => { lastError = ""; ws.send(JSON.stringify({ type: "hello", role: "extension", version: chrome.runtime.getManifest().version })); setBadge(true); }; // açılınca kendini tanıt, rozeti yeşil yap
  ws.onclose = () => { setBadge(false); ws = null; }; // kapanınca rozeti kırmızı yap
  ws.onerror = () => { lastError = `ws://127.0.0.1:${port} adresine bağlanılamadı (MCP sunucusu çalışıyor mu?)`; }; // hata mesajını sakla
  ws.onmessage = async (ev) => { // sunucudan mesaj gelince
    let msg; try { msg = JSON.parse(ev.data); } catch { return; } // JSON çöz
    if (msg.type === "ping") { ws?.send(JSON.stringify({ type: "pong" })); return; } // ping'e pong ile cevap ver
    if (msg.type !== "cmd") return; // komut değilse yok say
    try { const result = await handle(msg.action, msg.params || {}); ws?.send(JSON.stringify({ id: msg.id, ok: true, result })); } // komutu işle, sonucu gönder
    catch (e) { ws?.send(JSON.stringify({ id: msg.id, ok: false, error: e?.message || String(e) })); } // hata olursa hatayı gönder
  }; // onmessage sonu
} // connect sonu

function setBadge(on) { chrome.action.setBadgeText({ text: on ? "ON" : "OFF" }); chrome.action.setBadgeBackgroundColor({ color: on ? "#1e8e3e" : "#d93025" }); } // eklenti ikonundaki bağlantı rozetini günceller

chrome.runtime.onStartup.addListener(connect); // tarayıcı açılınca bağlan
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create("keepalive", { periodInMinutes: 0.5 }); connect(); }); // kurulunca 30 sn'lik canlı tutma alarmı kur ve bağlan
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "keepalive") connect(); }); // her alarmda bağlantıyı kontrol et
chrome.tabs.onRemoved.addListener((id) => { if (id === flowTabId) flowTabId = null; attached.delete(id); }); // kapanan sekmeyi unut
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId)); // debugger ayrılınca kaydı sil
chrome.runtime.onMessage.addListener((msg, _s, send) => { // popup'tan gelen mesajlar
  if (msg?.popup === "status") { send({ connected: ws?.readyState === WebSocket.OPEN, lastError, flowTabId }); return; } // durum sorgusu
  if (msg?.popup === "reconnect") { try { ws?.close(); } catch {} ws = null; connect().then(() => send({ ok: true })); return true; } // yeniden bağlan
}); // popup dinleyicisi sonu
connect(); // service worker her uyandığında bağlanmayı dene

async function waitTabLoaded(tabId, timeout = 30000) { // sekmenin yüklenmesini bekler
  const end = Date.now() + timeout; // bitiş zamanı
  while (Date.now() < end) { const t = await chrome.tabs.get(tabId); if (t.status === "complete") return t; await sleep(300); } // complete olana kadar bekle
  return chrome.tabs.get(tabId); // süre dolarsa mevcut durumu döndür
} // waitTabLoaded sonu

async function getFlowTab({ create = true, focus = false } = {}) { // Flow sekmesini bulur veya açar
  if (flowTabId != null) { try { const t = await chrome.tabs.get(flowTabId); if (FLOW_PATTERNS.some((p) => t.url?.startsWith(p.replace("*", "")))) { if (focus) await focusTab(t); return t; } } catch {} } // kayıtlı sekme hâlâ Flow'daysa onu kullan
  const tabs = await chrome.tabs.query({ url: FLOW_PATTERNS }); // açık Flow sekmelerini ara
  let t = tabs.find((x) => x.active) || tabs[0]; // aktif olanı tercih et
  if (!t && !create) throw new Error("Açık Flow sekmesi yok. flow_open kullan."); // oluşturma kapalıysa hata
  if (!t) { t = await chrome.tabs.create({ url: FLOW_URL, active: true }); await waitTabLoaded(t.id); t = await chrome.tabs.get(t.id); } // yoksa yeni sekme aç
  flowTabId = t.id; // sekmeyi hatırla
  if (focus) await focusTab(t); // istenirse öne getir
  return t; // sekmeyi döndür
} // getFlowTab sonu

async function focusTab(t) { await chrome.windows.update(t.windowId, { focused: true }); await chrome.tabs.update(t.id, { active: true }); } // sekmeyi ve penceresini öne getirir

async function toContent(action, params, tab) { // komutu Flow sekmesindeki content script'e iletir
  tab = tab || (await getFlowTab()); // hedef sekme
  const send = () => chrome.tabs.sendMessage(tab.id, { __flowmcp: true, action, params }); // mesaj gönderme fonksiyonu
  let res; // cevap
  try { res = await send(); } // ilk deneme
  catch (e) { // content script yoksa (ör. eklenti sekmeden sonra kurulduysa)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); // betiği enjekte et
    await sleep(150); res = await send(); // tekrar dene
  } // catch sonu
  if (!res) throw new Error("Content script cevap vermedi"); // cevap yoksa hata
  if (!res.ok) throw new Error(res.error); // hata cevabıysa fırlat
  return res.result; // sonucu döndür
} // toContent sonu

function bufToB64(buf) { // ArrayBuffer'ı base64'e çevirir (büyük dosyalar için parça parça)
  const bytes = new Uint8Array(buf); let bin = ""; const CH = 0x8000; // bayt dizisi ve parça boyutu
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); // parça parça stringe çevir
  return btoa(bin); // base64 döndür
} // bufToB64 sonu

async function cdp(tabId, method, params = {}) { // Chrome DevTools Protocol komutu gönderir (gerçek kullanıcı girdisi için)
  if (!attached.has(tabId)) { await chrome.debugger.attach({ tabId }, "1.3"); attached.add(tabId); } // gerekirse debugger'ı bağla
  return chrome.debugger.sendCommand({ tabId }, method, params); // komutu gönder
} // cdp sonu

async function cdpClick(tab, x, y) { // CDP ile gerçek fare tıklaması yapar
  const base = { x, y, button: "left", clickCount: 1 }; // ortak parametreler
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); // fareyi taşı
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...base }); // bas
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base }); // bırak
} // cdpClick sonu

async function handle(action, p) { // sunucudan gelen komutu işler
  switch (action) { // eyleme göre dallan
    case "tab.open": { // Flow sekmesini aç/odakla, istenirse URL'ye git
      let t = await getFlowTab({ focus: p.focus !== false }); // sekmeyi al
      if (p.url) { await chrome.tabs.update(t.id, { url: p.url }); await sleep(500); t = await waitTabLoaded(t.id); } // URL verildiyse git
      if (p.reload) { await chrome.tabs.reload(t.id); await sleep(500); t = await waitTabLoaded(t.id); } // istenirse yenile
      return { tabId: t.id, url: t.url, title: t.title }; // sekme bilgisi
    } // tab.open sonu
    case "tab.info": { const t = await getFlowTab({ create: false }); return { tabId: t.id, url: t.url, title: t.title, status: t.status }; } // sekme bilgisi
    case "tab.list": return (await chrome.tabs.query({ url: FLOW_PATTERNS })).map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active })); // tüm Flow sekmeleri
    case "tab.select": { const t = await chrome.tabs.get(p.tabId); flowTabId = t.id; await focusTab(t); return { tabId: t.id, url: t.url }; } // belirli sekmeyi seç
    case "screenshot": { // görünür alanın ekran görüntüsü
      const t = await getFlowTab({ focus: true }); await sleep(250); // sekmeyi öne getir
      const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: p.format || "png", quality: 80 }); // görüntüyü al
      return { mime: dataUrl.slice(5, dataUrl.indexOf(";")), base64: dataUrl.split(",")[1] }; // base64 döndür
    } // screenshot sonu
    case "fetch": { // CORS'a takılmadan URL içeriğini indir (eklenti izinleriyle)
      if (/^(blob|data):/.test(p.url)) return toContent("mediaToBase64", { src: p.url }); // blob/data adresleri sadece sayfa içinden okunabilir
      const res = await fetch(p.url, { credentials: "include" }); // çerezlerle indir
      if (!res.ok) throw new Error(`İndirme hatası ${res.status}: ${p.url}`); // HTTP hatası
      const buf = await res.arrayBuffer(); // içerik
      return { mime: res.headers.get("content-type") || "", size: buf.byteLength, base64: bufToB64(buf) }; // base64 döndür
    } // fetch sonu
    case "download.browser": { const id = await chrome.downloads.download({ url: p.url, filename: p.filename, saveAs: false }); return { downloadId: id }; } // Chrome'un indirme yöneticisiyle indir
    case "cdp.click": { const t = await getFlowTab(); const r = await toContent("rect", p, t); await cdpClick(t, r.x, r.y); return r; } // CDP ile gerçek tıklama
    case "cdp.type": { const t = await getFlowTab(); if (p.ref || p.text || p.selector) { const r = await toContent("rect", p, t); await cdpClick(t, r.x, r.y); } if (p.clear) { await cdp(t.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 }); await cdp(t.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }); } await cdp(t.id, "Input.insertText", { text: p.value }); return { ok: true }; } // CDP ile gerçek yazma (clear: Ctrl+A ile seçip üzerine yaz)
    case "cdp.key": { const t = await getFlowTab(); const vk = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38 }[p.key] || 0; const mods = (p.alt ? 1 : 0) | (p.ctrl ? 2 : 0) | (p.meta ? 4 : 0) | (p.shift ? 8 : 0); for (const type of ["keyDown", "keyUp"]) await cdp(t.id, "Input.dispatchKeyEvent", { type, key: p.key, code: p.key, windowsVirtualKeyCode: vk, modifiers: mods, text: type === "keyDown" && p.key === "Enter" ? "\r" : undefined }); return { ok: true }; } // CDP ile gerçek tuş
    case "cdp.upload": { // CDP ile dosya yolundan yükleme (büyük videolar için base64'süz)
      const t = await getFlowTab(); // sekme
      const mark = p.trigger ? null : await toContent("markFileInput", { ref: p.ref, selector: p.selector, mime: p.mime }, t); // uygun dosya inputunu işaretle
      if (mark) { // input bulunduysa
        const { result } = await cdp(t.id, "Runtime.evaluate", { expression: `document.querySelector('[data-flowmcp-ref="${mark.ref}"]')` }); // inputun uzak nesnesini al
        await cdp(t.id, "DOM.setFileInputFiles", { files: p.paths, objectId: result.objectId }); // dosya yollarını doğrudan ata
        return { method: "cdp-input", target: mark }; // sonuç
      } // input bloğu sonu
      if (!p.trigger) throw new Error("Dosya inputu bulunamadı; 'trigger' (yükleme butonu ref/text) ver."); // tetikleyici yoksa hata
      await cdp(t.id, "Page.enable"); await cdp(t.id, "Page.setInterceptFileChooserDialog", { enabled: true }); // dosya seçici penceresini yakala
      const opened = new Promise((res) => { const fn = (src, method, params) => { if (src.tabId === t.id && method === "Page.fileChooserOpened") { chrome.debugger.onEvent.removeListener(fn); res(params); } }; chrome.debugger.onEvent.addListener(fn); setTimeout(() => res(null), 6000); }); // açılma olayını bekle
      const r = await toContent("rect", p.trigger, t); await cdpClick(t, r.x, r.y); // tetikleyiciye gerçek tıklama
      const ev = await opened; await cdp(t.id, "Page.setInterceptFileChooserDialog", { enabled: false }); // olayı al, yakalamayı kapat
      if (!ev) throw new Error("Dosya seçici açılmadı"); // açılmadıysa hata
      await cdp(t.id, "DOM.setFileInputFiles", { files: p.paths, backendNodeId: ev.backendNodeId }); // dosyaları seçiciye ver
      return { method: "cdp-chooser", trigger: r }; // sonuç
    } // cdp.upload sonu
    case "cdp.detach": { for (const id of attached) try { await chrome.debugger.detach({ tabId: id }); } catch {} attached.clear(); return { ok: true }; } // debugger'ı ayır (sarı uyarı çubuğunu kaldırır)
    default: return toContent(action, p); // diğer tüm eylemler content script'e gider
  } // switch sonu
} // handle sonu
