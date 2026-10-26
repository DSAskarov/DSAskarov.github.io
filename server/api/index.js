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
const RESV = /команд|✓|dsaskarov|адм[иi]н|admin|модер|moder|иигр|iigr|поддержк|support|claude|anthropic|официал|official/i;

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
        await ensure("tgout", new TableDescription()
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("m", Types.optional(Types.UTF8)))
          .withColumn(new Column("b", Types.optional(Types.UTF8))).withPrimaryKeys("id"));
        await ensure("inbox", new TableDescription()
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("kind", Types.optional(Types.UTF8)))
          .withColumn(new Column("subj", Types.optional(Types.UTF8))).withColumn(new Column("text", Types.optional(Types.UTF8)))
          .withColumn(new Column("contact", Types.optional(Types.UTF8))).withColumn(new Column("st", Types.optional(Types.UTF8)))
          .withColumn(new Column("who", Types.optional(Types.UTF8))).withColumn(new Column("note", Types.optional(Types.UTF8)))
          .withColumn(new Column("ts", Types.optional(Types.UINT64))).withPrimaryKeys("id"));
        await ensure("statsub", new TableDescription()
          .withColumn(new Column("name", Types.optional(Types.UTF8))).withColumn(new Column("parts", Types.optional(Types.UTF8))).withPrimaryKeys("name"));
        await ensure("hits", new TableDescription()
          .withColumn(new Column("day", Types.optional(Types.UTF8))).withColumn(new Column("dev", Types.optional(Types.UTF8)))
          .withColumn(new Column("views", Types.optional(Types.UINT64))).withColumn(new Column("isnew", Types.optional(Types.UINT64))).withPrimaryKeys("day", "dev"));
        await ensure("devs", new TableDescription()
          .withColumn(new Column("dev", Types.optional(Types.UTF8))).withColumn(new Column("first", Types.optional(Types.UTF8))).withPrimaryKeys("dev"));
        await ensure("replies", new TableDescription()
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("ts", Types.optional(Types.UINT64)))
          .withColumn(new Column("by", Types.optional(Types.UTF8))).withColumn(new Column("text", Types.optional(Types.UTF8))).withPrimaryKeys("id", "ts"));
        await ensure("prio", new TableDescription()
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("p", Types.optional(Types.UINT64))).withPrimaryKeys("id"));
        await ensure("checks", new TableDescription()
          .withColumn(new Column("id", Types.optional(Types.UTF8))).withColumn(new Column("verdict", Types.optional(Types.UTF8)))
          .withColumn(new Column("res", Types.optional(Types.UTF8))).withColumn(new Column("ts", Types.optional(Types.UINT64))).withPrimaryKeys("id"));
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
// q:* — очереди заявок (публикации, жалобы, предложения, резюме); contacts — видеть контакты заявителей (персональные данные)
const ROLES = {
  chat:      { t: "Модератор чата",           p: ["del", "ban"], ban: 7 },
  games:     { t: "Модератор рейтингов",      p: ["score"], ban: 0 },
  pub:       { t: "Модератор публикаций",     p: ["q:publish"], ban: 0 },
  rep:       { t: "Модератор жалоб",          p: ["q:complaint"], ban: 0 },
  idea:      { t: "Модератор предложений",    p: ["q:idea"], ban: 0 },
  community: { t: "Старший модератор сообщества", p: ["del", "ban", "score", "unban", "mods"], ban: 30 },
  content:   { t: "Старший модератор контента",   p: ["q:publish", "q:complaint", "q:idea", "mods"], ban: 0 },
  senior:    { t: "Главный модератор",        p: ["del", "ban", "score", "unban", "q:publish", "q:complaint", "q:idea", "mods"], ban: 30 },
  admin:     { t: "Админ",                    p: ["del", "ban", "score", "unban", "q:publish", "q:complaint", "q:idea", "q:resume", "contacts", "mods", "team"], ban: 30 }
};
const KINDS = { publish: "Заявки на публикацию", complaint: "Жалобы", idea: "Предложения и обращения", resume: "Резюме в команду", call: "Вызов команды в чате" };
const KPERM = { publish: "q:publish", complaint: "q:complaint", idea: "q:idea", resume: "q:resume", call: "del" };
// Приоритеты: 1 — критично (деньги, мошенничество, угрозы), 2 — важно (зовут команду, жалобы, спам и оскорбления), 3 — обычно
const PRIO = { 1: "🔴 Критично", 2: "🟠 Важно", 3: "🟡 Обычно" };
const P1 = /(мошенн|обман|угрож|верните деньги|не пришл|списал|не работает оплат|возврат денег|суд\b|полици|шантаж)/i;
const P2 = /(@?модер|@?админ|позовите|помогите|спам|оскорбл|мат\b|травл|ругают|взлом)/i;
const CALL = new RegExp(P1.source + "|" + P2.source, "i");
const prioOf = (kind, text) => P1.test(text) ? 1 : (kind === "call" || kind === "complaint") ? 2 : 3;
const LINK_MOD = id => "https://dsaskarov.github.io/mod.html#i=" + encodeURIComponent(id);
const QST = { new: "Новая", work: "В работе", ok: "Принято", no: "Отклонено" };
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
async function sendStats(chat, me) {
  const { P, adminP, head, tail } = await statsBuild();
  if (me.role === "admin") { const e = Date.now() + 15 * 60e3, url = "https://functions.yandexcloud.net/d4enbk0c6huhltqsm5av?a=export&e=" + e + "&t=" + expTok(e);
    return tgApi("sendMessage", { chat_id: chat, parse_mode: "HTML", disable_web_page_preview: true, text: "📊 " + head + Object.values(adminP).join("\n") + tail,
      reply_markup: { inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "s:now" }, { text: "📥 Скачать таблицу (CSV)", url }], [{ text: "Панель админа →", url: "https://dsaskarov.github.io/mod.html" }]] } }) }
  const sb = (await q(`DECLARE $n AS Utf8; SELECT parts FROM statsub WHERE name=$n;`, { $n: TypedValues.utf8(me.name) }))[0], parts = String(sb && sb.parts || "").split(",").filter(k => P[k]);
  return tgApi("sendMessage", { chat_id: chat, parse_mode: "HTML", text: parts.length ? "📊 " + head + parts.map(k => P[k]).join("\n") + tail : "Админ пока не открыл вам статистику.",
    reply_markup: parts.length ? { inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "s:now" }]] } : undefined }) }
async function tgUpdate(u) {
      if (u.callback_query && String(u.callback_query.data || "") === "s:now") { const cq = u.callback_query, chat = String(cq.message && cq.message.chat && cq.message.chat.id || "");
        const me = (await q(`DECLARE $c AS Utf8; SELECT name, role FROM tg WHERE chat=$c;`, { $c: TypedValues.utf8(chat) }))[0]; if (me) await sendStats(chat, me);
        await tgApi("answerCallbackQuery", { callback_query_id: cq.id }); return }
      if (u.callback_query) { const cq = u.callback_query, chat = String(cq.message && cq.message.chat && cq.message.chat.id || ""), c = String(cq.data || "").slice(2);
        const r = await q(`DECLARE $c AS Utf8; SELECT role, cats FROM tg WHERE chat=$c;`, { $c: TypedValues.utf8(chat) });
        if (r[0] && CATS[c] && CAT_ROLES[c].includes(r[0].role)) { let on = String(r[0].cats || "").split(",").filter(Boolean); on = on.includes(c) ? on.filter(x => x !== c) : on.concat(c);
          await q(`DECLARE $c AS Utf8; DECLARE $k AS Utf8; UPDATE tg SET cats=$k WHERE chat=$c;`, { $c: TypedValues.utf8(chat), $k: TypedValues.utf8(on.join(",")) });
          await tgApi("editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: catsKb(r[0].role, on.join(",")) }) }
        await tgApi("answerCallbackQuery", { callback_query_id: cq.id }); return }
      const m = u.message; if (!m || !m.chat || m.chat.type !== "private") return;
      const chat = String(m.chat.id), txt = String(m.text || "").trim();
      const me = (await q(`DECLARE $c AS Utf8; SELECT name, role, cats FROM tg WHERE chat=$c;`, { $c: TypedValues.utf8(chat) }))[0];
      const say = (text, kb) => tgApi("sendMessage", Object.assign({ chat_id: chat, text, parse_mode: "HTML" }, kb ? { reply_markup: kb } : {}));
      const lm = /^\/link\s+(\d{6})$/.exec(txt) || (/^\d{6}$/.test(txt) ? [0, txt] : null);
      if (lm) { const l = (await q(`DECLARE $c AS Utf8; SELECT name, role, exp FROM tglink WHERE code=$c;`, { $c: TypedValues.utf8(lm[1]) }))[0];
        if (!l || num(l.exp) < Date.now()) { await say("Код не подошёл или устарел. Получите новый на странице модерации."); return }
        await q(`DECLARE $c AS Utf8; DELETE FROM tglink WHERE code=$c;`, { $c: TypedValues.utf8(lm[1]) });
        await q(`DECLARE $c AS Utf8; DECLARE $n AS Utf8; DECLARE $r AS Utf8; DECLARE $k AS Utf8; DECLARE $ts AS Uint64; UPSERT INTO tg (chat, name, role, cats, ts) VALUES ($c, $n, $r, $k, $ts);`,
          { $c: TypedValues.utf8(chat), $n: TypedValues.utf8(l.name), $r: TypedValues.utf8(l.role), $k: TypedValues.utf8(DEF_CATS[l.role] || ""), $ts: TypedValues.uint64(Date.now()) });
        await say("Готово, <b>" + esc(l.name) + "</b>! Бот подключён. Выберите, о чём присылать уведомления:", catsKb(l.role, DEF_CATS[l.role]));
        await mlog(l.name, "подключил Telegram", "уведомления"); return }
      if (me && /^\/(stats|статистика)/.test(txt)) { await sendStats(chat, me); return }
      if (me && /^\/(settings|настройки)/.test(txt)) { await say("О чём присылать уведомления:", catsKb(me.role, me.cats)); return }
      if (me && /^\/stop/.test(txt)) { await q(`DECLARE $c AS Utf8; DELETE FROM tg WHERE chat=$c;`, { $c: TypedValues.utf8(chat) }); await say("Уведомления отключены. Подключиться снова можно кодом со страницы модерации."); return }
      await say(me ? "Команды: /stats — статистика сейчас, /settings — выбрать уведомления, /stop — отключить." : "Привет! Это бот площадки «ИИгры онлайн» — dsaskarov.github.io\n\nЕсли вы в команде сайта: откройте страницу модерации, нажмите «Подключить Telegram» и пришлите сюда шестизначный код.");
}
// Telegram-бот: уведомления команде по категориям. Токен — в GitHub Secrets (TG_BOT_TOKEN).
const TG = env("TG_BOT_TOKEN"), TG_SECRET = TG ? crypto.createHash("sha256").update(TG + "|iigry-tg").digest("hex").slice(0, 48) : "";
const CATS = { buy: "💰 Покупки и чеки", err: "⚠️ Ошибки и сбои", mod: "🛡 Действия команды", chat: "💬 Новые сообщения в чате", ban: "🚫 Баны",
  pub: "🎮 Заявки на публикацию", rep: "🚩 Жалобы", idea: "💡 Предложения и обращения", job: "📄 Резюме в команду", stat: "📊 Сводка утром и вечером", imp: "🟠 Важное: зовут команду, жалобы (критичное приходит всегда)" };
const CAT_PERM = { imp: "del|q:complaint", stat: "team", buy: "team", err: "team", mod: "mods", chat: "del", ban: "ban", pub: "q:publish", rep: "q:complaint", idea: "q:idea", job: "q:resume" };
const CAT_ROLES = Object.fromEntries(Object.entries(CAT_PERM).map(([c, p]) => [c, Object.keys(ROLES).filter(r => p.split("|").some(x => ROLES[r].p.includes(x)))]));
const DEF_CATS = Object.fromEntries(Object.keys(ROLES).map(r => [r, Object.keys(CATS).filter(c => c !== "chat" && CAT_ROLES[c].includes(r)).join(",")]));
// Telegram недоступен из российских дата-центров напрямую, поэтому сообщения кладём в очередь,
// а пересылает их «ретранслятор» на GitHub Actions (он же забирает новые сообщения боту)
let tgSeq = 0;
async function tgApi(m, body) { if (!TG) return null;
  await q(`DECLARE $id AS Utf8; DECLARE $m AS Utf8; DECLARE $b AS Utf8; UPSERT INTO tgout (id, m, b) VALUES ($id, $m, $b);`,
    { $id: TypedValues.utf8(String(Date.now()).padStart(15, "0") + "-" + String(tgSeq++).padStart(4, "0") + crypto.randomBytes(2).toString("hex")), $m: TypedValues.utf8(m), $b: TypedValues.utf8(JSON.stringify(body)) });
  return { ok: true } }
async function tgDirect(m, body) { if (!TG) return null; try { const r = await fetch("https://api.telegram.org/bot" + TG + "/" + m, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); return await r.json() } catch (e) { console.error("tg", e && e.message); return null } }
const esc = t => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
// Срочное (жалобы, вызов команды в чате): приходит всем, кто может ответить, независимо от настроек категорий
// Критичное приходит всем, кто может ответить, всегда; важное — тем, у кого включено «Важное»; обычное — по категориям
const setPrio = (id, p) => q(`DECLARE $id AS Utf8; DECLARE $p AS Uint64; UPSERT INTO prio (id, p) VALUES ($id, $p);`, { $id: TypedValues.utf8(id), $p: TypedValues.uint64(p) });
async function notifyPrio(kind, p, text, id, cat) {
  await setPrio(id, p); if (!TG) return;
  if (p === 3) return notify(cat, text, id);
  try { const perm = KPERM[kind], rows = await q(`SELECT chat, role, cats FROM tg;`);
    await Promise.all(rows.filter(r => ROLES[r.role] && ROLES[r.role].p.includes(perm) && (p === 1 || String(r.cats || "").split(",").includes("imp"))).map(r => tgApi("sendMessage", { chat_id: r.chat, parse_mode: "HTML", disable_web_page_preview: true,
      text: (p === 1 ? "🔴 <b>КРИТИЧНО" : "🟠 <b>ВАЖНО") + " · " + esc(KINDS[kind]) + "</b>\n" + text, reply_markup: { inline_keyboard: [[{ text: "Ответить →", url: LINK_MOD(id) }]] } }))) } catch (e) { console.error("prio", e && e.message) } }
async function notify(cat, text, id) {
  if (!TG) return; try { const rows = await q(`SELECT chat, role, cats FROM tg;`);
    await Promise.all(rows.filter(r => String(r.cats || "").split(",").includes(cat) && (CAT_ROLES[cat] || []).includes(r.role))
      .map(r => tgApi("sendMessage", Object.assign({ chat_id: r.chat, text: CATS[cat].split(" ")[0] + " " + text, parse_mode: "HTML", disable_web_page_preview: true },
        id ? { reply_markup: { inline_keyboard: [[{ text: "Открыть и ответить →", url: LINK_MOD(id) }]] } } : {})))) } catch (e) { console.error("notify", e && e.message) } }
function catsKb(role, cats) { const on = String(cats || "").split(",");
  return { inline_keyboard: Object.keys(CATS).filter(c => CAT_ROLES[c].includes(role)).map(c => [{ text: (on.includes(c) ? "✅ " : "⬜️ ") + CATS[c].replace(/^\S+ /, ""), callback_data: "t:" + c }]) } }
const mlog = (who, act, what) => notify(/^бан/.test(act) ? "ban" : "mod", "<b>" + esc(who) + "</b>: " + esc(act) + " — " + esc(String(what).slice(0, 200))).then(() => q(`DECLARE $ts AS Uint64; DECLARE $id AS Utf8; DECLARE $w AS Utf8; DECLARE $a AS Utf8; DECLARE $x AS Utf8; UPSERT INTO modlog (ts, id, who, act, what) VALUES ($ts, $id, $w, $a, $x);`,
  { $ts: TypedValues.uint64(Date.now()), $id: TypedValues.utf8(crypto.randomBytes(4).toString("hex")), $w: TypedValues.utf8(who), $a: TypedValues.utf8(act), $x: TypedValues.utf8(String(what).slice(0, 300)) }));
async function traffic(days) { const out = []; for (let i = days - 1; i >= 0; i--) { const day = new Date(Date.now() + 3 * 3600e3 - i * 864e5).toISOString().slice(0, 10);
    const r = await q(`DECLARE $d AS Utf8; SELECT COUNT(*) AS u, SUM(views) AS v, SUM(isnew) AS n FROM hits WHERE day=$d;`, { $d: TypedValues.utf8(day) });
    out.push({ day, uniq: num(r[0] && r[0].u), views: num(r[0] && r[0].v), fresh: num(r[0] && r[0].n) }) } return out }
// Сводка: общие данные для бота, сайта и выгрузки
async function statsBuild() {
    const now = Date.now(), d1 = now - 864e5, h12 = now - 12 * 3600e3;
    const ord = await q(`SELECT o.prod AS prod, o.st AS st, o.ts AS ts, r.st AS rst FROM orders AS o LEFT JOIN receipts AS r ON o.id = r.id;`);
    const paid = ord.filter(o => o.st === "succeeded"), sum = a => a.reduce((x, o) => x + Number((PRODUCTS[o.prod] || {}).price || 0), 0);
    const pd = paid.filter(o => num(o.ts) > d1), noRc = paid.filter(o => o.rst !== "ok").length;
    const msgs = await q(`DECLARE $t AS Uint64; SELECT room FROM msgs WHERE ts > $t;`, { $t: TypedValues.uint64(h12) });
    const inb = await q(`SELECT kind, st FROM inbox;`), nw = {}; inb.filter(x => x.st === "new").forEach(x => nw[x.kind] = (nw[x.kind] || 0) + 1);
    const sc = await q(`DECLARE $t AS Uint64; SELECT game FROM scores WHERE ts > $t;`, { $t: TypedValues.uint64(d1) });
    const bans = await q(`DECLARE $t AS Uint64; SELECT ip FROM bans WHERE until > $t;`, { $t: TypedValues.uint64(now) });
    const team = await q(`SELECT name FROM team;`);
    const h = new Date(now + 3 * 3600e3).getUTCHours(), hi = h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
    const P = {
      sales: "💰 Продажи за сутки: <b>" + pd.length + "</b> на " + sum(pd) + " ₽ · всего: " + paid.length + " на " + sum(paid) + " ₽",
      rc: "🧾 Чеки: " + (noRc ? "⚠️ не пробито " + noRc : "все пробиты ✅"),
      chat: "💬 Сообщений в чате и обсуждениях за 12 ч: " + msgs.length,
      scores: "🏆 Новых рекордов за сутки: " + sc.length,
      inbox: "📥 Новые заявки: " + (Object.keys(nw).length ? Object.entries(nw).filter(([k]) => k !== "resume").map(([k, n]) => KINDS[k].toLowerCase() + " — " + n).join(", ") || "нет" : "нет"),
      bans: "🚫 Активных банов: " + bans.length + " · 👥 в команде: " + team.length };
    const tr = await traffic(2), td = tr[1], yd = tr[0];
    const P2 = Object.assign({ visits: "👀 Посетители сегодня: <b>" + td.uniq + "</b> уникальных (новых " + td.fresh + ") · " + td.views + " просмотров · вчера: " + yd.uniq + " / " + yd.views }, P); Object.keys(P).forEach(k => delete P[k]); Object.assign(P, P2);
    const head = "<b>" + hi + "! Сводка «ИИгр онлайн»</b>\n\n", tail = "\n\nПодробности: dsaskarov.github.io/mod.html";
    const adminP = Object.assign({}, P, { inbox: "📥 Новые заявки: " + (Object.keys(nw).length ? Object.entries(nw).map(([k, n]) => KINDS[k].toLowerCase() + " — " + n).join(", ") : "нет") });
    return { P, adminP, head, tail };
}
async function exportCsv() {
  const tr = await traffic(31), rows = [["Дата", "Уникальные посетители", "Новые устройства", "Просмотры", "Продажи, шт", "Выручка, ₽", "Сообщения", "Рекорды", "Заявки"]];
  const ord = await q(`SELECT o.prod AS prod, o.st AS st, o.ts AS ts, r.st AS rst FROM orders AS o LEFT JOIN receipts AS r ON o.id = r.id;`);
  const msgs = await q(`DECLARE $t AS Uint64; SELECT ts FROM msgs WHERE ts > $t;`, { $t: TypedValues.uint64(Date.now() - 32 * 864e5) });
  const sc = await q(`SELECT ts FROM scores;`), inb = await q(`SELECT ts FROM inbox;`);
  const dayOf = t => new Date(num(t) + 3 * 3600e3).toISOString().slice(0, 10), cnt = (a, d) => a.filter(x => dayOf(x.ts) === d).length;
  for (const t of tr) { const pd = ord.filter(o => o.st === "succeeded" && dayOf(o.ts) === t.day);
    rows.push([t.day, t.uniq, t.fresh, t.views, pd.length, pd.reduce((x, o) => x + Number((PRODUCTS[o.prod] || {}).price || 0), 0), cnt(msgs, t.day), cnt(sc, t.day), cnt(inb, t.day)]) }
  rows.push([]); rows.push(["Продажи (все)", "Товар", "Сумма, ₽", "Статус", "Чек"]);
  ord.sort((a, b) => num(a.ts) - num(b.ts)).forEach(o => rows.push([new Date(num(o.ts) + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " "), (PRODUCTS[o.prod] || {}).title || o.prod, (PRODUCTS[o.prod] || {}).price || "", o.st, o.rst === "ok" ? "пробит" : o.st === "succeeded" ? "нет" : ""]));
  return "\ufeff" + rows.map(r => r.map(c => { const v = String(c == null ? "" : c); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }).join(";")).join("\r\n") }
// Ссылка на выгрузку для бота: подписанная, действует 15 минут
const expTok = exp => crypto.createHmac("sha256", salt).update("export|" + exp).digest("base64url").slice(0, 32);
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
    const t0 = Date.now(), r = await tgDirect("getMe", {});
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: !!(r && r.ok), ms: Date.now() - t0, err: r ? r.description || null : "нет связи" }) };
  }
  // Сводка для бота (утром и вечером по расписанию GitHub Actions)
  if (a === "stats" && method === "POST") {
    const got = String(hd["X-Cron-Key"] || hd["x-cron-key"] || "");
    if (!TG_SECRET || !same(got.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    await db(ctx); const { P, adminP, head, tail } = await statsBuild();
    await notify("stat", head + Object.values(adminP).join("\n") + tail);
    // Части сводки для модераторов — по выбору админа
    const subs = await q(`SELECT name, parts FROM statsub;`);
    if (subs.length) { const chats = await q(`SELECT chat, name, role FROM tg;`);
      for (const sb of subs) { const parts = String(sb.parts || "").split(",").filter(k => P[k]); if (!parts.length) continue;
        for (const c of chats.filter(c => c.name === sb.name && c.role !== "admin"))
          await tgApi("sendMessage", { chat_id: c.chat, text: "📊 " + head + parts.map(k => P[k]).join("\n") + tail, parse_mode: "HTML", disable_web_page_preview: true }) } }
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }
  // Пример уведомлений всех уровней — только админу (запускается вручную из GitHub)
  if (a === "tgdemo" && method === "POST") {
    const got = String(hd["X-Cron-Key"] || hd["x-cron-key"] || "");
    if (!TG_SECRET || !same(got.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    await db(ctx);
    if (!(await cfgGet("mig_imp"))) { for (const r of await q(`SELECT chat, cats FROM tg;`)) { const c = String(r.cats || "").split(",").filter(Boolean); if (!c.includes("imp")) await q(`DECLARE $c AS Utf8; DECLARE $k AS Utf8; UPDATE tg SET cats=$k WHERE chat=$c;`, { $c: TypedValues.utf8(r.chat), $k: TypedValues.utf8(c.concat("imp").join(",")) }) } await cfgSet("mig_imp", "1") }
    const adm = await q(`SELECT chat FROM tg WHERE role = "admin";`), L = "https://dsaskarov.github.io/mod.html";
    const ex = [["🔴 <b>КРИТИЧНО · Жалобы</b> (пример)\nОплата не прошла — «списали 49 ₽, а полная версия не открылась, верните деньги»", "Ответить →"],
      ["🟠 <b>ВАЖНО · Вызов команды в чате</b> (пример)\n<b>Вася</b> в «Живой чат»: позовите модератора, тут спамят", "Ответить →"],
      ["🎮 <b>Заявки на публикацию</b> (пример, обычный приоритет)\n«Кот на орбите: Венера» — доработка с новыми уровнями", "Открыть и ответить →"]];
    for (const r of adm) for (const [t, b] of ex) await tgApi("sendMessage", { chat_id: r.chat, text: t, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: b, url: L }]] } });
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, to: adm.length }) };
  }
  // Выгрузка статистики CSV по подписанной ссылке из бота (действует 15 минут)
  if (a === "export" && method === "GET") {
    const e = Number(qs.e) || 0, t = String(qs.t || ""); await db(ctx);
    if (!(e > Date.now()) || e > Date.now() + 16 * 60e3 || t.length !== 32 || !same(t, expTok(e))) return { statusCode: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Ссылка устарела — запросите новую в боте командой /stats" };
    return { statusCode: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=\"iigry-stat-" + new Date().toISOString().slice(0, 10) + ".csv\"", "Cache-Control": "no-store" }, body: await exportCsv() };
  }
  // Режим технических работ: включается автоматически перед обновлением сайта и выключается после
  if (a === "maint" && method === "POST") {
    const got = String(hd["X-Cron-Key"] || hd["x-cron-key"] || "");
    if (!TG_SECRET || !same(got.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    await db(ctx); const b = parse(event) || {}, on = !!b.on, min = Math.min(240, Math.max(1, Math.round(Number(b.min)) || 10));
    await cfgSet("maint", JSON.stringify(on ? { on: true, until: Date.now() + min * 60e3, text: clean(b.text, 200) } : { on: false }));
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, on }) };
  }
  // Автопроверка заявок на публикацию (GitHub Actions): выдаёт непроверенные заявки и принимает результаты
  if ((a === "checkq" || a === "checkres") && method === "POST") {
    const got = String(hd["X-Cron-Key"] || hd["x-cron-key"] || "");
    if (!TG_SECRET || !same(got.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    await db(ctx);
    if (a === "checkq") { const r = await q(`SELECT i.id AS id, i.subj AS subj, i.text AS text FROM inbox AS i LEFT JOIN checks AS c ON i.id = c.id WHERE i.kind = "publish" AND c.id IS NULL AND (i.st = "new" OR i.st = "work") LIMIT 10;`);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: r.map(x => ({ id: x.id, subj: x.subj, urls: (String(x.text).match(/https:\/\/[^\s"'<>]+/g) || []).slice(0, 5) })) }) } }
    const b = parse(event) || {}, id = clean(b.id, 40), verdict = ["ok", "warn", "bad"].includes(b.verdict) ? b.verdict : "warn", res = String(JSON.stringify(b.res || {})).slice(0, 8000);
    const it = (await q(`DECLARE $id AS Utf8; SELECT subj FROM inbox WHERE id=$id;`, { $id: TypedValues.utf8(id) }))[0]; if (!it) return { statusCode: 404, body: "no" };
    await q(`DECLARE $id AS Utf8; DECLARE $v AS Utf8; DECLARE $r AS Utf8; DECLARE $ts AS Uint64; UPSERT INTO checks (id, verdict, res, ts) VALUES ($id, $v, $r, $ts);`,
      { $id: TypedValues.utf8(id), $v: TypedValues.utf8(verdict), $r: TypedValues.utf8(res), $ts: TypedValues.uint64(Date.now()) });
    const V = { ok: "✅ Автопроверка пройдена", warn: "⚠️ Автопроверка: есть замечания", bad: "⛔ Автопроверка: опасно, не публиковать" }[verdict];
    const lines = (Array.isArray(b.res && b.res.lines) ? b.res.lines : []).slice(0, 12).map(x => "• " + esc(String(x).slice(0, 160))).join("\n");
    if (verdict === "bad") await notifyPrio("publish", 1, "<b>" + esc(it.subj) + "</b>\n" + V + "\n" + lines, id); else await notify("pub", "<b>" + esc(it.subj) + "</b>\n" + V + "\n" + lines, id);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }
  // Ретранслятор (GitHub Actions): отдаёт очередь исходящих и принимает входящие обновления бота
  if ((a === "tgpull" || a === "tgpush") && method === "POST") {
    const got = String(hd["X-Cron-Key"] || hd["x-cron-key"] || "");
    if (!TG_SECRET || !same(got.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    await db(ctx);
    if (a === "tgpush") { const ups = (parse(event) || {}).updates; let n = 0;
      for (const u of Array.isArray(ups) ? ups.slice(0, 100) : []) { try { await tgUpdate(u); n++ } catch (e) { console.error("tgpush", e && e.message) } }
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, n }) } }
    const rows = await q(`SELECT id, m, b FROM tgout ORDER BY id LIMIT 50;`);
    for (const r of rows) await q(`DECLARE $id AS Utf8; DELETE FROM tgout WHERE id=$id;`, { $id: TypedValues.utf8(r.id) });
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: rows.map(r => ({ m: r.m, b: JSON.parse(r.b) })) }) };
  }
  // Telegram присылает обновления бота сюда; проверяем секрет из заголовка
  if (a === "tg" && method === "POST") {
    const sec = String(hd["X-Telegram-Bot-Api-Secret-Token"] || hd["x-telegram-bot-api-secret-token"] || "");
    if (!TG_SECRET || !same(sec.padEnd(48).slice(0, 48), TG_SECRET)) return { statusCode: 403, body: "no" };
    try { await db(ctx); const u = parse(event) || {};
      await tgUpdate(u);
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

  if (a === "status" && method === "GET") { let m = {}; try { m = JSON.parse(await cfgGet("maint") || "{}") } catch (_) {}
    const on = !!(m.on && m.until > Date.now()); return reply(200, { maint: on, until: on ? m.until : 0, text: on ? m.text || "" : "" }, origin) }
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
    const RN = { live: "Живой чат", "talk-site": "Обсуждения: сайт", "talk-industry": "Обсуждения: индустрия", "talk-wishes": "Обсуждения: пожелания" };
    if (room !== "test" && CALL.test(t)) { const pr = prioOf("call", t); const cid = "c~" + room + "~" + now + "~" + id;
      await q(`DECLARE $id AS Utf8; DECLARE $k AS Utf8; DECLARE $s AS Utf8; DECLARE $t AS Utf8; DECLARE $st AS Utf8; DECLARE $e AS Utf8; DECLARE $ts AS Uint64;
        UPSERT INTO inbox (id, kind, subj, text, contact, st, who, note, ts) VALUES ($id, $k, $s, $t, $e, $st, $e, $e, $ts);`,
        { $id: TypedValues.utf8(cid), $k: TypedValues.utf8("call"), $s: TypedValues.utf8(n + " в «" + RN[room] + "»"), $t: TypedValues.utf8(t), $st: TypedValues.utf8("new"), $e: TypedValues.utf8(""), $ts: TypedValues.uint64(now) });
      await notifyPrio("call", pr, "<b>" + esc(n) + "</b> в «" + RN[room] + "»: " + esc(t.slice(0, 300)), cid, "chat") }
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
  // Счётчик посещений: анонимный номер устройства из браузера (на сервере — только его отпечаток), без cookie и слежки
  if (a === "hit" && method === "POST") {
    const b = parse(event) || {}, raw = String(b.d || ""); if (!/^[0-9a-f]{32}$/.test(raw)) return reply(400, { error: "bad" }, origin);
    const ua = String(hd["User-Agent"] || hd["user-agent"] || ""); if (!ua || /bot|crawl|spider|headless|preview|monitor|curl|python|wget/i.test(ua)) return reply(200, { ok: true }, origin);
    const dev = crypto.createHash("sha256").update(salt + "|dev|" + raw).digest("hex").slice(0, 32), day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    const cur = await q(`DECLARE $d AS Utf8; DECLARE $v AS Utf8; SELECT views FROM hits WHERE day=$d AND dev=$v;`, { $d: TypedValues.utf8(day), $v: TypedValues.utf8(dev) });
    if (cur[0] && num(cur[0].views) >= 300) return reply(200, { ok: true }, origin);
    let isnew = 0; if (!cur[0]) { const k = await q(`DECLARE $v AS Utf8; SELECT first FROM devs WHERE dev=$v;`, { $v: TypedValues.utf8(dev) });
      if (!k[0]) { isnew = 1; await q(`DECLARE $v AS Utf8; DECLARE $f AS Utf8; UPSERT INTO devs (dev, first) VALUES ($v, $f);`, { $v: TypedValues.utf8(dev), $f: TypedValues.utf8(day) }) } }
    if (cur[0]) await q(`DECLARE $d AS Utf8; DECLARE $v AS Utf8; UPDATE hits SET views = views + 1u WHERE day=$d AND dev=$v;`, { $d: TypedValues.utf8(day), $v: TypedValues.utf8(dev) });
    else await q(`DECLARE $d AS Utf8; DECLARE $v AS Utf8; DECLARE $n AS Uint64; UPSERT INTO hits (day, dev, views, isnew) VALUES ($d, $v, 1u, $n);`, { $d: TypedValues.utf8(day), $v: TypedValues.utf8(dev), $n: TypedValues.uint64(isnew) });
    return reply(200, { ok: true }, origin);
  }
  if (a === "ticket" && method === "GET") {
    const id = String(qs.id || ""); if (!/^[0-9a-z]{8,20}$/.test(id)) return reply(400, { error: "Неверный номер обращения" }, origin);
    const r = await q(`DECLARE $id AS Utf8; SELECT kind, st FROM inbox WHERE id=$id;`, { $id: TypedValues.utf8(id) }); if (!r[0] || r[0].kind === "call") return reply(404, { error: "Обращение не найдено" }, origin);
    const rp = await q(`DECLARE $id AS Utf8; SELECT ts, by, text FROM replies WHERE id=$id ORDER BY ts;`, { $id: TypedValues.utf8(id) });
    return reply(200, { kind: KINDS[r[0].kind], st: QST[r[0].st] || r[0].st, replies: rp.map(x => ({ ts: num(x.ts), by: x.by, text: x.text })) }, origin);
  }
  if (a === "submit" && method === "POST") {
    const b = parse(event); if (!b) return reply(400, { error: "Неверный запрос" }, origin);
    const kind = String(b.kind || ""); if (!KINDS[kind]) return reply(400, { error: "Неизвестный тип обращения" }, origin);
    if (!passOk(b.pass, ipOf(event, hd))) return reply(401, NEED, origin);
    if (b.hp) return reply(200, { ok: true }, origin);
    const subj = clean(b.subj, 120), text = clean(b.text, 3000), contact = clean(b.contact, 200);
    if (text.length < 5) return reply(400, { error: "Напишите чуть подробнее." }, origin);
    const now = Date.now(), ip = ipOf(event, hd), lim = await limit("q:" + ip, now, 20000, 10); if (lim.err) return reply(429, { error: lim.err }, origin);
    const id = now.toString(36) + crypto.randomBytes(3).toString("hex");
    await q(`DECLARE $id AS Utf8; DECLARE $k AS Utf8; DECLARE $s AS Utf8; DECLARE $t AS Utf8; DECLARE $c AS Utf8; DECLARE $st AS Utf8; DECLARE $e AS Utf8; DECLARE $ts AS Uint64; DECLARE $ip AS Utf8; DECLARE $n AS Uint64;
      UPSERT INTO inbox (id, kind, subj, text, contact, st, who, note, ts) VALUES ($id, $k, $s, $t, $c, $st, $e, $e, $ts); UPSERT INTO rl (ip, ts, cnt) VALUES ($ip, $ts, $n);`,
      { $id: TypedValues.utf8(id), $k: TypedValues.utf8(kind), $s: TypedValues.utf8(subj), $t: TypedValues.utf8(text), $c: TypedValues.utf8(contact), $st: TypedValues.utf8("new"), $e: TypedValues.utf8(""),
        $ts: TypedValues.uint64(now), $ip: TypedValues.utf8("q:" + ip), $n: TypedValues.uint64(lim.cnt + 1) });
    const pr = prioOf(kind, subj + " " + text);
    if (pr < 3) await notifyPrio(kind, pr, esc(subj || "без темы") + " — " + esc(text.slice(0, 250)), id); else { await setPrio(id, 3);
    await notify({ publish: "pub", complaint: "rep", idea: "idea", resume: "job" }[kind], "<b>" + esc(KINDS[kind]) + "</b>: " + esc(subj || "без темы") + " — " + esc(kind === "resume" ? "откройте mod.html" : text.slice(0, 200)) + (kind === "publish" ? "\n\n🤖 Автопроверка запущена: демо, вирусы и шпионские программы, поведение страницы. Результат придёт в течение часа — можно уже открыть и опробовать." : ""), id) }
    return reply(200, { ok: true, id }, origin);
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
    if (op === "all") { const ks = Object.keys(KINDS).filter(k => can(KPERM[k])); if (!ks.length) return NO;
      const r = await q(`SELECT id, kind, subj, text, contact, st, who, note, ts FROM inbox WHERE st = "new" OR st = "work" ORDER BY ts DESC LIMIT 200;`);
      const pm = Object.fromEntries((await q(`SELECT id, p FROM prio;`)).map(y => [y.id, num(y.p)]));
      const items = r.filter(x => ks.includes(x.kind)).map(x => ({ id: x.id, kind: x.kind, kindT: KINDS[x.kind], p: pm[x.id] || prioOf(x.kind, x.subj + " " + x.text), urgent: (pm[x.id] || 3) < 3, subj: x.subj, text: x.text,
        contact: can("contacts") ? x.contact : (x.contact ? "скрыто — видит только админ" : ""), st: x.st, stT: QST[x.st], who: x.who, note: x.note, ts: num(x.ts) }));
      const ck = Object.fromEntries((await q(`SELECT id, verdict, res FROM checks;`)).map(y => [y.id, y]));
      items.forEach(x => { x.pT = PRIO[x.p]; x.urgent = x.p < 3; const c = ck[x.id]; if (c) { let rr = {}; try { rr = JSON.parse(c.res) } catch (_) {} x.check = { verdict: c.verdict, lines: rr.lines || [], run: rr.run || "" } } }); items.sort((a, b) => (a.p - b.p) || (b.ts - a.ts));
      const tm = can("team") ? (await q(`SELECT name FROM team;`)).map(x => x.name) : [];
      return reply(200, { items, as: can("team") ? ["Дмитрий (админ)"].concat(tm) : [me.name] }, origin) }
    if (op === "one") { const id = clean(b.id, 120); const r = await q(`DECLARE $id AS Utf8; SELECT id, kind, subj, text, contact, st, who, note, ts FROM inbox WHERE id=$id;`, { $id: TypedValues.utf8(id) });
      if (!r[0] || !can(KPERM[r[0].kind])) return reply(404, { error: "Не найдено или нет доступа" }, origin); const x = r[0];
      const rp = await q(`DECLARE $id AS Utf8; SELECT ts, by, text FROM replies WHERE id=$id ORDER BY ts;`, { $id: TypedValues.utf8(id) });
      const pp = (await q(`DECLARE $id AS Utf8; SELECT p FROM prio WHERE id=$id;`, { $id: TypedValues.utf8(id) }))[0], pv = pp ? num(pp.p) : prioOf(x.kind, x.subj + " " + x.text);
      return reply(200, { item: { id: x.id, kind: x.kind, kindT: KINDS[x.kind], p: pv, pT: PRIO[pv], urgent: pv < 3, subj: x.subj, text: x.text, contact: can("contacts") ? x.contact : (x.contact ? "скрыто — видит только админ" : ""), st: x.st, stT: QST[x.st], who: x.who, note: x.note, ts: num(x.ts),
        replies: rp.map(y => ({ ts: num(y.ts), by: y.by, text: y.text })) } }, origin) }
    if (op === "setprio") { const id = clean(b.id, 120), p = Math.round(Number(b.p)); if (!PRIO[p]) return reply(400, { error: "Неверный приоритет" }, origin);
      const r = await q(`DECLARE $id AS Utf8; SELECT kind, subj FROM inbox WHERE id=$id;`, { $id: TypedValues.utf8(id) }); if (!r[0] || !can(KPERM[r[0].kind])) return NO;
      await setPrio(id, p); await mlog(who, "сменил приоритет на «" + PRIO[p].replace(/^\S+ /, "") + "»", KINDS[r[0].kind] + ": " + (r[0].subj || id)); return reply(200, { ok: true }, origin) }
    if (op === "reply") { const id = clean(b.id, 120), text = clean(b.text, 1500), st = QST[b.st] ? String(b.st) : "work"; if (text.length < 2) return reply(400, { error: "Напишите ответ." }, origin);
      const r = await q(`DECLARE $id AS Utf8; SELECT kind, subj FROM inbox WHERE id=$id;`, { $id: TypedValues.utf8(id) }); if (!r[0] || !can(KPERM[r[0].kind])) return NO;
      let by = me.name; if (can("team") && b.as) { const as = clean(b.as, 40), tm = (await q(`SELECT name FROM team;`)).map(x => x.name); if (as === "Дмитрий (админ)" || tm.includes(as)) by = as }
      const now = Date.now();
      if (r[0].kind === "call") { const [, room] = id.split("~"); if (!ROOMS[room]) return reply(400, { error: "Комната не найдена" }, origin);
        const mid = crypto.randomBytes(6).toString("hex"), nn = by.replace(/ \(админ\)$/, "").slice(0, 18) + " ✓ команда";
        await q(`DECLARE $r AS Utf8; DECLARE $ts AS Uint64; DECLARE $id AS Utf8; DECLARE $n AS Utf8; DECLARE $t AS Utf8; DECLARE $ip AS Utf8; UPSERT INTO msgs (room, ts, id, n, t, ip) VALUES ($r, $ts, $id, $n, $t, $ip);`,
          { $r: TypedValues.utf8(room), $ts: TypedValues.uint64(now), $id: TypedValues.utf8(mid), $n: TypedValues.utf8(nn), $t: TypedValues.utf8(text), $ip: TypedValues.utf8("team") }) }
      await q(`DECLARE $id AS Utf8; DECLARE $ts AS Uint64; DECLARE $by AS Utf8; DECLARE $t AS Utf8; DECLARE $st AS Utf8; DECLARE $w AS Utf8;
        UPSERT INTO replies (id, ts, by, text) VALUES ($id, $ts, $by, $t); UPDATE inbox SET st=$st, who=$w WHERE id=$id;`,
        { $id: TypedValues.utf8(id), $ts: TypedValues.uint64(now), $by: TypedValues.utf8(by), $t: TypedValues.utf8(text), $st: TypedValues.utf8(st), $w: TypedValues.utf8(me.name) });
      await mlog(who, "ответил" + (by !== me.name ? " от имени «" + by + "»" : ""), KINDS[r[0].kind] + ": " + (r[0].subj || id) + " — " + text.slice(0, 120)); return reply(200, { ok: true }, origin) }
    if (op === "queue") { const kind = String(b.kind || ""); if (!KINDS[kind] || !can(KPERM[kind])) return NO;
      const st = QST[b.st] ? String(b.st) : "";
      const r = await q(`DECLARE $k AS Utf8; SELECT id, subj, text, contact, st, who, note, ts FROM inbox WHERE kind=$k ORDER BY ts DESC LIMIT 100;`, { $k: TypedValues.utf8(kind) });
      return reply(200, { items: r.filter(x => !st || x.st === st).map(x => ({ id: x.id, subj: x.subj, text: x.text, contact: can("contacts") ? x.contact : (x.contact ? "скрыто — видит только админ" : ""), st: x.st, stT: QST[x.st] || x.st, who: x.who, note: x.note, ts: num(x.ts) })) }, origin) }
    if (op === "qset") { const id = clean(b.id, 120), st = String(b.st || ""), note = clean(b.note, 500); if (!QST[st]) return reply(400, { error: "Неверный статус" }, origin);
      const r = await q(`DECLARE $id AS Utf8; SELECT kind, subj FROM inbox WHERE id=$id;`, { $id: TypedValues.utf8(id) }); if (!r[0]) return reply(404, { error: "Заявка не найдена" }, origin);
      if (!can(KPERM[r[0].kind])) return NO;
      await q(`DECLARE $id AS Utf8; DECLARE $st AS Utf8; DECLARE $w AS Utf8; DECLARE $n AS Utf8; UPDATE inbox SET st=$st, who=$w, note=$n WHERE id=$id;`, { $id: TypedValues.utf8(id), $st: TypedValues.utf8(st), $w: TypedValues.utf8(me.name), $n: TypedValues.utf8(note) });
      await mlog(who, "заявка «" + QST[st] + "»", KINDS[r[0].kind] + ": " + (r[0].subj || id) + (note ? " — " + note : "")); return reply(200, { ok: true }, origin) }
    if (op === "traffic") { if (!can("mods")) return NO; return reply(200, { items: await traffic(Math.min(31, Math.max(1, Math.round(Number(b.days)) || 14))) }, origin) }
    if (op === "summary" || op === "export") { if (!can("team")) return NO;
      if (op === "export") return reply(200, { csv: await exportCsv() }, origin);
      const { adminP } = await statsBuild(); return reply(200, { lines: Object.values(adminP).map(x => x.replace(/<[^>]+>/g, "")) }, origin) }
    if (op === "log") { const r = await q(`SELECT ts, who, act, what FROM modlog ORDER BY ts DESC LIMIT 60;`); return reply(200, { items: r.map(x => ({ ts: num(x.ts), who: x.who, act: x.act, what: x.what })) }, origin) }
    if (op === "mods") { if (!can("mods")) return NO; const r = await q(`SELECT name, role, ts FROM team;`), ss = await q(`SELECT name, parts FROM statsub;`), sm = Object.fromEntries(ss.map(x => [x.name, x.parts]));
      const tgs = await q(`SELECT name FROM tg;`), tn = new Set(tgs.map(x => x.name));
      return reply(200, { items: r.map(x => ({ name: x.name, role: x.role, title: (ROLES[x.role] || {}).t || x.role, ts: num(x.ts), parts: can("team") ? String(sm[x.name] || "").split(",").filter(Boolean) : [], tg: tn.has(x.name) })) }, origin) }
    if (op === "statset") { if (!can("team")) return NO; const name = clean(b.name, 30), OK = ["visits", "sales", "rc", "chat", "scores", "inbox", "bans"];
      const parts = (Array.isArray(b.parts) ? b.parts : []).map(String).filter(p => OK.includes(p));
      await q(`DECLARE $n AS Utf8; DECLARE $p AS Utf8; UPSERT INTO statsub (name, parts) VALUES ($n, $p);`, { $n: TypedValues.utf8(name), $p: TypedValues.utf8(parts.join(",")) });
      await mlog(who, "настроил сводку", name + ": " + (parts.join(", ") || "отключена")); return reply(200, { ok: true }, origin) }
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
