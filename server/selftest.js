// selftest.js — MCP sunucusu, araçlar ve dosya yardımcıları için otomatik test betiği // dosyanın amacı
import assert from "node:assert"; // doğrulama modülü
import fs from "node:fs"; // dosya sistemi modülü
import path from "node:path"; // yol modülü
import { DATA_DIR, DOWNLOAD_DIR, resolveInput, mimeOf, extOf, saveBase64 } from "./files.js"; // dosya modülü fonksiyonları
import { upsertCharacter, getCharacter, listCharacters, deleteCharacter } from "./characters.js"; // karakter kütüphanesi fonksiyonları

console.log("[TEST] Dosya yardımcıları test ediliyor..."); // bilgi mesajı

// MIME ve uzantı testleri // test başlığı
assert.strictEqual(mimeOf("video.mp4"), "video/mp4", "MP4 MIME tespiti doğru olmalı"); // mp4 kontrolü
assert.strictEqual(mimeOf("image.PNG"), "image/png", "PNG MIME tespiti büyük harfte de çalışmalı"); // png kontrolü
assert.strictEqual(extOf("video/mp4"), ".mp4", "MIME'den uzantı bulma çalışmalı"); // ters çevirme kontrolü

// saveBase64 testi // base64 kaydetme testi
const testB64 = Buffer.from("flow-mcp test verisi").toString("base64"); // test baytları
const savedFile = saveBase64(testB64, { dir: path.join(DATA_DIR, "test_output"), filename: "selftest.txt", mime: "text/plain" }); // diske kaydet
assert.ok(fs.existsSync(savedFile), "Kaydedilen dosya diskte bulunmalı"); // dosyanın varlığını doğrula
fs.unlinkSync(savedFile); // test dosyasını temizle

console.log("[TEST] Karakter kütüphanesi test ediliyor..."); // bilgi mesajı

// Karakter ekleme testi // karakter testleri
const char = upsertCharacter({ name: "Kaptan Demir", description: "Mavi ceketli, sakallı kaptan", notes: "Test karakteri" }); // karakter oluştur
assert.strictEqual(char.name, "Kaptan Demir", "Karakter adı doğru kaydedilmeli"); // isim kontrolü
const fetched = getCharacter("kaptan demir"); // küçük harfle getir
assert.strictEqual(fetched.name, "Kaptan Demir", "Büyük/küçük harf duyarsız getirme çalışmalı"); // getirme kontrolü
const list = listCharacters(); // tümünü listele
assert.ok(list.some((c) => c.name === "Kaptan Demir"), "Listede karakter görünmeli"); // liste kontrolü
const deleted = deleteCharacter("Kaptan Demir"); // sil
assert.ok(deleted, "Karakter silinebilmeli"); // silme kontrolü

console.log("[TEST] Tüm birim testleri başarıyla geçti! flow-mcp hazır."); // başarı mesajı
