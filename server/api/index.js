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
const NEED = { error: "Подтвердите, что вы не робот.", need: "captcha" };
const parse = event => { try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body || "{}") || {} } catch (_) { return null } };

exports.handler = async (event, ctx) => {
  const hd = event.headers || {}, origin = hd.Origin || hd.origin || "";
  const method = event.httpMethod || "GET", qs = event.queryStringParameters || {}, a = qs.a || "";
  if (method === "OPTIONS") return reply(204, null, origin);
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
    const lim = await limit(ip, now, 8000, 40); if (lim.err) return reply(429, { error: lim.err }, origin); const cnt = lim.cnt;
    const id = crypto.randomBytes(6).toString("hex");
    await q(`DECLARE $r AS Utf8; DECLARE $ts AS Uint64; DECLARE $id AS Utf8; DECLARE $n AS Utf8; DECLARE $t AS Utf8; DECLARE $ip AS Utf8; DECLARE $c AS Uint64;
      UPSERT INTO msgs (room, ts, id, n, t, ip) VALUES ($r, $ts, $id, $n, $t, $ip);
      UPSERT INTO rl (ip, ts, cnt) VALUES ($ip, $ts, $c);`,
      { $r: TypedValues.utf8(room), $ts: TypedValues.uint64(now), $id: TypedValues.utf8(id), $n: TypedValues.utf8(n), $t: TypedValues.utf8(t), $ip: TypedValues.utf8(ip), $c: TypedValues.uint64(cnt + 1) });
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
  return reply(404, { error: "Нет такого действия" }, origin);
};
