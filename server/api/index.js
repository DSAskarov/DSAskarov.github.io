// Сервер «ИИгр онлайн»: живой чат и обсуждения для публичного сайта.
// Данные — в Yandex Database (Россия). Секретов в коде нет: доступ к базе даёт роль робота функции.
"use strict";
const { Driver, TokenAuthService, TypedValues, TypedData, TableDescription, Column, Types } = require("ydb-sdk");
const crypto = require("crypto");

const ORIGINS = (process.env.ALLOW_ORIGIN || "https://dsaskarov.github.io").split(",");
const ROOMS = { test: 200, live: 500, "talk-site": 1000, "talk-industry": 1000, "talk-wishes": 1000 };
const BAD = /(ху[йяеёи]|пизд|бля|[её]б[аоуи]н|муда[кч]|пидо|гандон|шлюх|сука|казино|ставк|букмекер|водк|пиво|алкогол|viagra|casino)/i;
const LINK = /(https?:\/\/|www\.|t\.me\/|\.(ru|com|net|org|рф|io|me)\b)/i;
// Игры с рейтингом: допустимые результаты и минимальное время игры (защита от явной подделки)
const GAMES = {
  test:  { min: 1,  max: 1000, asc: false, minMs: v => 0 },            // проверочная, на сайте не показывается
  bugs:  { min: 1,  max: 600,  asc: false, minMs: v => 25000 },          // «Лови баги»: очки за 30 секунд (с сериями ×3)
  post:  { min: 1,  max: 1000, asc: false, minMs: v => v * 600 },        // «Звёздный почтальон»: доставлено писем
  react: { min: 90, max: 3000, asc: true,  minMs: v => 5 * (v + 1000) }, // «Быстрее нейросети»: среднее время реакции, мс
  cat:   { min: 1,  max: 400,  asc: false, minMs: v => Math.min(110000, v * 350) }, // «Кот на орбите»: рыба за 3 орбиты
  words: { min: 1,  max: 3000, asc: false, minMs: v => Math.min(900000, v * 100) }  // «Ферма слов»: очки за сезон
};
const RESV = /dsaskarov|адм[иi]н|admin|модер|moder|иигр|iigr|поддержк|support|claude|anthropic|официал|official/i;

let driver = null, token = "", salt = "", ready = null;
const auth = { getAuthMetadata: async () => new TokenAuthService(token).getAuthMetadata() };

async function db(ctx) {
  token = (ctx && ctx.token && ctx.token.access_token) || token;
  if (!driver) {
    const cs = String(process.env.YDB_CS || ""), m = cs.match(/^(grpcs?:\/\/[^/?]+)\/?\?database=(.+)$/);
    driver = m ? new Driver({ endpoint: m[1], database: decodeURIComponent(m[2]), authService: auth }) : new Driver({ connectionString: cs, authService: auth });
    ready = (async () => {
      if (!(await driver.ready(8000))) throw new Error("db timeout");
      await driver.tableClient.withSession(async s => {
        const ensure = async (name, desc) => { try { await s.describeTable(name) } catch (_) { await s.createTable(name, desc) } };
        await ensure("msgs", new TableDescription()
          .withColumn(new Column("room", Types.optional(Types.UTF8))).withColumn(new Column("ts", Types.optional(Types.UINT64)))
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("n", Types.optional(Types.UTF8)))
          .withColumn(new Column("t", Types.optional(Types.UTF8))).withColumn(new Column("ip", Types.optional(Types.UTF8)))
          .withPrimaryKeys("room", "ts", "id"));
        await ensure("rl", new TableDescription()
          .withColumn(new Column("ip", Types.optional(Types.UTF8))).withColumn(new Column("ts", Types.optional(Types.UINT64)))
          .withColumn(new Column("cnt", Types.optional(Types.UINT64))).withPrimaryKeys("ip"));
        await ensure("scores", new TableDescription()
          .withColumn(new Column("game", Types.optional(Types.UTF8))).withColumn(new Column("nk", Types.optional(Types.UTF8)))
          .withColumn(new Column("n", Types.optional(Types.UTF8))).withColumn(new Column("v", Types.optional(Types.UINT64)))
          .withColumn(new Column("ts", Types.optional(Types.UINT64))).withPrimaryKeys("game", "nk"));
        await ensure("orders", new TableDescription()
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("prod", Types.optional(Types.UTF8)))
          .withColumn(new Column("pid", Types.optional(Types.UTF8))).withColumn(new Column("st", Types.optional(Types.UTF8)))
          .withColumn(new Column("ts", Types.optional(Types.UINT64))).withPrimaryKeys("id"));
        await ensure("receipts", new TableDescription()
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("rc", Types.optional(Types.UTF8)))
          .withColumn(new Column("st", Types.optional(Types.UTF8))).withColumn(new Column("err", Types.optional(Types.UTF8)))
          .withColumn(new Column("ts", Types.optional(Types.UINT64))).withPrimaryKeys("id"));
        await ensure("team", new TableDescription()
          .withColumn(new Column("name", Types.optional(Types.UTF8))).withColumn(new Column("h", Types.optional(Types.UTF8)))
          .withColumn(new Column("role", Types.optional(Types.UTF8))).withColumn(new Column("ts", Types.optional(Types.UINT64))).withPrimaryKeys("name"));
        await ensure("modlog", new TableDescription()
          .withColumn(new Column("ts", Types.optional(Types.UINT64))).withColumn(new Column("id", Types.optional(Types.UTF8)))
          .withColumn(new Column("who", Types.optional(Types.UTF8))).withColumn(new Column("act", Types.optional(Types.UTF8)))
          .withColumn(new Column("what", Types.optional(Types.UTF8))).withPrimaryKeys("ts", "id"));
        await ensure("bans", new TableDescription()
          .withColumn(new Column("ip", Types.optional(Types.UTF8))).withColumn(new Column("until", Types.optional(Types.UINT64)))
          .withColumn(new Column("by", Types.optional(Types.UTF8))).withPrimaryKeys("ip"));
        await ensure("tg", new TableDescription()
          .withColumn(new Column("chat", Types.optional(Types.UTF8))).withColumn(new Column("name", Types.optional(Types.UTF8)))
          .withColumn(new Column("role", Types.optional(Types.UTF8))).withColumn(new Column("cats", Types.optional(Types.UTF8)))
          .withColumn(new Column("ts", Types.optional(Types.UINT64))).withPrimaryKeys("chat"));
        await ensure("tglink", new TableDescription()
          .withColumn(new Column("code", Types.optional(Types.UTF8))).withColumn(new Column("name", Types.optional(Types.UTF8)))
          .withColumn(new Column("role", Types.optional(Types.UTF8))).withColumn(new Column("exp", Types.optional(Types.UINT64))).withPrimaryKeys("code"));
        await ensure("cfg", new TableDescription()
          .withColumn(new Column("k", Types.optional(Types.UTF8))).withColumn(new Column("v", Types.optional(Types.UTF8)))
          .withPrimaryKeys("k"));
      });
      salt = await q(`DECLARE $k AS Utf8; SELECT v FROM cfg WHERE k=$k;`, { $k: TypedValues.utf8("salt") }).then(r => r[0] && r[0].v);
      if (!salt) { salt = crypto.randomBytes(24).toString("hex"); await q(`DECLARE $k AS Utf8; DECLARE $v AS Utf8; UPSERT INTO cfg (k,v) VALUES ($k,$v);`, { $k: TypedValues.utf8("salt"), $v: TypedValues.utf8(salt) }) }
    })().catch(e => { driver = null; throw e });
  }
  await ready;
}
async function q(text, params) {
  return driver.tableClient.withSessionRetry(async s => {
    const r = await s.executeQuery(text, params);
    return r.resultSets && r.resultSets[0] ? TypedData.createNativeObjects(r.resultSets[0]) : [];
  });
}
const num = x => x && typeof x === "object" && x.toNumber ? x.toNumber() : Number(x || 0);

function reply(code, obj, origin) {
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" };
  if (ORIGINS.includes(origin)) { h["Access-Control-Allow-Origin"] = origin; h["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"; h["Access-Control-Allow-Headers"] = "Content-Type"; h["Access-Control-Max-Age"] = "600" }
  return { statusCode: code, headers: h, body: obj === null ? "" : JSON.stringify(obj) };
}
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, n);

const nickOf = b => { const n = clean(b.n, 30).replace(/^@/, ""); return !n || RESV.test(n) || BAD.test(n) || LINK.test(n) ? "Аноним #" + clean(b.aid, 6).replace(/[^0-9A-Z]/g, "").slice(0, 6) : n };
const ipOf = (event, hd) => { const raw = rawIp(event, hd);
  return crypto.createHash("sha256").update(salt + raw).digest("hex").slice(0, 32) };
async function limit(ip, now, gap, perHour) {
  const lim = await q(`DECLARE $ip AS Utf8; SELECT ts, cnt FROM rl WHERE ip=$ip;`, { $ip: TypedValues.utf8(ip) });
  const last = lim[0] ? num(lim[0].ts) : 0, cnt = lim[0] && now - last < 3600e3 ? num(lim[0].cnt) : 0;
  if (now - last < gap) return { err: `Не так быстро: не чаще раза в ${Math.round(gap / 1000)} секунд.` };
  if (cnt >= perHour) return { err: `Лимит: ${perHour} в час. Отдохните немного.` };
  return { cnt };
}
// Проверка «не робот» (Yandex SmartCaptcha): после успешной проверки выдаём пропуск на 12 часов, привязанный к адресу
const env = k => { const v = process.env[k] || ""; return v === "-" ? "" : v };
const CAP_SECRET = env("CAPTCHA_SECRET"), CAP_KEY = env("CAPTCHA_SITEKEY");
const sign = (ip, exp) => crypto.createHmac("sha256", salt).update(ip + "|" + exp).digest("base64url").slice(0, 32);
const passOk = (p, ip) => { if (!CAP_SECRET) return true; const m = /^(\d{13})\.([\w-]{32})$/.exec(String(p || "")); if (!m) return false;
  const exp = Number(m[1]); return exp > Date.now() && crypto.timingSafeEqual(Buffer.from(sign(ip, exp)), Buffer.from(m[2])) };
async function captchaOk(token, ipRaw) {
  try { const r = await fetch("https://smartcaptcha.cloud.yandex.ru/validate", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: CAP_SECRET, token: String(token || ""), ip: ipRaw }) });
    if (!r.ok) return true; const j = await r.json(); return j.status === "ok" } catch (_) { return true } }
const rawIp = (event, hd) => (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || String(hd["X-Forwarded-For"] || hd["x-forwarded-for"] || "").split(",")[0] || "0";
// Оплата через ЮKassa (API). Цены — только на сервере, клиенту не доверяем. Ключ — в переменной окружения из GitHub Secrets.
const SITE = "https://dsaskarov.github.io";
const PRODUCTS = {
  "post-full":  { price: "49.00", game: "pochtalyon", title: "Полная версия игры «Звёздный почтальон»" },
  "react-full": { price: "1.00",  game: "bystree",    title: "Полная версия игры «Быстрее нейросети»" }
};
const YK_SHOP = env("YK_SHOP"), YK_SECRET = env("YK_SECRET");
const yk = async (path, opt = {}) => {
  const r = await fetch("https://api.yookassa.ru/v3/" + path, Object.assign({}, opt, { headers: Object.assign({
    Authorization: "Basic " + Buffer.from(YK_SHOP + ":" + YK_SECRET).toString("base64"), "Content-Type": "application/json" }, opt.headers || {}) }));
  const j = await r.json().catch(() => ({})); if (!r.ok) console.error("yookassa", r.status, j && (j.code + " " + j.description)); return r.ok ? j : null };
const licOf = (id, prod) => crypto.createHmac("sha256", salt).update("lic|" + id + "|" + prod).digest("base64url").slice(0, 32);
const ORDER_ID = /^[0-9a-f]{24}$/;
async function getOrder(id) { const r = await q(`DECLARE $id AS Utf8; SELECT prod, pid, st FROM orders WHERE id=$id;`, { $id: TypedValues.utf8(id) }); return r[0] || null }
async function setSt(id, st) { await q(`DECLARE $id AS Utf8; DECLARE $st AS Utf8; UPDATE orders SET st=$st WHERE id=$id;`, { $id: TypedValues.utf8(id), $st: TypedValues.utf8(st) }) }
// Статус берём только из ЮKassa по id платежа — так поддельное уведомление ничего не даст
async function syncOrder(id, o) {
  if (!o || !o.pid || o.st === "succeeded" || o.st === "canceled" || !YK_SECRET) return o;
  const p = await yk("payments/" + encodeURIComponent(o.pid)); if (!p || !p.metadata || p.metadata.order !== id) return o;
  const P = PRODUCTS[o.prod]; if (p.status === "succeeded" && !(p.amount && p.amount.value === P.price && p.amount.currency === "RUB")) return o;
  const fresh = p.status !== o.st && p.status === "succeeded";
  if (p.status !== o.st && (p.status === "succeeded" || p.status === "canceled")) { await setSt(id, p.status); o.st = p.status }
  if (o.st === "succeeded") o.rc = await npdReceipt(id, o.prod, Date.parse(p.captured_at || p.created_at) || 0);
  if (fresh) await notify("buy", "Покупка: " + esc(P.title) + " — <b>" + P.price.replace(".00", "") + " ₽</b>. Чек: " + (o.rc ? "пробит ✅" : "не пробит, досылка завтра в 9:17"));
  return o }
// Чеки самозанятого в «Мой налог» (lknpd.nalog.ru). Официального API для своих сайтов нет — используем тот же API, что и веб-кабинет.
// Пароль — только в GitHub Secrets. Ошибка чека не ломает покупку: продажа остаётся в списке и пробивается повторно.
const NPD_INN = env("NPD_INN"), NPD_PASS = env("NPD_PASSWORD"), NPD = "https://lknpd.nalog.ru/api/v1";
const NPD_DEV = crypto.createHash("sha256").update("iigry-" + NPD_INN).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, "$1-$2-$3-$4-$5");
const devInfo = () => ({ sourceDeviceId: NPD_DEV, sourceType: "WEB", appVersion: "1.0.0", metaDetails: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" } });
let npdTok = "", npdExp = 0;
const cfgGet = async k => { const r = await q(`DECLARE $k AS Utf8; SELECT v FROM cfg WHERE k=$k;`, { $k: TypedValues.utf8(k) }); return r[0] ? r[0].v : "" };
const cfgSet = (k, v) => q(`DECLARE $k AS Utf8; DECLARE $v AS Utf8; UPSERT INTO cfg (k,v) VALUES ($k,$v);`, { $k: TypedValues.utf8(k), $v: TypedValues.utf8(v) });
async function npdFetch(path, body, tok) {
  const r = await fetch(NPD + path, { method: "POST", headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json, text/plain, */*" }, tok ? { Authorization: "Bearer " + tok } : {}),
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, j } }
async function npdToken() {
  if (npdTok && Date.now() < npdExp - 60e3) return npdTok;
  const rt = await cfgGet("npd_rt");
  if (rt) { const r = await npdFetch("/auth/token", { deviceInfo: devInfo(), refreshToken: rt });
    if (r.ok && r.j.token) { npdTok = r.j.token; npdExp = Date.parse(r.j.tokenExpireIn) || Date.now() + 600e3; if (r.j.refreshToken && r.j.refreshToken !== rt) await cfgSet("npd_rt", r.j.refreshToken); return npdTok } }
  if (!NPD_INN || !NPD_PASS) throw new Error("нет данных для входа в «Мой налог»");
  const r = await npdFetch("/auth/lkfl", { username: NPD_INN, password: NPD_PASS, deviceInfo: devInfo() });
  if (!r.ok || !r.j.token) throw new Error("вход в «Мой налог»: " + r.status + " " + String(r.j.message || r.j.code || "").slice(0, 120));
  npdTok = r.j.token; npdExp = Date.parse(r.j.tokenExpireIn) || Date.now() + 600e3; if (r.j.refreshToken) await cfgSet("npd_rt", r.j.refreshToken); return npdTok }
const mskIso = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 19) + "+03:00";
const rcUrl = rc => NPD_INN && rc ? NPD + "/receipt/" + NPD_INN + "/" + encodeURIComponent(rc) + "/print" : "";
async function getRc(id) { const r = await q(`DECLARE $id AS Utf8; SELECT rc, st FROM receipts WHERE id=$id;`, { $id: TypedValues.utf8(id) }); return r[0] || null }
const putRc = (id, rc, st, err) => q(`DECLARE $id AS Utf8; DECLARE $rc AS Utf8; DECLARE $st AS Utf8; DECLARE $e AS Utf8; DECLARE $ts AS Uint64; UPSERT INTO receipts (id, rc, st, err, ts) VALUES ($id, $rc, $st, $e, $ts);`,
  { $id: TypedValues.utf8(id), $rc: TypedValues.utf8(rc || ""), $st: TypedValues.utf8(st), $e: TypedValues.utf8(String(err || "").slice(0, 300)), $ts: TypedValues.uint64(Date.now()) });
// Пробить чек по оплаченному заказу (один раз; повторный вызов безопасен)
async function npdReceipt(id, prod, paidAt) {
  if (!NPD_INN || !NPD_PASS) return "";
  const old = await getRc(id); if (old && old.rc) return old.rc;
  const P = PRODUCTS[prod]; if (!P) return "";
  try { const tok = await npdToken(), now = Date.now();
    const r = await npdFetch("/income", { paymentType: "CASH", ignoreMaxTotalIncomeRestriction: false,
      client: { contactPhone: null, displayName: null, incomeType: "FROM_INDIVIDUAL", inn: null },
      requestTime: mskIso(now), operationTime: mskIso(paidAt || now), services: [{ name: P.title, amount: Number(P.price), quantity: 1 }], totalAmount: P.price }, tok);
    if (r.status === 401) { npdTok = ""; await cfgSet("npd_rt", "") }
    if (!r.j.approvedReceiptUuid) throw new Error("чек: " + r.status + " " + String(r.j.message || r.j.code || "").slice(0, 150));
    await putRc(id, r.j.approvedReceiptUuid, "ok", ""); return r.j.approvedReceiptUuid }
  catch (e) { console.error("npd", e && e.message); await putRc(id, "", "fail", e && e.message); await notify("err", "Чек не пробился (заказ " + id.slice(0, 8) + "): " + esc(e && e.message)); return "" } }
async function npdCancel(id) {
  const old = await getRc(id); if (!old || !old.rc || old.st === "canceled") return;
  try { const tok = await npdToken(), now = mskIso(Date.now());
    const r = await npdFetch("/cancel", { operationTime: now, requestTime: now, comment: "Возврат средств", receiptUuid: old.rc, partnerCode: null }, tok);
    if (!r.ok) throw new Error("аннулирование: " + r.status); await putRc(id, old.rc, "canceled", "") } catch (e) { console.error("npd cancel", e && e.message) } }
// Модерация: главный ключ админа — в GitHub Secrets (ADMIN_KEY); коды модераторов выдаёт админ, на сервере хранится только их отпечаток
const ADMIN_KEY = env("ADMIN_KEY");
// Уровни доступа команды: кто за что отвечает
const ROLES = {
  chat:   { t: "Модератор чата",      p: ["del", "ban"], ban: 7 },
  games:  { t: "Модератор рейтингов", p: ["score"], ban: 0 },
  senior: { t: "Старший модератор",   p: ["del", "ban", "score", "unban", "mods"], ban: 30 },
  admin:  { t: "Админ",               p: ["del", "ban", "score", "unban", "mods", "team"], ban: 30 }
};
const kh = k => crypto.createHash("sha256").update(salt + "|mod|" + k).digest("hex");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function modAuth(k, ip) {
  k = String(k || ""); if (k.length < 16 || k.length > 200) return null;
  const fail = await q(`DECLARE $ip AS Utf8; SELECT ts, cnt FROM rl WHERE ip=$ip;`, { $ip: TypedValues.utf8("mf:" + ip) });
  if (fail[0] && Date.now() - num(fail[0].ts) < 3600e3 && num(fail[0].cnt) >= 10) return { blocked: true };
  if (ADMIN_KEY && same(k, ADMIN_KEY)) return { role: "admin", name: "Админ" };
  const h = kh(k), rows = await q(`DECLARE $h AS Utf8; SELECT name, role FROM team WHERE h=$h;`, { $h: TypedValues.utf8(h) });
  if (rows[0] && ROLES[rows[0].role]) return { role: rows[0].role, name: rows[0].name };
  const c = fail[0] && Date.now() - num(fail[0].ts) < 3600e3 ? num(fail[0].cnt) : 0;
  await q(`DECLARE $ip AS Utf8; DECLARE $ts AS Uint64; DECLARE $c AS Uint64; UPSERT INTO rl (ip, ts, cnt) VALUES ($ip, $ts, $c);`, { $ip: TypedValues.utf8("mf:" + ip), $ts: TypedValues.uint64(Date.now()), $c: TypedValues.uint64(c + 1) });
  return null }
// Telegram-бот: уведомления команде по категориям. Токен — в GitHub Secrets (TG_BOT_TOKEN).
const TG = env("TG_BOT_TOKEN"), TG_SECRET = TG ? crypto.createHash("sha256").update(TG + "|iigry-tg").digest("hex").slice(0, 48) : "";
const CATS = { buy: "💰 Покупки и чеки", err: "⚠️ Ошибки и сбои", mod: "🛡 Действия модераторов", chat: "💬 Новые сообщения в чате", ban: "🚫 Баны" };
const CAT_ROLES = { buy: ["admin"], err: ["admin"], mod: ["admin", "senior"], chat: ["admin", "senior", "chat"], ban: ["admin", "senior", "chat"] };
const DEF_CATS = { admin: "buy,err,mod,ban", senior: "mod,ban,chat", chat: "chat,ban", games: "" };
async function tgApi(m, body) { if (!TG) return null; try { const r = await fetch("https://api.telegram.org/bot" + TG + "/" + m, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); return await r.json() } catch (e) { console.error("tg", e && e.message); return null } }
const esc = t => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
async function notify(cat, text) {
  if (!TG) return; try { const rows = await q(`SELECT chat, role, cats FROM tg;`);
    await Promise.all(rows.filter(r => String(r.cats || "").split(",").includes(cat) && (CAT_ROLES[cat] || []).includes(r.role))
      .map(r => tgApi("sendMessage", { chat_id: r.chat, text: CATS[cat].split(" ")[0] + " " + text, parse_mode: "HTML", disable_web_page_preview: true }))) } catch (e) { console.error("notify", e && e.message) } }
function catsKb(role, cats) { const on = String(cats || "").split(",");
  return { inline_keyboard: Object.keys(CATS).filter(c => CAT_ROLES[c].includes(role)).map(c => [{ text: (on.includes(c) ? "✅ " : "⬜️ ") + CATS[c].replace(/^\S+ /, ""), callback_data: "t:" + c }]) } }
const mlog = (who, act, what) => notify(/^бан/.test(act) ? "ban" : "mod", "<b>" + esc(who) + "</b>: " + esc(act) + " — " + esc(String(what).slice(0, 200))).then(() => q(`DECLARE $ts AS Uint64; DECLARE $id AS Utf8; DECLARE $w AS Utf8; DECLARE $a AS Utf8; DECLARE $x AS Utf8; UPSERT INTO modlog (ts, id, who, act, what) VALUES ($ts, $id, $w, $a, $x);`,
  { $ts: TypedValues.uint64(Date.now()), $id: TypedValues.utf8(crypto.randomBytes(4).toString("hex")), $w: TypedValues.utf8(who), $a: TypedValues.utf8(act), $x: TypedValues.utf8(String(what).slice(0, 300)) }));
const NEED = { error: "Подтвердите, что вы не робот.", need: "captcha" };
const parse = event => { try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body || "{}") || {} } catch (_) { return null } };

exports.handler = async (event, ctx) => {
  const hd = event.headers || {}, origin = hd.Origin || hd.origin || "";
  const method = event.httpMethod || "GET", qs = event.queryStringParameters || {}, a = qs.a || "";
  if (method === "OPTIONS") return reply(204, null, origin);
  // Ежедневная досылка чеков (вызывает GitHub Actions; ключ выводится из пароля и известен только серверу и GitHub)
  if (a === "npdsync" && method === "POST") {
    const key = NPD_PASS ? crypto.createHash("sha256").update(NPD_PASS + "|iigry-cron").digest("hex") : "";
    const got = String(hd["X-Cron-Key"] || hd["x-cron-key"] || "");
    if (!key || got.length !== key.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key))) return { statusCode: 403, body: "no" };
    await db(ctx); const rows = await q(`SELECT o.id AS id, o.prod AS prod, o.pid AS pid, o.ts AS ts, r.rc AS rc FROM orders AS o LEFT JOIN receipts AS r ON o.id = r.id WHERE o.st = "succeeded";`);
    let made = 0, fail = 0;
    for (const r of rows) { if (r.rc) continue; const p = YK_SECRET && await yk("payments/" + encodeURIComponent(r.pid));
      const rc = await npdReceipt(r.id, r.prod, p ? Date.parse(p.captured_at || p.created_at) : num(r.ts)); rc ? made++ : fail++ }
    return { statusCode: fail ? 500 : 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checked: rows.length, made, fail }) };
  }
  // Диагностика связи сервера с Telegram (ключ выводится из токена бота)
  if (a === "tgdiag" && method === "POST") {
    const got = String(hd["X-Cron-Key"] || hd["x-cron-key"] || "");
    if (!TG_SECRET || !same(got.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    const t0 = Date.now(), r = await tgApi("getMe", {});
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: !!(r && r.ok), ms: Date.now() - t0, err: r ? r.description || null : "нет связи" }) };
  }
  // Telegram присылает обновления бота сюда; проверяем секрет из заголовка
  if (a === "tg" && method === "POST") {
    const sec = String(hd["X-Telegram-Bot-Api-Secret-Token"] || hd["x-telegram-bot-api-secret-token"] || "");
    if (!TG_SECRET || !same(sec.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    try { await db(ctx); const u = parse(event) || {};
      if (u.callback_query) { const cq = u.callback_query, chat = String(cq.message && cq.message.chat && cq.message.chat.id || ""), c = String(cq.data || "").slice(2);
        const r = await q(`DECLARE $c AS Utf8; SELECT role, cats FROM tg WHERE chat=$c;`, { $c: TypedValues.utf8(chat) });
        if (r[0] && CATS[c] && CAT_ROLES[c].includes(r[0].role)) { let on = String(r[0].cats || "").split(",").filter(Boolean); on = on.includes(c) ? on.filter(x => x !== c) : on.concat(c);
          await q(`DECLARE $c AS Utf8; DECLARE $k AS Utf8; UPDATE tg SET cats=$k WHERE chat=$c;`, { $c: TypedValues.utf8(chat), $k: TypedValues.utf8(on.join(",")) });
          await tgApi("editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: catsKb(r[0].role, on.join(",")) }) }
        await tgApi("answerCallbackQuery", { callback_query_id: cq.id }); return { statusCode: 200, body: "ok" } }
      const m = u.message; if (!m || !m.chat || m.chat.type !== "private") return { statusCode: 200, body: "ok" };
      const chat = String(m.chat.id), txt = String(m.text || "").trim();
      const me = (await q(`DECLARE $c AS Utf8; SELECT name, role, cats FROM tg WHERE chat=$c;`, { $c: TypedValues.utf8(chat) }))[0];
      const say = (text, kb) => tgApi("sendMessage", Object.assign({ chat_id: chat, text, parse_mode: "HTML" }, kb ? { reply_markup: kb } : {}));
      const lm = /^\/link\s+(\d{6})$/.exec(txt) || (/^\d{6}$/.test(txt) ? [0, txt] : null);
      if (lm) { const l = (await q(`DECLARE $c AS Utf8; SELECT name, role, exp FROM tglink WHERE code=$c;`, { $c: TypedValues.utf8(lm[1]) }))[0];
        if (!l || num(l.exp) < Date.now()) { await say("Код не подошёл или устарел. Получите новый на странице модерации."); return { statusCode: 200, body: "ok" } }
        await q(`DECLARE $c AS Utf8; DELETE FROM tglink WHERE code=$c;`, { $c: TypedValues.utf8(lm[1]) });
        await q(`DECLARE $c AS Utf8; DECLARE $n AS Utf8; DECLARE $r AS Utf8; DECLARE $k AS Utf8; DECLARE $ts AS Uint64; UPSERT INTO tg (chat, name, role, cats, ts) VALUES ($c, $n, $r, $k, $ts);`,
          { $c: TypedValues.utf8(chat), $n: TypedValues.utf8(l.name), $r: TypedValues.utf8(l.role), $k: TypedValues.utf8(DEF_CATS[l.role] || ""), $ts: TypedValues.uint64(Date.now()) });
        await say("Готово, <b>" + esc(l.name) + "</b>! Бот подключён. Выберите, о чём присылать уведомления:", catsKb(l.role, DEF_CATS[l.role]));
        await mlog(l.name, "подключил Telegram", "уведомления"); return { statusCode: 200, body: "ok" } }
      if (me && /^\/(settings|настройки)/.test(txt)) { await say("О чём присылать уведомления:", catsKb(me.role, me.cats)); return { statusCode: 200, body: "ok" } }
      if (me && /^\/stop/.test(txt)) { await q(`DECLARE $c AS Utf8; DELETE FROM tg WHERE chat=$c;`, { $c: TypedValues.utf8(chat) }); await say("Уведомления отключены. Подключиться снова можно кодом со страницы модерации."); return { statusCode: 200, body: "ok" } }
      await say(me ? "Команды: /settings — выбрать уведомления, /stop — отключить." : "Привет! Это бот площадки «ИИгры онлайн» — dsaskarov.github.io\n\nЕсли вы в команде сайта: откройте страницу модерации, нажмите «Подключить Telegram» и пришлите сюда шестизначный код.");
    } catch (e) { console.error("tg hook", e && e.message) }
    return { statusCode: 200, body: "ok" };
  }
  // Уведомления ЮKassa приходят без Origin: проверяем платёж повторным запросом в ЮKassa
  if (a === "yk" && method === "POST") {
    try { await db(ctx); const b = parse(event) || {}, pid = String((b.object && b.object.id) || "").slice(0, 64);
      if (/^[\w-]{10,64}$/.test(pid) && YK_SECRET) { const p = await yk("payments/" + encodeURIComponent(pid)), id = p && p.metadata && String(p.metadata.order || "");
        if (id && ORDER_ID.test(id)) { const o = await getOrder(id); if (o && o.pid === pid) await syncOrder(id, o) } }
      if (b.event === "refund.succeeded" && YK_SECRET) { const rid = String(b.object.id || "").slice(0, 64), rf = /^[\w-]{10,64}$/.test(rid) && await yk("refunds/" + encodeURIComponent(rid));
        if (rf && rf.status === "succeeded") { const rows = await q(`DECLARE $p AS Utf8; SELECT id FROM orders WHERE pid=$p;`, { $p: TypedValues.utf8(String(rf.payment_id || "")) });
          if (rows[0]) { await npdCancel(rows[0].id); await setSt(rows[0].id, "refunded") } } } } catch (e) { console.error("yk hook", e && e.message) }
    return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: "ok" };
  }
  if (a === "ping") return reply(200, { ok: true, ts: Date.now() }, origin);
  if (!ORIGINS.includes(origin)) return reply(403, { error: "Запрос с чужого сайта" }, origin);
  try { try { await db(ctx) } catch (_) { await new Promise(r => setTimeout(r, 700)); await db(ctx) } } catch (e) { console.error("db", e && e.message); return reply(503, { error: "Сервер просыпается, попробуйте через минуту", detail: process.env.DEBUG === "1" ? String(e && e.message).slice(0, 300) : undefined, tok: process.env.DEBUG === "1" ? !!(ctx && ctx.token) : undefined }, origin) }

  if (a === "cfg" && method === "GET") return reply(200, { captcha: CAP_SECRET ? CAP_KEY : "" }, origin);
  if (a === "pass" && method === "POST") {
    const b = parse(event); if (!b) return reply(400, { error: "Неверный запрос" }, origin);
    if (!CAP_SECRET) return reply(200, { pass: "" }, origin);
    if (!(await captchaOk(b.token, rawIp(event, hd)))) return reply(403, { error: "Проверка не пройдена. Попробуйте ещё раз." }, origin);
    const exp = Date.now() + 12 * 3600e3; return reply(200, { pass: exp + "." + sign(ipOf(event, hd), exp), exp }, origin);
  }

  if (a === "list" && method === "GET") {
    const room = String(qs.room || ""); if (!ROOMS[room]) return reply(400, { error: "Нет такой комнаты" }, origin);
    const since = Math.max(0, Math.min(Number(qs.since) || 0, Date.now()));
    const rows = await q(`DECLARE $r AS Utf8; DECLARE $s AS Uint64; SELECT ts, id, n, t FROM msgs WHERE room=$r AND ts>$s ORDER BY ts DESC LIMIT 60;`,
      { $r: TypedValues.utf8(room), $s: TypedValues.uint64(since) });
    return reply(200, { items: rows.map(r => ({ ts: num(r.ts), id: r.id, n: r.n, t: r.t })).reverse() }, origin);
  }

  if (a === "post" && method === "POST") {
    const b = parse(event); if (!b) return reply(400, { error: "Неверный запрос" }, origin);
    const room = String(b.room || ""); if (!ROOMS[room]) return reply(400, { error: "Нет такой комнаты" }, origin);
    if (room !== "test" && !passOk(b.pass, ipOf(event, hd))) return reply(401, NEED, origin);
    if (b.hp) return reply(200, { ok: true }, origin);                       // поле-ловушка для ботов: делаем вид, что всё хорошо
    if (!(Number(b.ms) >= 2500)) return reply(429, { error: "Слишком быстро. Похоже на робота — попробуйте ещё раз." }, origin);
    const t = clean(b.t, ROOMS[room]);
    if (!t) return reply(400, { error: "Напишите что-нибудь." }, origin);
    if (BAD.test(t)) return reply(400, { error: "Сообщение не прошло фильтр: мат, реклама или запрещённая тема." }, origin);
    if (LINK.test(t)) return reply(400, { error: "Ссылки в сообщениях запрещены — так меньше спама." }, origin);
    if (/(.)\1{7,}/.test(t) || /[A-ZА-ЯЁ]{20,}/.test(t)) return reply(400, { error: "Похоже на флуд. Попробуйте спокойнее." }, origin);
    const n = nickOf(b), now = Date.now(), ip = ipOf(event, hd);
    const ban = await q(`DECLARE $ip AS Utf8; SELECT until FROM bans WHERE ip=$ip;`, { $ip: TypedValues.utf8(ip) });
    if (ban[0] && num(ban[0].until) > now) return reply(403, { error: "Модератор временно ограничил отправку сообщений с вашего адреса." }, origin);
    const lim = await limit(ip, now, 8000, 40); if (lim.err) return reply(429, { error: lim.err }, origin); const cnt = lim.cnt;
    const id = crypto.randomBytes(6).toString("hex");
    await q(`DECLARE $r AS Utf8; DECLARE $ts AS Uint64; DECLARE $id AS Utf8; DECLARE $n AS Utf8; DECLARE $t AS Utf8; DECLARE $ip AS Utf8; DECLARE $c AS Uint64;
      UPSERT INTO msgs (room, ts, id, n, t, ip) VALUES ($r, $ts, $id, $n, $t, $ip);
      UPSERT INTO rl (ip, ts, cnt) VALUES ($ip, $ts, $c);`,
      { $r: TypedValues.utf8(room), $ts: TypedValues.uint64(now), $id: TypedValues.utf8(id), $n: TypedValues.utf8(n), $t: TypedValues.utf8(t), $ip: TypedValues.utf8(ip), $c: TypedValues.uint64(cnt + 1) });
    if (room !== "test") await notify("chat", "<b>" + esc(n) + "</b> в «" + ({ live: "Живой чат", "talk-site": "Обсуждения: сайт", "talk-industry": "Обсуждения: индустрия", "talk-wishes": "Обсуждения: пожелания" })[room] + "»: " + esc(t.slice(0, 300)));
    return reply(200, { ok: true, item: { ts: now, id, n, t } }, origin);
  }
  if (a === "top" && method === "GET") {
    const g = GAMES[qs.game]; if (!g) return reply(400, { error: "Нет такой игры" }, origin);
    const rows = await q(`DECLARE $g AS Utf8; SELECT n, v, ts FROM scores WHERE game=$g ORDER BY v ${g.asc ? "ASC" : "DESC"}, ts ASC LIMIT 10;`, { $g: TypedValues.utf8(qs.game) });
    return reply(200, { asc: g.asc, items: rows.map(r => ({ n: r.n, v: num(r.v), ts: num(r.ts) })) }, origin);
  }

  if (a === "score" && method === "POST") {
    const b = parse(event); if (!b) return reply(400, { error: "Неверный запрос" }, origin);
    const g = GAMES[b.game]; if (!g) return reply(400, { error: "Нет такой игры" }, origin);
    if (b.game !== "test" && !passOk(b.pass, ipOf(event, hd))) return reply(401, NEED, origin);
    const v = Math.round(Number(b.v));
    if (!Number.isFinite(v) || v < g.min || v > g.max) return reply(400, { error: "Такой результат не принимается." }, origin);
    if (!(Number(b.ms) >= g.minMs(v))) return reply(400, { error: "Результат пришёл слишком быстро — похоже на подделку." }, origin);
    const n = nickOf(b), nk = n.toLowerCase(), now = Date.now(), ip = ipOf(event, hd);
    const lim = await limit("s:" + ip, now, 5000, 60); if (lim.err) return reply(429, { error: lim.err }, origin);
    const old = await q(`DECLARE $g AS Utf8; DECLARE $k AS Utf8; SELECT v FROM scores WHERE game=$g AND nk=$k;`, { $g: TypedValues.utf8(b.game), $k: TypedValues.utf8(nk) });
    const prev = old[0] ? num(old[0].v) : null, better = prev === null || (g.asc ? v < prev : v > prev);
    const P = { $ip: TypedValues.utf8("s:" + ip), $ts: TypedValues.uint64(now), $c: TypedValues.uint64(lim.cnt + 1) };
    if (better) await q(`DECLARE $g AS Utf8; DECLARE $k AS Utf8; DECLARE $n AS Utf8; DECLARE $v AS Uint64; DECLARE $ts AS Uint64; DECLARE $ip AS Utf8; DECLARE $c AS Uint64;
      UPSERT INTO scores (game, nk, n, v, ts) VALUES ($g, $k, $n, $v, $ts); UPSERT INTO rl (ip, ts, cnt) VALUES ($ip, $ts, $c);`,
      Object.assign({ $g: TypedValues.utf8(b.game), $k: TypedValues.utf8(nk), $n: TypedValues.utf8(n), $v: TypedValues.uint64(v) }, P));
    else await q(`DECLARE $ip AS Utf8; DECLARE $ts AS Uint64; DECLARE $c AS Uint64; UPSERT INTO rl (ip, ts, cnt) VALUES ($ip, $ts, $c);`, P);
    return reply(200, { ok: true, best: better ? v : prev, improved: better, n }, origin);
  }
  if (a === "mod" && method === "POST") {
    const b = parse(event) || {}, ip = ipOf(event, hd), me = await modAuth(b.k, ip);
    if (me && me.blocked) return reply(429, { error: "Слишком много неверных кодов. Попробуйте через час." }, origin);
    if (!me) return reply(403, { error: "Неверный код модератора." }, origin);
    const op = String(b.op || ""), R0 = ROLES[me.role], who = me.name + " (" + R0.t.toLowerCase() + ")", can = x => R0.p.includes(x);
    if (op === "me") return reply(200, { role: me.role, title: R0.t, name: me.name, perms: R0.p, ban: R0.ban, roles: Object.fromEntries(Object.entries(ROLES).filter(([k]) => k !== "admin").map(([k, v]) => [k, v.t])) }, origin);
    const NO = reply(403, { error: "Это не входит в ваш уровень доступа." }, origin);
    if (op === "tglink") { if (!TG) return reply(503, { error: "Бот ещё не подключён." }, origin);
      const code = String(crypto.randomInt(100000, 999999));
      await q(`DECLARE $c AS Utf8; DECLARE $n AS Utf8; DECLARE $r AS Utf8; DECLARE $e AS Uint64; UPSERT INTO tglink (code, name, role, exp) VALUES ($c, $n, $r, $e);`,
        { $c: TypedValues.utf8(code), $n: TypedValues.utf8(me.name), $r: TypedValues.utf8(me.role), $e: TypedValues.uint64(Date.now() + 600e3) });
      return reply(200, { code, bot: "iigry_bot" }, origin) }
    const room = String(b.room || ""), mts = Math.round(Number(b.ts)) || 0, mid = clean(b.id, 20);
    if (op === "del" || op === "ban") {
      if (!can(op)) return NO;
      if (!ROOMS[room]) return reply(400, { error: "Нет такой комнаты" }, origin);
      const m = await q(`DECLARE $r AS Utf8; DECLARE $ts AS Uint64; DECLARE $id AS Utf8; SELECT n, t, ip FROM msgs WHERE room=$r AND ts=$ts AND id=$id;`, { $r: TypedValues.utf8(room), $ts: TypedValues.uint64(mts), $id: TypedValues.utf8(mid) });
      if (!m[0]) return reply(404, { error: "Сообщение уже удалено" }, origin);
      await q(`DECLARE $r AS Utf8; DECLARE $ts AS Uint64; DECLARE $id AS Utf8; DELETE FROM msgs WHERE room=$r AND ts=$ts AND id=$id;`, { $r: TypedValues.utf8(room), $ts: TypedValues.uint64(mts), $id: TypedValues.utf8(mid) });
      if (op === "ban") { const days = Math.min(R0.ban, Math.max(1, Math.round(Number(b.days)) || 1));
        await q(`DECLARE $ip AS Utf8; DECLARE $u AS Uint64; DECLARE $by AS Utf8; UPSERT INTO bans (ip, until, by) VALUES ($ip, $u, $by);`, { $ip: TypedValues.utf8(m[0].ip), $u: TypedValues.uint64(Date.now() + days * 864e5), $by: TypedValues.utf8(who) });
        await mlog(who, "бан " + days + " дн.", m[0].n + ": " + m[0].t) } else await mlog(who, "удалил сообщение", m[0].n + ": " + m[0].t);
      return reply(200, { ok: true }, origin) }
    if (op === "score") { if (!can("score")) return NO; const g = String(b.game || ""), nk = clean(b.n, 40).toLowerCase(); if (!GAMES[g]) return reply(400, { error: "Нет такой игры" }, origin);
      await q(`DECLARE $g AS Utf8; DECLARE $k AS Utf8; DELETE FROM scores WHERE game=$g AND nk=$k;`, { $g: TypedValues.utf8(g), $k: TypedValues.utf8(nk) });
      await mlog(who, "удалил рекорд", g + ": " + nk); return reply(200, { ok: true }, origin) }
    if (op === "log") { const r = await q(`SELECT ts, who, act, what FROM modlog ORDER BY ts DESC LIMIT 60;`); return reply(200, { items: r.map(x => ({ ts: num(x.ts), who: x.who, act: x.act, what: x.what })) }, origin) }
    if (op === "mods") { if (!can("mods")) return NO; const r = await q(`SELECT name, role, ts FROM team;`); return reply(200, { items: r.map(x => ({ name: x.name, role: x.role, title: (ROLES[x.role] || {}).t || x.role, ts: num(x.ts) })) }, origin) }
    if (op === "unban") { if (!can("unban")) return NO; await q(`DELETE FROM bans;`); await mlog(who, "снял все баны", "-"); return reply(200, { ok: true }, origin) }
    if (!can("team")) return reply(403, { error: "Это может только админ." }, origin);
    if (op === "add") { const role = String(b.role || ""); if (!ROLES[role] || role === "admin") return reply(400, { error: "Выберите уровень доступа." }, origin); const name = clean(b.name, 30); if (name.length < 2 || BAD.test(name) || LINK.test(name)) return reply(400, { error: "Имя модератора: 2–30 символов, без ссылок." }, origin);
      const code = "mod-" + crypto.randomBytes(18).toString("base64url");
      await q(`DECLARE $n AS Utf8; DECLARE $h AS Utf8; DECLARE $r AS Utf8; DECLARE $ts AS Uint64; UPSERT INTO team (name, h, role, ts) VALUES ($n, $h, $r, $ts);`, { $n: TypedValues.utf8(name), $h: TypedValues.utf8(kh(code)), $r: TypedValues.utf8(role), $ts: TypedValues.uint64(Date.now()) });
      await mlog(who, "выдал код", name + " — " + ROLES[role].t); return reply(200, { code, name, title: ROLES[role].t }, origin) }
    if (op === "rm") { const name = clean(b.name, 30);
      await q(`DECLARE $n AS Utf8; DELETE FROM team WHERE name=$n;`, { $n: TypedValues.utf8(name) }); await mlog(who, "отозвал доступ", name); return reply(200, { ok: true }, origin) }
    return reply(400, { error: "Нет такой команды" }, origin);
  }
  if (a === "buy" && method === "POST") {
    const b = parse(event); if (!b) return reply(400, { error: "Неверный запрос" }, origin);
    const P = PRODUCTS[b.prod]; if (!P) return reply(400, { error: "Нет такого товара" }, origin);
    if (!YK_SECRET || !YK_SHOP) return reply(503, { error: "Оплата скоро заработает — ключи ещё настраиваются." }, origin);
    const now = Date.now(), ip = ipOf(event, hd);
    const lim = await limit("b:" + ip, now, 4000, 20); if (lim.err) return reply(429, { error: lim.err }, origin);
    const id = crypto.randomBytes(12).toString("hex");
    const p = await yk("payments", { method: "POST", headers: { "Idempotence-Key": id }, body: JSON.stringify({
      amount: { value: P.price, currency: "RUB" }, capture: true, description: P.title,
      confirmation: { type: "redirect", return_url: SITE + "/games/" + P.game + ".html?order=" + id },
      metadata: { order: id, prod: b.prod } }) });
    if (!p || !p.id || !p.confirmation || !/^https:\/\/[\w.-]*(yoomoney|yookassa)\.ru\//.test(p.confirmation.confirmation_url || "")) return reply(502, { error: "ЮKassa не ответила. Попробуйте через минуту." }, origin);
    await q(`DECLARE $id AS Utf8; DECLARE $p AS Utf8; DECLARE $pid AS Utf8; DECLARE $st AS Utf8; DECLARE $ts AS Uint64; DECLARE $ip AS Utf8; DECLARE $c AS Uint64;
      UPSERT INTO orders (id, prod, pid, st, ts) VALUES ($id, $p, $pid, $st, $ts); UPSERT INTO rl (ip, ts, cnt) VALUES ($ip, $ts, $c);`,
      { $id: TypedValues.utf8(id), $p: TypedValues.utf8(b.prod), $pid: TypedValues.utf8(p.id), $st: TypedValues.utf8(p.status || "pending"), $ts: TypedValues.uint64(now),
        $ip: TypedValues.utf8("b:" + ip), $c: TypedValues.uint64(lim.cnt + 1) });
    return reply(200, { url: p.confirmation.confirmation_url, order: id }, origin);
  }
  if (a === "order" && method === "GET") {
    const id = String(qs.id || ""); if (!ORDER_ID.test(id)) return reply(400, { error: "Неверный номер заказа" }, origin);
    const o = await syncOrder(id, await getOrder(id)); if (!o) return reply(404, { error: "Заказ не найден" }, origin);
    if (o.st === "succeeded" && !o.rc) { const r = await getRc(id); o.rc = r && r.rc }
    return reply(200, o.st === "succeeded" ? { st: o.st, prod: o.prod, lic: licOf(id, o.prod), receipt: rcUrl(o.rc) } : { st: o.st, prod: o.prod }, origin);
  }
  if (a === "lic" && method === "POST") {
    const b = parse(event) || {}, id = String(b.id || ""), prod = String(b.prod || ""), lic = String(b.lic || "");
    const ok = ORDER_ID.test(id) && !!PRODUCTS[prod] && lic.length === 32 && crypto.timingSafeEqual(Buffer.from(licOf(id, prod)), Buffer.from(lic.padEnd(32).slice(0, 32)));
    return reply(200, { ok }, origin);
  }
  return reply(404, { error: "Нет такого действия" }, origin);
};
