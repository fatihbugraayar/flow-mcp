// content.js — Flow sekmesinde çalışan DOM otomasyon betiği (tıklama, yazma, yükleme, medya okuma) // dosyanın amacı
(() => { // global kapsamı kirletmemek için kendini çağıran fonksiyon
  if (window.__flowMcpContent) return; // betik daha önce enjekte edildiyse tekrar kurma
  window.__flowMcpContent = true; // enjekte edildi işaretini koy

  const refs = new Map(); // ref kimliği -> DOM elemanı eşlemesi
  let refSeq = 0; // ref sayacı
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // bekleme yardımcısı
  const norm = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ı/g, "i").replace(/\s+/g, " ").trim(); // Türkçe/İngilizce karşılaştırma için metni sadeleştirir

  const INTERACTIVE = "button,a[href],input,textarea,select,summary,label,[role=button],[role=tab],[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=slider],[role=textbox],[role=listbox],[role=link],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1'])"; // etkileşimli eleman seçicisi
  const POPUP = "[role=listbox],[role=menu],[role=dialog],[role=alertdialog],[data-radix-popper-content-wrapper],[data-state=open]"; // açılır menü/diyalog seçicisi

  function deepAll(selector, root = document) { // shadow DOM dahil tüm eşleşen elemanları bulur
    const out = [...root.querySelectorAll(selector)]; // normal DOM'daki eşleşmeler
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) out.push(...deepAll(selector, el.shadowRoot)); }); // açık shadow root'ların içini de tara
    return out; // sonuç listesi
  } // deepAll sonu

  function visible(el) { // eleman ekranda görünür mü
    if (!el || !el.isConnected) return false; // DOM'da değilse görünmez
    const r = el.getBoundingClientRect(); // boyut ve konum
    if (r.width < 2 || r.height < 2) return false; // çok küçükse görünmez say
    const cs = getComputedStyle(el); // hesaplanmış stil
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05; // gizli/şeffaf değilse görünür
  } // visible sonu

  function nameOf(el) { // elemanın erişilebilir adını çıkarır
    const lb = el.getAttribute("aria-labelledby"); // aria-labelledby referansı
    const byId = lb ? lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ") : ""; // referans edilen elemanların metni
    const parts = [el.getAttribute("aria-label"), byId, el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.placeholder : "", (el.innerText || el.textContent || "").slice(0, 200), el.getAttribute("title"), el.getAttribute("alt"), el.getAttribute("data-tooltip")]; // olası ad kaynakları
    return [...new Set(parts.map((p) => (p || "").replace(/\s+/g, " ").trim()).filter(Boolean))].join(" | ").slice(0, 160); // tekrarsız birleştirip kısalt
  } // nameOf sonu

  function roleOf(el) { // elemanın rolünü belirler
    if (el.getAttribute("role")) return el.getAttribute("role"); // açık rol varsa onu kullan
    if (el.isContentEditable) return "textbox"; // düzenlenebilir alan metin kutusudur
    const t = el.tagName.toLowerCase(); // etiket adı
    if (t === "a") return "link"; // bağlantı
    if (t === "input") return `input:${el.type}`; // input türüyle birlikte
    return t; // diğerlerinde etiket adı
  } // roleOf sonu

  function refOf(el) { // elemana kalıcı bir ref kimliği atar
    let id = el.getAttribute("data-flowmcp-ref"); // önceden atanmış ref var mı
    if (!id || refs.get(id) !== el) { id = "e" + ++refSeq; el.setAttribute("data-flowmcp-ref", id); } // yoksa yeni ref üret ve elemana yaz
    refs.set(id, el); // haritaya kaydet
    return id; // ref'i döndür
  } // refOf sonu

  function stateOf(el) { // elemanın durum bilgilerini toplar
    const s = []; // durum listesi
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled"); // pasif mi
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true" || el.checked) s.push("selected"); // seçili mi
    if (el.getAttribute("aria-expanded") === "true") s.push("expanded"); // açık mı
    if (el.getAttribute("aria-haspopup")) s.push("popup"); // menü açar mı
    if (el.tagName === "INPUT" && el.type === "file") s.push(`accept=${el.accept || "*"}`); // dosya inputu ise kabul edilen türler
    if ("value" in el && el.value && el.type !== "file") s.push(`value="${String(el.value).slice(0, 60)}"`); // mevcut değer
    return s; // durum listesini döndür
  } // stateOf sonu

  function matcher(text, exact) { // metin veya /regex/ eşleştirici üretir
    if (text instanceof RegExp) return (s) => text.test(s); // zaten regex ise doğrudan kullan
    const m = /^\/(.+)\/([a-z]*)$/.exec(text || ""); // "/.../flags" biçimini yakala
    if (m) { const re = new RegExp(m[1], m[2] || "i"); return (s) => re.test(s) || re.test(norm(s)); } // regex eşleştirici
    const n = norm(text); // aranan metni sadeleştir
    return exact ? (s) => norm(s) === n || norm(s).split(" | ").includes(n) : (s) => norm(s).includes(n); // tam veya kısmi eşleştirici
  } // matcher sonu

  function resolve(p = {}) { // ref/selector/text parametresinden elemanı bulur
    if (p.ref) { const el = refs.get(p.ref) || document.querySelector(`[data-flowmcp-ref="${p.ref}"]`); if (!el || !el.isConnected) throw new Error(`Ref bulunamadı veya sayfadan kalktı: ${p.ref}. Yeni flow_snapshot al.`); return el; } // ref ile bul
    if (p.selector) { const el = deepAll(p.selector).filter((e) => !p.visibleOnly || visible(e))[p.index || 0]; if (!el) throw new Error(`Seçici eşleşmedi: ${p.selector}`); return el; } // CSS seçici ile bul
    if (p.text) { // metin ile bul
      const m = matcher(p.text, p.exact); // eşleştirici
      let c = deepAll(INTERACTIVE, p.within ? resolve({ ref: p.within }) : document).filter((e) => visible(e) && m(nameOf(e))); // değişti: within verildiyse sadece o elemanın içinde ara
      if (p.role) c = c.filter((e) => norm(roleOf(e)).includes(norm(p.role))); // rol filtresi
      c = c.filter((e) => !c.some((o) => o !== e && e.contains(o) && m(nameOf(o)))); // aynı eşleşmeyi içeren dış sarmalayıcıları ele, en içteki elemanı tercih et
      const el = c[p.index || 0]; // istenen sıradaki eleman
      if (!el) throw new Error(`"${p.text}" metnine sahip görünür eleman bulunamadı. flow_snapshot ile kontrol et.`); // bulunamadıysa hata
      return el; // elemanı döndür
    } // metin bloğu sonu
    throw new Error("ref, selector veya text parametrelerinden biri gerekli"); // hiçbiri verilmediyse hata
  } // resolve sonu

  function describe(el) { return { ref: refOf(el), role: roleOf(el), name: nameOf(el), state: stateOf(el) }; } // elemanı kısa nesne olarak özetler

  function fireClick(el) { // gerçek kullanıcı tıklamasını taklit eder
    el.scrollIntoView({ block: "center", inline: "center" }); // elemanı görünür alana kaydır
    const r = el.getBoundingClientRect(); // konum
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }; // olay seçenekleri
    el.dispatchEvent(new PointerEvent("pointerover", o)); el.dispatchEvent(new PointerEvent("pointerenter", o)); el.dispatchEvent(new MouseEvent("mouseover", o)); // üzerine gelme olayları
    el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new MouseEvent("mousedown", o)); // basma olayları (Radix menüleri pointerdown ile açılır)
    if (el.focus) el.focus({ preventScroll: true }); // odakla
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 })); // bırakma olayları
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 })); // tıklama olayı
  } // fireClick sonu

  function fireHover(el) { // fareyle üzerine gelmeyi taklit eder (video önizlemesi/indir butonları için)
    el.scrollIntoView({ block: "center" }); // görünür alana kaydır
    const r = el.getBoundingClientRect(); const o = { bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: "mouse" }; // olay seçenekleri
    ["pointerover", "pointerenter", "pointermove"].forEach((t) => el.dispatchEvent(new PointerEvent(t, o))); // pointer olayları
    ["mouseover", "mouseenter", "mousemove"].forEach((t) => el.dispatchEvent(new MouseEvent(t, o))); // mouse olayları
  } // fireHover sonu

  function setValue(el, value, clear = true) { // input/textarea/contenteditable alanına metin yazar
    el.scrollIntoView({ block: "center" }); el.focus(); // görünür yap ve odakla
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") { // klasik form alanı ise
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; // doğru prototip
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set; // React'in takip ettiği yerel value setter'ı
      setter.call(el, clear ? value : el.value + value); // değeri yerel setter ile ata
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); // React/Angular'ın değişikliği görmesi için olaylar
      return el.value === (clear ? value : el.value); // başarı durumu
    } // form alanı sonu
    const target = el.isContentEditable ? el : el.querySelector("[contenteditable=true],[contenteditable='']") || el; // zengin metin editörünün düzenlenebilir kısmı
    target.focus(); // odakla
    const sel = getSelection(); const range = document.createRange(); range.selectNodeContents(target); if (!clear) range.collapse(false); sel.removeAllRanges(); sel.addRange(range); // temizleme ise tümünü seç, değilse sona git
    let ok = document.execCommand("insertText", false, value); // editörlerin (Slate/Lexical/ProseMirror) en iyi anladığı yöntem
    if (!ok || !norm(target.innerText).includes(norm(value).slice(0, 30))) { // işe yaramadıysa
      const dt = new DataTransfer(); dt.setData("text/plain", value); // panodan yapıştırma verisi hazırla
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); // yapıştırma olayını dene
      ok = norm(target.innerText).includes(norm(value).slice(0, 30)); // sonucu kontrol et
    } // yedek 1 sonu
    if (!ok) { target.textContent = value; target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); ok = true; } // son çare: doğrudan metni yaz
    return ok; // başarı durumu
  } // setValue sonu

  function pressKey(key, el = document.activeElement || document.body, mods = {}) { // klavye tuşu olayı gönderir
    const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, " ": 32 }; // yaygın tuş kodları
    const o = { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: codes[key] || key.charCodeAt(0), which: codes[key] || key.charCodeAt(0), bubbles: true, cancelable: true, composed: true, ...mods }; // olay seçenekleri
    el.dispatchEvent(new KeyboardEvent("keydown", o)); el.dispatchEvent(new KeyboardEvent("keypress", o)); el.dispatchEvent(new KeyboardEvent("keyup", o)); // keydown/press/up sırası
  } // pressKey sonu

  function findPrompt() { // prompt yazılan ana metin kutusunu bulur
    const c = deepAll("textarea,[contenteditable=true],[contenteditable=''],[role=textbox],input[type=text]").filter(visible); // görünür metin alanları
    const kw = /prompt|istem|describe|acikla|olustur|create|imagine|hayal|yaz|type|ask|sor|ne gormek|what|video|gorsel|image|tanimla/; // prompt kutusu yer tutucularında geçen kelimeler
    const score = (e) => { const r = e.getBoundingClientRect(); return (kw.test(norm(nameOf(e))) ? 1e6 : 0) + (e.tagName === "TEXTAREA" || e.isContentEditable ? 5e5 : 0) + r.width * Math.min(r.height, 200) + (e.closest(POPUP) ? -2e6 : 0); }; // anahtar kelime, tür ve boyuta göre puan, popup içindekilere ceza
    return c.sort((a, b) => score(b) - score(a))[0] || null; // en yüksek puanlıyı döndür
  } // findPrompt sonu

  function findSubmit(promptEl) { // prompt'u gönderen butonu bulur
    const pr = promptEl?.getBoundingClientRect(); // prompt kutusunun konumu
    const strong = /^(olustur|create|generate|gonder|send|submit|uret|go|run|calistir)$|arrow_forward|arrow_upward|send|north|spark/; // gönder butonlarında geçen metin/ikonlar
    const c = deepAll("button,[role=button]").filter((b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !b.closest(POPUP)); // görünür, aktif, popup dışı butonlar
    const score = (b) => { const n = norm(nameOf(b)); const r = b.getBoundingClientRect(); let s = 0; if (n.split(" | ").some((x) => strong.test(x)) || strong.test(n)) s += 1000; if (b.type === "submit") s += 300; if (pr) s -= Math.hypot(r.left - pr.right, r.top - pr.bottom) / 2; return s; }; // anahtar kelime + prompt'a yakınlık puanı
    const best = c.sort((a, b) => score(b) - score(a))[0]; // en iyi aday
    return best && score(best) > 500 ? best : null; // yeterince eminsek döndür
  } // findSubmit sonu

  function popupOptions() { // açık menülerdeki/listelerdeki seçenekleri döndürür
    return deepAll("[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=radio],[role=tab],button,li,[role=button],label").filter(visible); // görünür seçenek adayları
  } // popupOptions sonu

  function pickOption(value, preferPopup, exactOnly = false) { // değişti: exactOnly=true ise sadece birebir eşleşen seçenek döner
    const m = matcher(value, true), mi = matcher(value, false); // tam ve kısmi eşleştiriciler
    let c = popupOptions(); // tüm adaylar
    if (preferPopup) { const inPop = c.filter((e) => e.closest(POPUP)); if (inPop.length) c = inPop; } // menü açıksa önce menünün içine bak
    const exact = c.filter((e) => m(nameOf(e))); // tam eşleşenler
    const list = exact.length || exactOnly ? exact : c.filter((e) => mi(nameOf(e))); // değişti: exactOnly değilse ve tam eşleşme yoksa kısmi eşleşenler
    const inner = list.filter((e) => !list.some((o) => o !== e && e.contains(o))); // en içteki elemanlar
    return inner.sort((a, b) => nameOf(a).length - nameOf(b).length)[0] || null; // en kısa adlı (en spesifik) olanı seç
  } // pickOption sonu

  async function applyChoice({ value, hints = [] }) { // tek bir ayarı (mod, oran, model vb.) uygular
    const isTrigger = (e) => e.getAttribute("aria-haspopup") || roleOf(e) === "combobox" || e.tagName === "SELECT"; // açılır menü tetikleyicisi mi
    const triggers = () => deepAll(INTERACTIVE).filter((e) => visible(e) && isTrigger(e) && !e.closest("[role=menu],[role=listbox]")); // görünür tetikleyiciler
    const hm = hints.map((h) => matcher(h, false)); const vm = matcher(value, false); // ipucu ve değer eşleştiricileri
    for (let attempt = 0; attempt < 2; attempt++) { // değişti: 2 tur (ikinci tur ayar paneli açıldıktan sonra)
      const trig = hm.length ? triggers().find((t) => hm.some((h) => h(nameOf(t)))) : null; // değişti: ipucuyla (ör. "aspect", "model") eşleşen açılır menü tetikleyicisi
      if (trig && vm(nameOf(trig))) return { value, status: "already", control: describe(trig) }; // değişti: tetikleyici zaten bu değeri gösteriyorsa ayar seçili demektir
      const shown = !hm.length ? triggers().find((t) => matcher(value, true)(nameOf(t))) : null; // değişti: ipucu yoksa değeri birebir gösteren tetikleyici var mı
      if (shown) return { value, status: "already", control: describe(shown) }; // değişti: zaten seçili
      const direct = pickOption(value, false, true); // değişti: ekranda birebir adıyla duran seçenek (sekme/segment/radyo) var mı
      if (direct && !isTrigger(direct) && !trig) { fireClick(direct); await sleep(400); return { value, status: "clicked", control: describe(direct) }; } // değişti: menü yoksa doğrudan seçeneğe tıkla
      if (trig) { // tetikleyici bulunduysa
        if (trig.tagName === "SELECT") { const o = [...trig.options].find((o) => vm(o.text) || vm(o.value)); if (o) { trig.value = o.value; trig.dispatchEvent(new Event("change", { bubbles: true })); return { value, status: "selected", control: describe(trig) }; } } // yerel select ise doğrudan seç
        fireClick(trig); await sleep(500); // menüyü aç ve bekle
        const opt = pickOption(value, true); // menüde değeri ara
        if (opt) { fireClick(opt); await sleep(400); if (deepAll("[role=menu],[role=listbox]").some(visible)) pressKey("Escape"); return { value, status: "selected", control: describe(trig) }; } // değişti: seçimden sonra açık kalan liste menüsünü kapat
        pressKey("Escape"); await sleep(200); // bulunamadıysa menüyü kapat
      } // tetikleyici bloğu sonu
      if (direct && !isTrigger(direct)) { fireClick(direct); await sleep(400); return { value, status: "clicked", control: describe(direct) }; } // doğrudan seçenek varsa onu tıkla
      const opener = deepAll("button,[role=button]").filter(visible).find((b) => /ayar|setting|tune|secenek|options|more_vert|more_horiz|yapilandir|config/.test(norm(nameOf(b))) && !b.closest(POPUP)); // ayar panelini açan buton
      if (!opener || attempt >= 1) break; // değişti: açıcı yoksa veya ikinci tur da bittiyse çık
      fireClick(opener); await sleep(600); // ayar panelini aç ve tekrar dene
    } // deneme döngüsü sonu
    return { value, status: "not_found", hint: "flow_snapshot ile ayar kontrolünü bulup flow_click kullan" }; // başarısız sonuç
  } // applyChoice sonu

  function b64ToFile({ name, mime, base64 }) { // base64 paketini File nesnesine çevirir
    const bin = atob(base64); const bytes = new Uint8Array(bin.length); // ikili veri tamponu
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); // baytları doldur
    return new File([bytes], name, { type: mime, lastModified: Date.now() }); // File nesnesi
  } // b64ToFile sonu

  function setFiles(input, files) { // dosya inputuna dosyaları atar
    const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); // DataTransfer ile FileList oluştur
    input.files = dt.files; // inputa ata
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); // uygulamanın fark etmesi için olaylar
  } // setFiles sonu

  function dropFiles(target, files) { // dosyaları sürükle-bırak ile hedefe bırakır
    const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); // sürükleme verisi
    const r = target.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; // olay seçenekleri
    ["dragenter", "dragover", "drop"].forEach((t) => target.dispatchEvent(new DragEvent(t, o))); // sürükle-bırak olay sırası
  } // dropFiles sonu

  function pickFileInput(mime, scope) { // MIME tipine uygun dosya inputunu seçer
    const all = deepAll("input[type=file]", scope || document); // tüm dosya inputları (gizliler dahil)
    const kind = (mime || "").split("/")[0]; // image / video
    const ok = (i) => !i.accept || i.accept.split(",").some((a) => { a = a.trim(); return a === mime || a === `${kind}/*` || a === "*/*" || (a.startsWith(".") && mime.includes(a.slice(1))); }); // accept uyumlu mu
    return all.filter(ok).sort((a, b) => (b.accept.includes(kind) ? 1 : 0) - (a.accept.includes(kind) ? 1 : 0))[0] || null; // türü açıkça kabul edeni öne al
  } // pickFileInput sonu

  let pendingChooser = null; // dosya seçici yakalama bekleyicisi
  document.addEventListener("click", (e) => { // sayfadaki tıklamaları yakala (yakalama fazı)
    const t = e.target; // tıklanan eleman
    if (pendingChooser && t instanceof HTMLInputElement && t.type === "file") { e.preventDefault(); e.stopImmediatePropagation(); const f = pendingChooser; pendingChooser = null; f(t); } // dosya diyaloğunun açılmasını engelle ve inputu yakala
  }, true); // capture=true

  async function upload({ files, ref, selector, text, method = "auto" }) { // referans dosyalarını yükler
    const fl = files.map(b64ToFile); // base64 -> File
    const mime = fl[0]?.type || ""; // ilk dosyanın tipi
    let target = ref || selector || text ? resolve({ ref, selector, text }) : null; // kullanıcı hedef verdiyse bul
    if (method === "paste") { const pt = target || findPrompt(); const dt = new DataTransfer(); fl.forEach((f) => dt.items.add(f)); pt.focus(); pt.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return { method: "paste", target: describe(pt), count: fl.length }; } // yapıştırma yöntemi
    if (method === "drop") { const dt = target || findPrompt() || document.body; dropFiles(dt, fl); return { method: "drop", target: describe(dt), count: fl.length }; } // bırakma yöntemi
    if (target && target.matches("input[type=file]")) { setFiles(target, fl); return { method: "input", target: describe(target), count: fl.length }; } // hedef zaten dosya inputu
    if (target) { // hedef bir buton/alan ise
      const near = pickFileInput(mime, target.closest("form,section,[role=dialog]") || target.parentElement?.parentElement || document); // yakınında dosya inputu ara
      if (near && method !== "click") { setFiles(near, fl); return { method: "input-near", target: describe(near), count: fl.length }; } // bulunduysa onu kullan
      const caught = new Promise((res) => { pendingChooser = res; setTimeout(() => { if (pendingChooser === res) { pendingChooser = null; res(null); } }, 4000); }); // dosya seçici açılışını yakalamaya hazırlan
      fireClick(target); // hedefe tıkla
      const input = await caught; // yakalanan input
      if (input) { setFiles(input, fl); return { method: "chooser-intercept", target: describe(target), count: fl.length }; } // diyalog yerine dosyaları ata
      await sleep(500); const late = pickFileInput(mime); if (late) { setFiles(late, fl); return { method: "input-after-click", target: describe(late), count: fl.length }; } // tıklamadan sonra oluşan inputu dene
      dropFiles(target, fl); return { method: "drop-fallback", target: describe(target), count: fl.length }; // son çare: hedefe bırak
    } // hedefli blok sonu
    const input = pickFileInput(mime); // hedef yoksa sayfadaki uygun inputu bul
    if (input) { setFiles(input, fl); return { method: "input-auto", target: describe(input), count: fl.length }; } // bulunduysa kullan
    const addBtn = deepAll("button,[role=button]").filter(visible).find((b) => /add_photo|add_a_photo|image|upload|yukle|ekle|add|referans|reference|attach|ekler|malzeme|ingredient|^\+$/.test(norm(nameOf(b))) && !b.closest(POPUP)); // ekleme butonu ara
    if (addBtn) return upload({ files, ref: refOf(addBtn), method: "click" }); // butonla tekrar dene
    const pt = findPrompt(); if (pt) { dropFiles(pt, fl); return { method: "drop-prompt", target: describe(pt), count: fl.length }; } // prompt kutusuna bırak
    throw new Error("Dosya yükleme alanı bulunamadı. flow_snapshot ile yükleme butonunu bulup 'target' olarak ver."); // hiçbir yol yoksa hata
  } // upload sonu

  function mediaKey(src) { if (!src) return ""; if (src.startsWith("data:")) return "data:" + src.length + ":" + src.slice(-48); if (src.startsWith("blob:")) return src; try { const u = new URL(src); return u.origin + u.pathname; } catch { return src; } } // medya için sorgu parametresiz kalıcı anahtar üretir

  function tileLabel(el) { // medyanın bulunduğu kartın açıklamasını bulur
    let e = el; for (let i = 0; i < 6 && e; i++, e = e.parentElement) { const l = e.getAttribute?.("aria-label") || e.getAttribute?.("title"); if (l) return l.slice(0, 200); } // yukarı doğru aria-label ara
    return (el.closest("figure,article,li,[role=listitem],[role=gridcell]")?.innerText || "").replace(/\s+/g, " ").slice(0, 200); // yoksa kart metnini kullan
  } // tileLabel sonu

  function listMedia({ minSize = 96, kind } = {}) { // sayfadaki video ve görselleri listeler
    const out = []; // sonuç listesi
    for (const v of deepAll("video")) { // her video için
      const src = v.currentSrc || v.src || v.querySelector("source")?.src || ""; // video kaynağı
      const r = v.getBoundingClientRect(); // boyut
      if (!src && !v.poster) continue; // kaynağı olmayanı atla
      out.push({ ref: refOf(v), kind: "video", key: mediaKey(src || v.poster), src: src.startsWith("data:") ? `(data url ${src.length} chars)` : src, poster: v.poster || "", width: v.videoWidth || Math.round(r.width), height: v.videoHeight || Math.round(r.height), duration: isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null, visible: visible(v), label: tileLabel(v) }); // video bilgisi
    } // video döngüsü sonu
    for (const img of deepAll("img")) { // her görsel için
      const src = img.currentSrc || img.src || ""; const r = img.getBoundingClientRect(); // kaynak ve boyut
      if (!src || src.endsWith(".svg") || (Math.max(r.width, r.height) < minSize && Math.max(img.naturalWidth, img.naturalHeight) < 256)) continue; // ikon ve küçük görselleri atla
      if (/googleusercontent\.com\/a\/|\/photo\.jpg|avatar|logo/i.test(src)) continue; // profil fotoğrafı/logo gibi görselleri atla
      out.push({ ref: refOf(img), kind: "image", key: mediaKey(src), src: src.startsWith("data:") ? `(data url ${src.length} chars)` : src, width: img.naturalWidth, height: img.naturalHeight, alt: img.alt || "", visible: visible(img), label: tileLabel(img) }); // görsel bilgisi
    } // görsel döngüsü sonu
    return kind ? out.filter((m) => m.kind === kind) : out; // tür filtresi uygula
  } // listMedia sonu

  async function mediaToBase64({ ref, src }) { // blob:/data: medya içeriğini base64 olarak okur
    let url = src; if (ref) { const el = resolve({ ref }); url = el.currentSrc || el.src || el.querySelector?.("source")?.src; } // ref verildiyse kaynağı al
    const res = await fetch(url, { credentials: "include" }); // içeriği indir (sayfa bağlamında, çerezlerle)
    const blob = await res.blob(); // blob'a çevir
    const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); }); // blob -> base64
    return { mime: blob.type, size: blob.size, base64: b64 }; // sonucu döndür
  } // mediaToBase64 sonu

  function status() { // üretim durumu: ilerleme, uyarı ve hata metinlerini toplar
    const progress = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); // metin düğümlerini gezmek için walker
    for (let n; (n = walker.nextNode()) && progress.length < 20;) { const t = n.nodeValue.trim(); if (/^\d{1,3}\s?%$/.test(t) && n.parentElement && visible(n.parentElement)) progress.push(t); } // görünür yüzde ifadelerini topla
    const busy = deepAll("[role=progressbar],[aria-busy=true],[class*=spinner],[class*=loading],[class*=Loading],[class*=progress]").filter(visible).length; // yükleniyor göstergeleri
    const alerts = deepAll("[role=alert],[role=status],[aria-live=assertive],[aria-live=polite]").filter(visible).map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10); // uyarı/bildirim metinleri
    const failRe = /basarisiz|failed|hata|error|politika|policy|violat|ihlal|kota|quota|limit|yeterli kredi|credits|could not|unable|olusturulamadi/; // hata kelimeleri
    const failures = deepAll("div,span,p").filter((e) => e.childElementCount === 0 && failRe.test(norm(e.innerText)) && e.innerText.length < 300 && visible(e)).map((e) => e.innerText.trim()).slice(0, 10); // görünür hata mesajları
    return { url: location.href, title: document.title, progress, busyIndicators: busy, alerts, failures }; // durum nesnesi
  } // status sonu

  function snapshot({ query, limit = 250, includeText = false } = {}) { // sayfanın etkileşimli eleman listesini çıkarır
    const m = query ? matcher(query, false) : null; // filtre varsa eşleştirici
    const els = deepAll(INTERACTIVE + ",video,[role=dialog],[role=heading],h1,h2,h3").filter(visible); // görünür etkileşimli elemanlar + başlıklar + diyaloglar
    const lines = []; // çıktı satırları
    for (const el of els) { // her eleman için
      if (el.matches("label") && el.querySelector("input,button")) continue; // içinde kontrol olan label'ı tekrar gösterme
      const name = nameOf(el); if (m && !m(name) && !m(roleOf(el))) continue; // filtreye uymayanı atla
      const st = stateOf(el); const inPop = el.closest(POPUP) ? " [popup]" : ""; // durum ve popup işareti
      lines.push(`[${refOf(el)}] ${roleOf(el)} "${name}"${st.length ? " (" + st.join(", ") + ")" : ""}${inPop}`); // satırı ekle
      if (lines.length >= limit) { lines.push(`... (${els.length - limit}+ eleman daha, 'query' ile filtrele)`); break; } // limit dolduysa kes
    } // döngü sonu
    deepAll("input[type=file]").forEach((i) => lines.push(`[${refOf(i)}] input:file (hidden) (${stateOf(i).join(", ")})`)); // gizli dosya inputlarını da göster
    const pr = findPrompt(); // prompt kutusu tahmini
    return { url: location.href, title: document.title, promptRef: pr ? refOf(pr) : null, elements: lines.join("\n"), text: includeText ? document.body.innerText.replace(/\n{2,}/g, "\n").slice(0, 6000) : undefined }; // snapshot sonucu
  } // snapshot sonu

  async function waitFor({ text, selector, gone = false, timeout = 15000 }) { // bir metin/seçici görünene (veya kaybolana) kadar bekler
    const end = Date.now() + Math.min(timeout, 55000); // bitiş zamanı (mesaj kanalı için en fazla 55 sn)
    const m = text ? matcher(text, false) : null; // metin eşleştirici
    while (Date.now() < end) { // süre dolana kadar
      const found = selector ? deepAll(selector).some(visible) : m(document.body.innerText) || deepAll("[aria-label]").some((e) => visible(e) && m(e.getAttribute("aria-label"))); // var mı kontrol et
      if (found !== gone) return { ok: true }; // istenen duruma ulaşıldı
      await sleep(400); // biraz bekle
    } // döngü sonu
    return { ok: false }; // zaman aşımı
  } // waitFor sonu

  function containerOf(el, levels = 6) { // medya kartı gibi kapsayıcıyı bulur
    let e = el; for (let i = 0; i < levels && e.parentElement; i++) { e = e.parentElement; if (e.querySelectorAll("button,[role=button]").length >= 1 && e.getBoundingClientRect().width > el.getBoundingClientRect().width * 0.9) return e; } // içinde buton olan ilk geniş ebeveyn
    return el.parentElement || el; // bulunamazsa doğrudan ebeveyn
  } // containerOf sonu

  const actions = { // arka plandan çağrılabilen eylemler tablosu
    ping: () => ({ url: location.href, title: document.title }), // canlılık testi
    snapshot, // eleman listesi
    status, // üretim durumu
    listMedia, // medya listesi
    mediaToBase64, // medya içeriği
    upload, // dosya yükleme
    waitFor, // bekleme
    click: (p) => { const el = resolve(p); fireClick(el); return describe(el); }, // tıklama
    hover: (p) => { const el = resolve(p); fireHover(el); return describe(el); }, // üzerine gelme
    rect: (p) => { const el = resolve(p); el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { ...describe(el), x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio }; }, // CDP tıklaması için koordinat
    type: (p) => { const el = p.ref || p.selector || p.text ? resolve(p) : document.activeElement; const ok = setValue(el, p.value, p.clear !== false); if (p.pressEnter) pressKey("Enter", el); return { ...describe(el), ok }; }, // metin yazma
    key: (p) => { const el = p.ref ? resolve(p) : document.activeElement || document.body; pressKey(p.key, el, { ctrlKey: !!p.ctrl, shiftKey: !!p.shift, altKey: !!p.alt, metaKey: !!p.meta }); return { key: p.key }; }, // tuş basma
    scroll: (p) => { const el = p.ref ? resolve(p) : null; const dy = p.direction === "up" ? -1 : 1; if (el && p.intoView) el.scrollIntoView({ block: "center" }); else (el || window).scrollBy({ top: dy * (p.amount || 700), behavior: "instant" }); return { ok: true }; }, // değişti: ref varsa elemanı, yoksa pencereyi kaydır
    setPrompt: (p) => { const el = p.ref ? resolve(p) : findPrompt(); if (!el) throw new Error("Prompt kutusu bulunamadı. Bir proje açık mı? flow_snapshot ile kontrol et."); const ok = setValue(el, p.text, p.clear !== false); return { ...describe(el), ok }; }, // prompt yazma
    submit: (p) => { const pr = p.promptRef ? resolve({ ref: p.promptRef }) : findPrompt(); const btn = p.ref || p.text ? resolve(p) : findSubmit(pr); if (btn) { fireClick(btn); return { method: "button", button: describe(btn) }; } if (!pr) throw new Error("Gönder butonu ve prompt kutusu bulunamadı"); pr.focus(); pressKey("Enter", pr); return { method: "enter", prompt: describe(pr) }; }, // prompt'u gönderme
    applyChoice, // tek ayar uygulama
    clickWithin: async (p) => { const base = resolve({ ref: p.ref }); const box = containerOf(base); fireHover(base); fireHover(box); await sleep(500); const m = matcher(p.text, false); const btn = deepAll("button,[role=button],a,[role=menuitem]", box).find((b) => m(nameOf(b))); if (!btn) throw new Error(`Kart içinde "${p.text}" butonu bulunamadı`); fireClick(btn); return describe(btn); }, // medya kartı içindeki butona tıklama
    markFileInput: (p) => { const el = p.ref || p.selector ? resolve(p) : pickFileInput(p.mime || ""); if (!el) return null; return describe(el); }, // CDP yükleme için dosya inputunu işaretler
  }; // eylem tablosu sonu

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => { // arka plandan gelen mesajları dinle
    if (!msg || msg.__flowmcp !== true) return; // bize ait değilse yok say
    const fn = actions[msg.action]; // eylemi bul
    if (!fn) { sendResponse({ ok: false, error: `Bilinmeyen eylem: ${msg.action}` }); return; } // yoksa hata
    Promise.resolve().then(() => fn(msg.params || {})).then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e?.message || String(e) })); // eylemi çalıştırıp sonucu gönder
    return true; // asenkron cevap vereceğimizi bildir
  }); // dinleyici sonu
})(); // IIFE sonu
