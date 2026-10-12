// characters.js — tutarlı karakterler için lokal karakter kütüphanesi // dosyanın amacı
import fs from "node:fs"; // dosya sistemi modülü
import path from "node:path"; // yol işlemleri modülü
import { DATA_DIR, resolveInput } from "./files.js"; // veri klasörü ve yol doğrulama yardımcısı

const FILE = path.join(DATA_DIR, "characters.json"); // kütüphanenin saklandığı JSON dosyası
const IMG_DIR = path.join(DATA_DIR, "characters"); // karakter referans görsellerinin kopyalandığı klasör

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } } // kütüphaneyi oku, yoksa boş nesne döndür
function save(db) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } // kütüphaneyi diske yaz
const key = (n) => n.trim().toLowerCase(); // karakter adını büyük/küçük harf duyarsız anahtara çevir

export function upsertCharacter({ name, description = "", imagePaths = [], notes = "" }) { // karakter ekler veya günceller
  const db = load(); // mevcut kütüphaneyi yükle
  const old = db[key(name)] || { images: [] }; // varsa eski kaydı al
  const dir = path.join(IMG_DIR, key(name).replace(/[^a-z0-9ğüşöçı_-]+/gi, "_")); // karaktere özel görsel klasörü
  fs.mkdirSync(dir, { recursive: true }); // klasörü oluştur
  const copied = imagePaths.map((p) => { // her referans görseli
    const src = resolveInput(p); // yolu doğrula
    const dst = path.join(dir, path.basename(src)); // hedef yol
    if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst); // kütüphane klasörüne kopyala (zaten oradaysa atla)
    return dst; // yeni yolu döndür
  }); // map sonu
  db[key(name)] = { name: name.trim(), description: description || old.description || "", notes: notes || old.notes || "", images: [...new Set([...old.images, ...copied])], updatedAt: new Date().toISOString() }; // kaydı birleştirerek güncelle
  save(db); // kaydet
  return db[key(name)]; // güncel kaydı döndür
} // upsertCharacter sonu

export function getCharacter(name) { // ada göre karakter getirir
  const c = load()[key(name)]; // kaydı bul
  if (!c) throw new Error(`Karakter bulunamadı: ${name}. Önce flow_character_create ile oluştur.`); // yoksa hata
  c.images = c.images.filter((p) => fs.existsSync(p)); // silinmiş görselleri listeden çıkar
  return c; // kaydı döndür
} // getCharacter sonu

export function listCharacters() { return Object.values(load()); } // tüm karakterleri liste olarak döndürür

export function deleteCharacter(name) { // karakteri kütüphaneden siler
  const db = load(); // kütüphaneyi yükle
  if (!db[key(name)]) return false; // yoksa false
  delete db[key(name)]; save(db); return true; // sil, kaydet, true döndür
} // deleteCharacter sonu
