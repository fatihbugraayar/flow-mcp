// files.js — dosya okuma/yazma, MIME tespiti ve indirme klasörü yardımcıları // dosyanın amacı
import fs from "node:fs"; // dosya sistemi modülü
import path from "node:path"; // yol işlemleri modülü
import os from "node:os"; // kullanıcı ana dizini için işletim sistemi modülü

export const DATA_DIR = process.env.FLOW_MCP_DATA_DIR || path.join(os.homedir(), ".flow-mcp"); // karakter kütüphanesi gibi verilerin tutulacağı klasör
export const DOWNLOAD_DIR = process.env.FLOW_MCP_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads", "flow-mcp"); // indirilen video/görsellerin varsayılan klasörü

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".wav": "audio/wav" }; // uzantı -> MIME tablosu
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e])); // MIME -> uzantı ters tablosu
EXT["image/jpeg"] = ".jpg"; // jpeg için tercih edilen uzantı .jpg

export function mimeOf(p) { return MIME[path.extname(p).toLowerCase()] || "application/octet-stream"; } // dosya yolundan MIME tipini bulur
export function extOf(mime, fallback = ".bin") { return EXT[(mime || "").split(";")[0].trim()] || fallback; } // MIME tipinden uzantı bulur

export function resolveInput(p) { // kullanıcı yolunu mutlak yola çevirip varlığını kontrol eder
  const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir())); // ~ işaretini ana dizine çevirip mutlak yap
  if (!fs.existsSync(abs)) throw new Error(`Dosya bulunamadı: ${abs}`); // yoksa hata ver
  return abs; // mutlak yolu döndür
} // resolveInput sonu

export function readAsPayload(p) { // dosyayı eklentiye gönderilecek base64 paketine çevirir
  const abs = resolveInput(p); // yolu doğrula
  const buf = fs.readFileSync(abs); // dosyayı oku
  return { name: path.basename(abs), mime: mimeOf(abs), size: buf.length, path: abs, base64: buf.toString("base64") }; // ad, tip, boyut, yol ve içerik
} // readAsPayload sonu

export function saveBase64(base64, { dir = DOWNLOAD_DIR, filename, mime } = {}) { // base64 içeriği diske yazar
  fs.mkdirSync(dir, { recursive: true }); // hedef klasörü oluştur
  let name = filename || `flow-${new Date().toISOString().replace(/[:.]/g, "-")}`; // dosya adı verilmediyse zaman damgalı ad üret
  if (!path.extname(name)) name += extOf(mime, ".bin"); // uzantı yoksa MIME'a göre ekle
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_"); // Windows'ta geçersiz karakterleri temizle
  let full = path.join(dir, name); // tam yol
  for (let i = 1; fs.existsSync(full); i++) full = path.join(dir, `${path.parse(name).name}-${i}${path.extname(name)}`); // aynı adda dosya varsa numara ekle
  fs.writeFileSync(full, Buffer.from(base64, "base64")); // dosyayı yaz
  return full; // kaydedilen yolu döndür
} // saveBase64 sonu
