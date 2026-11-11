(() => {
  const chat = document.querySelector("[data-bridge-chat]");
  const messages = document.querySelector("[data-bridge-messages]");
  const form = document.querySelector("#composer");
  const input = document.querySelector("[data-bridge-input]");
  const send = document.querySelector("[data-bridge-send]");
  const stop = document.querySelector("[data-bridge-stop]");
  const fresh = document.querySelector("[data-bridge-new]");
  const error = document.querySelector("[data-bridge-error]");
  const auth = document.querySelector("[data-bridge-auth]");
  const scenario = document.querySelector("#scenario");
  const gateLabels = {
    login_required: "Требуется вход",
    session_expired: "Сессия истекла",
    captcha: "Требуется ручная проверка",
    usage_limited: "Достигнут лимит",
  };
  const errorLabels = {
    server_error: "Ошибка сервера",
    generation_interrupted: "Генерация прервана",
    connection_lost: "Подключение потеряно",
    conversation_changed: "Диалог недоступен",
  };
  const storageKey = id => "bridge-mock:" + id;
  let history = [];
  let active;

  function save(id, transcript) {
    localStorage.setItem(storageKey(id), JSON.stringify(transcript));
  }

  function load(id) {
    return JSON.parse(localStorage.getItem(storageKey(id)) ?? "null");
  }

  function markError(code) {
    error.dataset.code = code;
    error.textContent = errorLabels[code] ?? "";
    error.hidden = !code;
  }

  function syncControls() {
    const gate = Object.hasOwn(gateLabels, scenario.value) ? scenario.value : "ready";
    auth.dataset.state = gate;
    auth.textContent = gateLabels[gate] ?? "";
    input.disabled = !!active || gate !== "ready";
    send.disabled = input.disabled || !input.value.trim() || !chat.dataset.conversation;
    stop.hidden = !active;
  }

  function textElement(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  function renderMarkdownFixture({ title, prompt, items, code, table }) {
    const list = document.createElement("ul");
    list.append(...items.map(item => textElement("li", item)));
    const codeBlock = document.createElement("pre");
    codeBlock.append(textElement("code", code));
    const grid = document.createElement("table");
    const headings = grid.createTHead().insertRow();
    const values = grid.createTBody().insertRow();
    headings.append(...table[0].map(label => textElement("th", label)));
    values.append(...table[1].map(value => textElement("td", value)));
    return [textElement("h2", title), textElement("p", prompt), list, codeBlock, grid];
  }

  function render(entry) {
    const element = document.createElement("article");
    element.dataset.role = entry.role;
    element.dataset.messageId = entry.id;
    if (entry.role === "user") {
      element.textContent = entry.text;
    } else {
      element.dataset.replyTo = entry.replyTo;
      element.dataset.state = entry.state;
      const plain = document.createElement("div");
      plain.dataset.answer = "";
      plain.textContent = entry.text;
      element.append(plain);
      if (entry.markdown) {
        const markdown = document.createElement("pre");
        markdown.dataset.markdown = "";
        markdown.hidden = true;
        markdown.textContent = entry.markdown;
        element.append(markdown);
        if (entry.fixture) {
          plain.hidden = true;
          element.append(...renderMarkdownFixture(entry.fixture));
        }
      }
    }
    messages.append(element);
    return element;
  }

  function cancelForNavigation() {
    if (!active) return;
    clearTimeout(active.timer);
    active = undefined;
  }

  function openHash() {
    cancelForNavigation();
    const match = /^#chat\/([0-9a-f-]{36})$/.exec(location.hash);
    const loaded = match && load(match[1]);
    chat.dataset.conversation = loaded ? match[1] : "";
    history = loaded ?? [];
    input.value = "";
    messages.replaceChildren();
    for (const entry of history) render(entry);
    markError(loaded ? "" : "conversation_changed");
    syncControls();
  }

  function newChat() {
    const id = crypto.randomUUID();
    save(id, []);
    location.hash = "chat/" + id;
    openHash();
  }

  function finish(generation, code = "") {
    if (active !== generation) return;
    clearTimeout(generation.timer);
    active = undefined;
    generation.entry.state = code ? "failed" : "complete";
    if (code) {
      generation.entry.markdown = null;
      generation.entry.fixture = null;
    }
    generation.node.remove();
    render(generation.entry);
    try {
      save(generation.conversation, history);
      markError(code);
    } catch {
      generation.entry.state = "failed";
      messages.lastElementChild.dataset.state = "failed";
      markError("server_error");
    }
    syncControls();
  }

  function start(event) {
    event.preventDefault();
    if (send.disabled || active) return;
    const conversation = chat.dataset.conversation;
    const prompt = input.value;
    const mode = scenario.value;
    const user = { role: "user", id: crypto.randomUUID(), text: prompt };
    const entry = {
      role: "assistant", id: crypto.randomUUID(), replyTo: user.id,
      state: "streaming", text: "", markdown: null,
    };
    const previousTurns = history.filter(item => item.role === "user").length;
    const title = "Тестовый ответ " + (previousTurns + 1);
    const lead = title + "\n\n" + prompt;
    const items = ["Первый пункт", "Второй пункт"];
    const code = "print('bridge')";
    const table = [["Статус", "Значение"], ["Bridge", "Готов"]];
    const markdownRow = row => "| " + row.join(" | ") + " |";
    const markdown = [
      "## " + title,
      prompt,
      items.map(item => "- " + item).join("\n"),
      "```python\n" + code + "\n```",
      [table[0], ["---", "---"], table[1]].map(markdownRow).join("\n"),
    ].join("\n\n");
    const plainAnswer = [lead, items.join("\n"), code, table.map(row => row.join("  ")).join("\n")]
      .join("\n\n");
    const answer = mode === "long" ? lead + "\n\n" + "Потоковый текст. ".repeat(350) :
      mode === "markdown" ? plainAnswer : lead;
    markError("");
    history.push(user, entry);
    try {
      save(conversation, [...history.slice(0, -1), {
        ...entry, state: "failed", text: "",
      }]);
    } catch {
      history.splice(-2);
      markError("server_error");
      return;
    }
    render(user);
    const node = render(entry);
    const plain = node.querySelector("[data-answer]");
    input.value = "";
    const generation = { node, entry, conversation };
    active = generation;
    syncControls();

    const chunks = answer.match(/[\s\S]{1,250}/g) ?? [];
    const size = mode === "long" ? 1 : Math.ceil(chunks.length / 4);
    let index = 0;
    function stream() {
      if (active !== generation) return;
      entry.text += chunks.slice(index, index + size).join("");
      index += size;
      plain.textContent = entry.text;
      if (mode === "ui_changed") {
        messages.removeAttribute("data-bridge-messages");
        finish(generation, "generation_interrupted");
        return;
      }
      if (mode === "hang") return;
      if (["server_error", "generation_interrupted", "connection_lost"].includes(mode)) {
        finish(generation, mode);
        return;
      }
      if (index >= chunks.length) {
        if (mode === "markdown") {
          entry.markdown = markdown;
          entry.fixture = { title, prompt, items, code, table };
        }
        finish(generation);
        return;
      }
      generation.timer = setTimeout(stream, mode === "long" ? 180 : 18);
    }
    generation.timer = setTimeout(stream, 18);
  }

  fresh.addEventListener("click", newChat);
  stop.addEventListener("click", () => {
    if (active) finish(active, "generation_interrupted");
  });
  form.addEventListener("submit", start);
  input.addEventListener("input", syncControls);
  scenario.addEventListener("change", syncControls);
  window.addEventListener("hashchange", () => {
    if (location.hash !== "#chat/" + chat.dataset.conversation) openHash();
  });
  window.addEventListener("storage", event => {
    if (event.key === storageKey(chat.dataset.conversation)) openHash();
  });

  if (!location.hash) newChat();
  else openHash();
})();
