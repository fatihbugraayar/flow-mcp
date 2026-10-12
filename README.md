# Google Flow MCP (flow-mcp)

Google Flow ([flow.google.com](https://flow.google.com/)) üzerinde video, görsel üretimi, karakter oluşturma, referans video/fotoğraf yükleme, ayar yapma ve medya indirme işlemlerini yerel MCP protokolü ile otomatikleştiren hibrit sistem (Yerel MCP Sunucusu + Chrome Köprü Eklentisi).

---

## 🚀 Hızlı Kurulum ve Başlangıç

### 1. Adım: Chrome Eklentisini Yükle (Sadece 1 Kere)
Google Flow hesabın senin Chrome tarayıcında zaten açık olduğu için bu eklenti köprü görevi görür:
1. Chrome'u aç ve adres çubuğuna şunu yaz: `chrome://extensions/`
2. Sağ üstteki **"Geliştirici modu"** (Developer mode) anahtarını aç.
3. Sol üstteki **"Paketlenmemiş öğe yükle"** (Load unpacked) butonuna tıkla.
4. Şu klasörü seç:
   `c:\Users\hdfat\OneDrive\Masaüstü\flow-mcp\extension`
5. Eklenti simgesinde kırmızı **OFF** yazısı görünecektir (MCP sunucusu başlayınca yeşil **ON** olur).

---

### 2. Adım: Claude Desktop / Antigravity / Cursor Entegrasyonu

#### Claude Desktop İçin:
`%APPDATA%\Claude\claude_desktop_config.json` dosyanı aç ve `mcpServers` altına ekle:

```json
{
  "mcpServers": {
    "flow-mcp": {
      "command": "node",
      "args": [
        "c:/Users/hdfat/OneDrive/Masaüstü/flow-mcp/server/index.js"
      ]
    }
  }
}
```

---

## 🛠️ Sunulan Başlıca MCP Araçları

| MCP Aracı | Açıklama |
| :--- | :--- |
| `flow_status` | Eklenti ve Flow sekmesinin bağlantı durumunu kontrol eder. |
| `flow_open` | Flow sekmesini açar veya öne getirir (isteğe bağlı URL açar). |
| `flow_new_project` | Yeni Flow projesi başlatır. |
| `flow_generate_video` | Video üretir (mod, model, süre, referanslar, ilk/son kare, prompt). |
| `flow_generate_image` | Görsel üretir (mod, en-boy oranı, stil, referans görseller). |
| `flow_apply_settings` | Mod, model (Veo 3.1 vb.), çözünürlük, en-boy oranı ayarlarını değiştirir. |
| `flow_upload_references` | Bilgisayarındaki yerel fotoğraf/videoları referans olarak yükler. |
| `flow_wait_for_results` | Başlatılan üretimin bitmesini bekler. |
| `flow_download_media` | Üretilen video veya fotoğrafları bilgisayarına indirir. |
| `flow_character_create` | Tutarlı karakter tanımlar (ad + açıklama + referans fotoğraflar). |
| `flow_character_list` | Kayıtlı karakterleri listeler. |
| `flow_snapshot` | Flow sayfasındaki butonları ve öğeleri listeler. |
| `flow_click` | Flow arayüzündeki herhangi bir butona tıklar. |
| `flow_type` | Herhangi bir metin alanına yazar. |
| `flow_screenshot` | Flow sayfasının ekran görüntüsünü alır. |
