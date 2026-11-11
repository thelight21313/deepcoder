const el = id => document.getElementById(id);
let token;
let loading = false;
const browser = {
  ready: "Готов",
  disconnected: "Нет связи",
  tab_missing: "Вкладка закрыта",
  provider_busy: "Занят",
  login_required: "Требуется вход",
  session_expired: "Сессия истекла",
  captcha: "Требуется ручная проверка",
  usage_limited: "Достигнут лимит",
  ui_changed: "Интерфейс изменился",
  connection_lost: "Вкладка не отвечает",
};
const statuses = {
  queued: "В очереди",
  leased: "Подготовка",
  running: "Выполняется",
  paused: "Приостановлено",
  succeeded: "Готово",
  failed: "Ошибка",
  uncertain: "Результат неопределён",
  cancelled: "Отменено",
};
const attention = new Set(["login_required", "session_expired", "captcha", "usage_limited"]);
const format = new Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "medium" });

async function request(path, method = "GET") {
  const options = { method, headers: { Authorization: "Bearer " + token } };
  if (method === "POST") options.body = "";
  const reply = await fetch(path, options);
  if (!reply.ok) throw new Error(reply.status === 401 ? "Неверный токен." : "Bridge вернул ошибку.");
  return reply.json();
}

function show(data) {
  el("overview").hidden = false;
  el("bridge").textContent = data.enabled ? "Работает" : "Обработка на паузе";
  el("extension").textContent = data.browser_connected ? "Подключено" : "Нет связи";
  el("provider").textContent = browser[data.browser_state] ?? "Неизвестно";
  el("authorization").textContent = attention.has(data.browser_state) ?
    browser[data.browser_state] : ["ready", "provider_busy"].includes(data.browser_state) ?
      "Чат доступен" : "Нет данных";
  el("queue").textContent = data.queue_length;
  el("active").textContent = data.active_task ?? "Нет";
  el("empty").hidden = data.tasks.length !== 0;
  for (const button of document.querySelectorAll("[data-action]")) {
    button.disabled = button.dataset.action === "pause" ? !data.enabled : data.enabled;
  }
  const history = el("history");
  const rows = new Map(Array.from(history.children, node => [node.dataset.id, node]));
  let next = null;
  for (const task of data.tasks.toReversed()) {
    const row = rows.get(task.task_id) ?? document.createElement("li");
    row.dataset.id = task.task_id;
    rows.delete(task.task_id);
    const summary = task.status + "|" + task.cancel_requested + "|" + task.error;
    if (row.dataset.summary !== summary) {
      row.dataset.summary = summary;
      renderTask(row, task);
    }
    if (!row.isConnected || (next && row.nextElementSibling !== next)) {
      history.insertBefore(row, next);
    }
    next = row;
  }
  for (const row of rows.values()) row.remove();
}

function renderTask(row, task) {
  const title = document.createElement("strong");
  title.textContent = task.prompt.slice(0, 140);
  const status = document.createElement("p");
  status.textContent = [
    format.format(new Date(task.created_at * 1000)), statuses[task.status],
    task.error, task.task_id,
  ].filter(Boolean).join(" · ");
  row.replaceChildren(title, status);
  if (task.answer) {
    const details = document.createElement("details");
    const caption = document.createElement("summary");
    caption.textContent = "Ответ";
    const answer = document.createElement("pre");
    answer.textContent = task.markdown ?? task.answer;
    details.append(caption, answer);
    row.append(details);
  }
  const actions = document.createElement("div");
  actions.className = "toolbar";
  if (task.status === "paused") {
    addTaskAction(actions, task.task_id, "resume", "Возобновить задание");
  }
  if (["queued", "leased", "running", "paused"].includes(task.status) && !task.cancel_requested) {
    addTaskAction(actions, task.task_id, "cancel", "Отменить задание");
  }
  if (actions.childNodes.length) row.append(actions);
}

function addTaskAction(parent, id, action, label) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", () => mutate("/v1/tasks/" + id + "/" + action));
  parent.append(button);
}

async function refresh() {
  if (!token || loading) return;
  loading = true;
  try {
    show(await request("/v1/overview"));
    el("notice").textContent = "";
  } catch (error) {
    el("notice").textContent = error.message;
    el("overview").hidden = true;
  } finally {
    loading = false;
  }
}

async function mutate(path) {
  try {
    await request(path, "POST");
    await refresh();
  } catch (error) {
    el("notice").textContent = error.message;
  }
}

el("auth").addEventListener("submit", event => {
  event.preventDefault();
  token = el("token").value.trim();
  el("token").value = "";
  refresh();
});
for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => mutate("/v1/processing/" + button.dataset.action));
}
el("check").addEventListener("click", refresh);
setInterval(refresh, 2000);
