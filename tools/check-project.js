// Автопроверка заявок на публикацию «ИИгр онлайн». Запускается на GitHub Actions (за рубежом, изолированная машина, всё удаляется после).
// Для каждой ссылки: HTTPS и редиректы, тип содержимого; файлы — антивирус ClamAV (+ VirusTotal, если есть ключ);
// страницы — открываем в изолированном браузере и смотрим поведение: ошибки, авто-скачивание, запросы разрешений,
// майнеры, трекеры, поля паролей (фишинг), чужие домены, отрисовалось ли что-то и реагирует ли на нажатие.
const { chromium } = require("playwright");
const fs = require("fs"), crypto = require("crypto"), { execFileSync } = require("child_process");
const API = "https://functions.yandexcloud.net/d4enbk0c6huhltqsm5av", KEY = process.env.CK, VT = process.env.VT_API_KEY || "", RUN = process.env.RUN_URL || "";
const H = { "X-Cron-Key": KEY, "Content-Type": "application/json" };
const BAD_EXT = /\.(exe|scr|bat|cmd|com|msi|vbs|js|jse|ps1|jar|apk|dll|lnk|hta|reg)(\?|$)/i;
const MINERS = /(coinhive|cryptonight|coin-hive|webminer|minero\.cc|crypto-loot|jsecoin|monero|xmr\.|webmine|deepminer|cryptoloot)/i;
const TRACKERS = /(google-analytics|googletagmanager|mc\.yandex|facebook\.net|connect\.facebook|doubleclick|hotjar|tiktok|vk\.com\/rtrg|top-fwz1\.mail\.ru)/i;
const SHORT = /^(bit\.ly|tinyurl\.com|clck\.ru|goo\.su|t\.co|cutt\.ly|is\.gd|vk\.cc|u\.to)$/i;
const host = u => { try { return new URL(u).hostname } catch (_) { return "" } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function vtUrl(u, L) {
  if (!VT) return; try {
    const id = Buffer.from(u).toString("base64url"); let r = await fetch("https://www.virustotal.com/api/v3/urls/" + id, { headers: { "x-apikey": VT } });
    if (r.status === 404) { await fetch("https://www.virustotal.com/api/v3/urls", { method: "POST", headers: { "x-apikey": VT, "Content-Type": "application/x-www-form-urlencoded" }, body: "url=" + encodeURIComponent(u) }); await sleep(30000); r = await fetch("https://www.virustotal.com/api/v3/urls/" + id, { headers: { "x-apikey": VT } }) }
    const j = await r.json(), st = j.data && j.data.attributes && j.data.attributes.last_analysis_stats;
    if (st) { const bad = (st.malicious || 0) + (st.suspicious || 0); L.push((bad ? "⛔" : "✅") + " VirusTotal (70+ антивирусов) по ссылке: опасных " + (st.malicious || 0) + ", подозрительных " + (st.suspicious || 0)); return bad } else L.push("⚠️ VirusTotal: ссылка ещё анализируется");
  } catch (e) { L.push("⚠️ VirusTotal недоступен: " + e.message) } }
async function vtFile(sha, L) {
  if (!VT) return 0; try { const r = await fetch("https://www.virustotal.com/api/v3/files/" + sha, { headers: { "x-apikey": VT } });
    if (r.status === 404) { L.push("ℹ️ VirusTotal: файл раньше не встречался (проверен только ClamAV)"); return 0 }
    const st = (await r.json()).data.attributes.last_analysis_stats, bad = (st.malicious || 0) + (st.suspicious || 0);
    L.push((bad ? "⛔" : "✅") + " VirusTotal по файлу: опасных " + (st.malicious || 0) + ", подозрительных " + (st.suspicious || 0)); return bad } catch (e) { L.push("⚠️ VirusTotal недоступен"); return 0 } }
async function checkFile(u, L) {
  const r = await fetch(u, { redirect: "follow" }); const len = +r.headers.get("content-length") || 0;
  if (len > 300e6) { L.push("⚠️ Файл больше 300 МБ — антивирусом не проверен, нужна ручная проверка"); return "warn" }
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 300e6) { L.push("⚠️ Файл слишком большой для проверки"); return "warn" }
  fs.mkdirSync("dl", { recursive: true }); const f = "dl/file"; fs.writeFileSync(f, buf);
  const sha = crypto.createHash("sha256").update(buf).digest("hex"); L.push("📦 Файл " + (buf.length / 1e6).toFixed(1) + " МБ, SHA-256 " + sha.slice(0, 16) + "…");
  let out = ""; try { out = execFileSync("clamscan", ["--no-summary", "--scan-archive=yes", "--max-filesize=300M", "--max-scansize=600M", f], { encoding: "utf8" }); L.push("✅ ClamAV: вирусов не найдено") }
  catch (e) { out = String(e.stdout || ""); if (/FOUND/.test(out)) { L.push("⛔ ClamAV нашёл угрозу: " + out.split(":").pop().trim()); fs.rmSync(f); return "bad" } L.push("⚠️ ClamAV не смог проверить файл") }
  const vb = await vtFile(sha, L); fs.rmSync(f); if (vb) return "bad";
  if (BAD_EXT.test(new URL(r.url).pathname) || /application\/(x-msdownload|vnd\.android)/.test(r.headers.get("content-type") || "")) { L.push("⚠️ Исполняемый файл или APK — перед публикацией запустите в песочнице сами"); return "warn" }
  return "ok" }
async function checkPage(u, L, br) {
  let v = "ok"; const ctx = await br.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, permissions: [] });
  await ctx.addInitScript(() => { window.__ask = []; const w = (o, k, n) => { try { const f = o[k]; o[k] = function () { window.__ask.push(n); return f && f.apply(this, arguments) } } catch (_) {} };
    if (navigator.geolocation) w(navigator.geolocation, "getCurrentPosition", "геолокация"); if (navigator.mediaDevices) w(navigator.mediaDevices, "getUserMedia", "камера/микрофон");
    if (window.Notification) w(Notification, "requestPermission", "уведомления"); if (navigator.clipboard) w(navigator.clipboard, "readText", "чтение буфера обмена") });
  const p = await ctx.newPage(), errs = [], reqs = new Set(), dls = [], pops = [];
  p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text()) });
  p.on("request", r => reqs.add(host(r.url()))); p.on("download", d => dls.push(d.suggestedFilename())); ctx.on("page", np => { if (np !== p) pops.push(np.url()) });
  let resp; try { resp = await p.goto(u, { waitUntil: "load", timeout: 30000 }) } catch (e) { L.push("⛔ Страница не открылась: " + e.message.split("\n")[0]); await ctx.close(); return "bad" }
  await sleep(6000); const st = resp ? resp.status() : 0; if (st >= 400) { L.push("⛔ Сервер ответил ошибкой " + st); v = "bad" }
  const fin = p.url(); if (host(fin) !== host(u)) { L.push("⚠️ Перенаправляет на другой сайт: " + host(fin)); v = v === "bad" ? v : "warn" }
  const shot1 = await p.screenshot(); const pw = await p.$$eval("input[type=password]", e => e.length).catch(() => 0);
  const box = p.viewportSize(); await p.mouse.click(box.width / 2, box.height / 2).catch(() => {}); await p.keyboard.press("Space").catch(() => {}); await sleep(2500);
  const shot2 = await p.screenshot(); const ask = await p.evaluate(() => window.__ask).catch(() => []);
  const html = (await p.content()).slice(0, 2e6), dom = [...reqs].filter(Boolean), other = dom.filter(d => d !== host(fin) && !/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr|unpkg|cloudflare/.test(d));
  // Отрисовка: доля «не одного цвета» пикселей в скриншоте грубо — по размеру PNG
  if (shot1.length < 6000) { L.push("⚠️ Страница почти пустая — возможно, игра не загрузилась"); v = v === "bad" ? v : "warn" } else L.push("✅ Страница открылась (код " + st + "), содержимое отрисовано");
  L.push(Buffer.compare(shot1, shot2) ? "✅ Реагирует на нажатие/клавишу" : "ℹ️ На клик и пробел видимой реакции нет (для некоторых игр это нормально)");
  if (errs.length) { L.push("⚠️ Ошибок в консоли: " + errs.length + " (первая: " + errs[0].slice(0, 90) + ")"); if (v === "ok") v = "warn" }
  if (dls.length) { L.push("⛔ Пытается сама скачать файл: " + dls.join(", ")); v = "bad" }
  if (pops.length) { L.push("⚠️ Открывает всплывающие окна: " + pops.length); if (v === "ok") v = "warn" }
  if (ask.length) { L.push("⚠️ Запрашивает разрешения: " + [...new Set(ask)].join(", ")); if (v === "ok") v = "warn" }
  if (pw) { L.push("⛔ На странице есть поле пароля — возможен фишинг"); v = "bad" }
  if (MINERS.test(html) || dom.some(d => MINERS.test(d))) { L.push("⛔ Похоже на скрытый майнер криптовалюты"); v = "bad" }
  const tr = dom.filter(d => TRACKERS.test(d)); if (tr.length) { L.push("⚠️ Трекеры и аналитика: " + tr.join(", ") + " — собирают данные игроков"); if (v === "ok") v = "warn" }
  if (other.length > 8) { L.push("⚠️ Обращается к " + other.length + " чужим сайтам: " + other.slice(0, 5).join(", ") + "…"); if (v === "ok") v = "warn" }
  else if (other.length) L.push("ℹ️ Внешние сайты: " + other.join(", "));
  if (/<form[^>]+action=["']https?:/i.test(html)) { L.push("⚠️ Форма отправляет данные на внешний адрес"); if (v === "ok") v = "warn" }
  await ctx.close(); return v }
(async () => {
  const q = await (await fetch(API + "?a=checkq", { method: "POST", headers: H })).json(); const items = q.items || [];
  console.log("Заявок на проверку:", items.length); if (!items.length) return;
  const br = await chromium.launch();
  for (const it of items) { const L = []; let verdict = "ok"; const up = v => { if (v === "bad" || (v === "warn" && verdict === "ok")) verdict = v };
    if (!it.urls.length) { L.push("⛔ В заявке нет ни одной ссылки https://"); up("bad") }
    for (const u of it.urls) { L.push("🔗 " + u.slice(0, 120)); const h = host(u);
      if (SHORT.test(h)) { L.push("⚠️ Сокращённая ссылка — попросите автора дать прямую"); up("warn") }
      try { const r = await fetch(u, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20000) }); const ct = r.headers.get("content-type") || "", cd = r.headers.get("content-disposition") || "";
        r.body && r.body.cancel && r.body.cancel().catch(() => {});
        if (/text\/html/.test(ct) && !/attachment/i.test(cd)) up(await checkPage(u, L, br)); else up(await checkFile(u, L));
      } catch (e) { L.push("⛔ Ссылка не открывается: " + e.message); up("bad") }
      const vb = await vtUrl(u, L); if (vb) up("bad") }
    if (!VT) L.push("ℹ️ Проверка VirusTotal выключена (нет ключа) — работают ClamAV и поведенческий анализ");
    L.push("Подробный журнал: " + RUN);
    console.log(it.subj, verdict, L);
    await fetch(API + "?a=checkres", { method: "POST", headers: H, body: JSON.stringify({ id: it.id, verdict, res: { lines: L, run: RUN } }) }) }
  await br.close() })().catch(e => { console.error(e); process.exit(1) });
