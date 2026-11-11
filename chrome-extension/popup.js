const status = document.querySelector("#status");
const states = {
  ready: "Чат готов",
  tab_missing: "Откройте вкладку чата",
  login_required: "Требуется вход",
  session_expired: "Сессия истекла",
  captcha: "Требуется ручная проверка",
  usage_limited: "Достигнут лимит провайдера",
  ui_changed: "Интерфейс чата изменился",
  provider_busy: "Чат занят",
  connection_lost: "Вкладка не отвечает",
  disconnected: "Bridge недоступен",
};

async function refresh() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "status" });
    status.textContent = states[reply.state] ?? states.disconnected;
  } catch {
    status.textContent = states.disconnected;
  }
}

refresh();
setInterval(refresh, 1500);

async function setupProbe() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || new URL(tab.url).origin !== "https://chat.deepseek.com") return;
  document.querySelector("#probe").hidden = false;
  const status = document.querySelector("#probe-status");
  const start = document.querySelector("#probe-start");
  const download = document.querySelector("#probe-download");
  const labels = {
    idle: "Запись содержит структуру интерфейса без текста сообщений.",
    recording: "Запись идёт. Отправьте короткий запрос и откройте это меню после ответа.",
    ready: "Отчёт готов.",
    login_required: "Сначала войдите в DeepSeek.",
    unavailable: "Не удалось прочитать вкладку.",
  };

  async function run(operation) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inspectDeepSeekDOM,
        args: [operation],
      });
      status.textContent = labels[result.state];
      start.disabled = ["unavailable", "login_required"].includes(result.state);
      download.disabled = !["recording", "ready"].includes(result.state);
      return result.report;
    } catch {
      status.textContent = labels.unavailable;
    }
  }

  start.addEventListener("click", () => run("start"));
  download.addEventListener("click", async () => {
    const report = await run("export");
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "deepseek-dom.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  await run("status");
}

setupProbe().catch(() => {});
