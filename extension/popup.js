// popup.js — eklenti popup'ının mantığı // dosyanın amacı
const $ = (id) => document.getElementById(id); // id ile eleman seçme kısayolu

async function refresh() { // bağlantı durumunu günceller
  const s = await chrome.runtime.sendMessage({ popup: "status" }); // arka plandan durumu iste
  $("st").className = s?.connected ? "on" : ""; // bağlıysa yeşil nokta
  $("txt").textContent = s?.connected ? "MCP sunucusuna bağlı" : "Bağlı değil"; // durum metni
  $("err").textContent = s?.connected ? "" : s?.lastError || "MCP istemcini (Claude/Cursor vb.) başlat; sunucu otomatik açılır."; // hata/ipucu metni
} // refresh sonu

chrome.storage.local.get("port").then(({ port }) => { $("port").value = port || 17345; }); // kayıtlı portu kutuya yaz
$("save").onclick = async () => { await chrome.storage.local.set({ port: Number($("port").value) || 17345 }); await chrome.runtime.sendMessage({ popup: "reconnect" }); setTimeout(refresh, 800); }; // portu kaydet ve yeniden bağlan
$("open").onclick = () => chrome.tabs.create({ url: "https://flow.google.com/" }); // Flow'u yeni sekmede aç
refresh(); setInterval(refresh, 1500); // durumu hemen ve periyodik olarak güncelle
