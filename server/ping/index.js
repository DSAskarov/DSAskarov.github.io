// Проверочная функция: отвечает, что сервер «ИИгр» жив. Секретов и данных здесь нет.
exports.handler = async () => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ ok: true, service: "iigry", ts: Date.now() })
});
