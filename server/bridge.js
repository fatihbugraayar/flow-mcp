// bridge.js — MCP sunucusu ile Chrome eklentisi arasındaki WebSocket köprüsü // dosyanın amacı
import { WebSocketServer, WebSocket } from "ws"; // ws kütüphanesinden sunucu ve istemci sınıflarını alıyoruz

const log = (...a) => console.error("[flow-mcp:bridge]", ...a); // stdout MCP'ye ait olduğu için logları stderr'e yazıyoruz

export class Bridge { // köprü sınıfı: ya birincil (sunucu) ya da ikincil (relay istemcisi) olarak çalışır
  constructor(port) { // kurucu: dinlenecek portu alır
    this.port = port; // portu saklıyoruz
    this.ext = null; // bağlı eklentinin soket nesnesi (birincil moddayken)
    this.extInfo = null; // eklentinin gönderdiği hello bilgisi
    this.pending = new Map(); // cevap bekleyen komutlar: id -> {resolve, reject, timer}
    this.seq = 0; // komut kimliği sayacı
    this.mode = "starting"; // mevcut çalışma modu: starting | primary | relay
    this.upstream = null; // relay modunda birincil sunucuya açılan soket
    this.waiters = []; // eklenti bağlanınca uyandırılacak bekleyiciler
  } // kurucu sonu

  start() { // köprüyü başlatır
    return new Promise((resolve) => { // başlatma tamamlanınca çözülen söz
      const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port, maxPayload: 1024 * 1024 * 1024 }); // sadece localhost'ta, 1GB'a kadar mesaj kabul eden sunucu
      wss.on("listening", () => { this.mode = "primary"; this.wss = wss; log(`ws://127.0.0.1:${this.port} dinleniyor`); resolve(); }); // dinleme başlarsa birincil moda geç
      wss.on("error", (err) => { // sunucu hatası olursa
        if (err.code === "EADDRINUSE") { log("port dolu, mevcut flow-mcp sunucusuna relay olarak bağlanılıyor"); this.startRelay(); resolve(); } // port doluysa başka bir flow-mcp var, ona bağlan
        else { log("ws hatası", err.message); resolve(); } // diğer hatalarda sadece logla
      }); // error dinleyicisi sonu
      wss.on("connection", (sock) => this.onConnection(sock)); // yeni bağlantıları işleyiciye yönlendir
      setInterval(() => this.ping(), 20000); // 20 saniyede bir ping atıp eklentinin service worker'ını canlı tutuyoruz
    }); // söz sonu
  } // start sonu

  onConnection(sock) { // yeni bir WebSocket bağlantısı geldiğinde
    sock.role = "unknown"; // rol hello mesajı gelene kadar bilinmiyor
    sock.on("message", (raw) => { // mesaj gelince
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; } // JSON değilse yok say
      if (msg.type === "hello" && msg.role === "extension") { // eklenti kendini tanıttıysa
        sock.role = "extension"; // soket rolünü işaretle
        if (this.ext && this.ext !== sock) try { this.ext.close(); } catch {} // eski eklenti bağlantısı varsa kapat
        this.ext = sock; this.extInfo = msg; // yeni eklentiyi kaydet
        log("eklenti bağlandı", msg.version || ""); // logla
        this.waiters.splice(0).forEach((w) => w()); // eklentiyi bekleyenleri uyandır
        return; // işlem tamam
      } // eklenti hello sonu
      if (msg.type === "hello" && msg.role === "peer") { sock.role = "peer"; return; } // başka bir flow-mcp örneği relay olarak bağlandı
      if (msg.type === "pong") return; // ping cevabı, bir şey yapma
      if (sock.role === "peer" && msg.type === "cmd") { // relay'den gelen komutu eklentiye ilet
        this.call(msg.action, msg.params, msg.timeout) // komutu kendi eklenti bağlantımız üzerinden çalıştır
          .then((result) => sock.send(JSON.stringify({ id: msg.id, ok: true, result }))) // başarılıysa relay'e sonucu yolla
          .catch((e) => sock.send(JSON.stringify({ id: msg.id, ok: false, error: e.message }))); // hata varsa relay'e hatayı yolla
        return; // işlem tamam
      } // relay komut sonu
      if (sock.role === "extension" && msg.id != null) this.settle(msg); // eklentiden gelen cevabı ilgili bekleyene ulaştır
    }); // message dinleyicisi sonu
    sock.on("close", () => { if (this.ext === sock) { this.ext = null; log("eklenti bağlantısı koptu"); } }); // eklenti koparsa referansı temizle
  } // onConnection sonu

  startRelay() { // relay modunu başlatır (port başka bir flow-mcp tarafından kullanılıyorsa)
    this.mode = "relay"; // modu işaretle
    const connect = () => { // bağlanma fonksiyonu
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: 1024 * 1024 * 1024 }); // birincil sunucuya bağlan
      ws.on("open", () => { this.upstream = ws; ws.send(JSON.stringify({ type: "hello", role: "peer" })); log("birincil sunucuya bağlanıldı"); }); // bağlanınca kendini peer olarak tanıt
      ws.on("message", (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.id != null) this.settle(m); }); // gelen cevapları bekleyenlere dağıt
      ws.on("close", () => { this.upstream = null; setTimeout(connect, 2000); }); // koparsa 2 sn sonra yeniden dene
      ws.on("error", () => {}); // hata olayını yut, close zaten tetiklenecek
    }; // connect sonu
    connect(); // ilk bağlantıyı başlat
  } // startRelay sonu

  settle(msg) { // gelen cevabı ilgili söze bağlar
    const p = this.pending.get(msg.id); if (!p) return; // bekleyen yoksa çık
    this.pending.delete(msg.id); clearTimeout(p.timer); // bekleyeni listeden sil ve zamanlayıcıyı iptal et
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "Bilinmeyen eklenti hatası")); // başarıya göre çöz ya da reddet
  } // settle sonu

  ping() { // eklentiye uygulama seviyesi ping atar
    if (this.ext && this.ext.readyState === WebSocket.OPEN) this.ext.send(JSON.stringify({ type: "ping" })); // bağlıysa ping gönder
  } // ping sonu

  isConnected() { // eklentiye ulaşılabilir mi
    if (this.mode === "relay") return !!this.upstream; // relay modunda birincile bağlı olmak yeterli
    return !!(this.ext && this.ext.readyState === WebSocket.OPEN); // birincil modda eklenti soketi açık olmalı
  } // isConnected sonu

  waitForExtension(ms = 15000) { // eklenti bağlanana kadar belirli süre bekler
    if (this.isConnected()) return Promise.resolve(true); // zaten bağlıysa hemen dön
    return new Promise((resolve) => { // bekleme sözü
      const t = setTimeout(() => resolve(this.isConnected()), ms); // süre dolunca mevcut durumu döndür
      this.waiters.push(() => { clearTimeout(t); resolve(true); }); // bağlantı gelirse erken çöz
    }); // söz sonu
  } // waitForExtension sonu

  async call(action, params = {}, timeout = 60000) { // eklentiye komut gönderip cevabını bekler
    if (!(await this.waitForExtension())) // eklenti 15 sn içinde bağlanmazsa
      throw new Error("Chrome eklentisi bağlı değil. Chrome'da 'Flow MCP Bridge' eklentisinin yüklü ve açık olduğundan emin ol (README'ye bak)."); // açıklayıcı hata fırlat
    const id = ++this.seq + "-" + Date.now(); // benzersiz komut kimliği üret
    const sock = this.mode === "relay" ? this.upstream : this.ext; // komutun gideceği soketi seç
    return new Promise((resolve, reject) => { // cevap sözü
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Zaman aşımı: ${action} (${timeout} ms)`)); }, timeout); // zaman aşımı zamanlayıcısı
      this.pending.set(id, { resolve, reject, timer }); // bekleyenler listesine ekle
      sock.send(JSON.stringify({ id, type: "cmd", action, params, timeout })); // komutu gönder
    }); // söz sonu
  } // call sonu
} // Bridge sınıfı sonu
