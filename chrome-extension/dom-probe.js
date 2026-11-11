function inspectDeepSeekDOM(operation) {
  if (location.origin !== "https://chat.deepseek.com" || window !== window.top) {
    return { state: "unavailable" };
  }
  if (location.pathname === "/sign_in") return { state: "login_required" };

  const key = Symbol.for("deepseek-bridge.dom-probe");
  const previous = globalThis[key];
  if (operation === "status") {
    return { state: previous ? (previous.recording ? "recording" : "ready") : "idle" };
  }
  if (operation === "export") {
    if (!previous) return { state: "idle" };
    previous.stop();
    return { state: "ready", report: previous.report };
  }
  if (operation !== "start") return { state: "unavailable" };
  previous?.stop();

  const routeParts = new Set(["a", "chat", "s", "share", "sign_in"]);
  const labels = new Set([
    "send", "send message", "stop", "stop generating", "stop generation", "new chat",
    "copy", "copy response", "regenerate", "edit", "message deepseek", "search",
    "отправить", "отправить сообщение", "остановить", "остановить генерацию",
    "новый чат", "копировать", "повторить", "изменить", "поиск", "сообщение deepseek",
    "发送", "停止", "新对话", "复制", "重新生成",
  ]);
  const acceptedRoles = new Set([
    "alert", "button", "dialog", "form", "link", "log", "main", "navigation", "status", "textbox",
  ]);
  const staticId = /^(?:root|app|(?:(?:chat|message|send|stop|composer|input)[-_]?){1,4})$/i;
  const controlSelector = "button,[role=button],textarea,[contenteditable=true],[role=log],[aria-live]";
  const start = performance.now();
  const report = { version: 1, initial: null, changes: [], final: null };
  let lastControls;
  let timer;
  let pending = new Set();
  let observer;
  let deadline;
  const probe = { recording: true, report, stop };

  function elapsed() {
    return Math.round(performance.now() - start);
  }

  function route() {
    return location.pathname.split("/").map(part => !part || routeParts.has(part) ? part : "*").join("/");
  }

  function iconCode(element) {
    const svg = element.querySelector(":scope > svg, :scope > span > svg, :scope > div > svg");
    if (!svg) return undefined;
    let hash = 2166136261;
    for (const path of svg.querySelectorAll("path")) {
      const shape = path.getAttribute("d") ?? "";
      for (let index = 0; index < shape.length; index++) {
        hash = Math.imul(hash ^ shape.charCodeAt(index), 16777619);
      }
    }
    return (hash >>> 0).toString(16);
  }

  function signature(element) {
    const tag = element.localName;
    const classes = Array.from(element.classList)
      .filter(value => /^[a-z_-][a-z0-9_-]{0,35}$/i.test(value))
      .filter(value => !/\d{5}/.test(value)).slice(0, 7);
    const role = element.getAttribute("role");
    const data = { tag };
    if (classes.length) data.classes = classes;
    if (staticId.test(element.id)) data.id = element.id;
    if (acceptedRoles.has(role)) data.role = role;
    if (element.hasAttribute("contenteditable")) {
      data.editable = element.getAttribute("contenteditable") !== "false";
    }
    if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
      data.disabled = true;
    }
    if (element.hidden || element.getAttribute("aria-hidden") === "true") data.hidden = true;
    if (element.getAttribute("aria-busy") === "true") data.busy = true;
    if (["button", "textarea"].includes(tag) || role === "button") {
      const candidates = ["aria-label", "title", "placeholder"].map(name => element.getAttribute(name));
      if (tag === "button" && element.childElementCount <= 2) candidates.push(element.textContent);
      const label = candidates.map(value => value?.trim().toLowerCase()).find(value => labels.has(value));
      if (label) data.label = label;
      const icon = iconCode(element);
      if (icon) data.icon = icon;
    }
    return data;
  }

  function trail(element, depth = 5) {
    const result = [];
    for (let node = element; node && result.length < depth; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      result.push(signature(node));
    }
    return result;
  }

  function controls() {
    return Array.from(document.querySelectorAll(controlSelector)).slice(-90).map(element => trail(element));
  }

  function sample() {
    clearTimeout(timer);
    timer = undefined;
    const current = controls();
    const signature = JSON.stringify(current);
    const changedControls = signature !== lastControls;
    lastControls = signature;
    if (changedControls || pending.size) {
      const change = { ms: elapsed(), route: route(), nodes: Array.from(pending, value => JSON.parse(value)) };
      if (changedControls) change.controls = current;
      report.changes.push(change);
      if (report.changes.length > 16) report.changes.splice(5, 1);
    }
    pending = new Set();
    return current;
  }

  function stop() {
    if (!probe.recording) return;
    probe.recording = false;
    clearTimeout(deadline);
    observer.disconnect();
    report.final = { ms: elapsed(), route: route(), controls: sample() };
  }

  report.initial = { route: route(), controls: controls() };
  lastControls = JSON.stringify(report.initial.controls);
  observer = new MutationObserver(records => {
    function capture(node) {
      if (pending.size >= 36) return;
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (element?.isConnected) pending.add(JSON.stringify(trail(element, 7)));
    }
    for (const record of records) {
      capture(record.target);
      for (const node of record.addedNodes) capture(node);
    }
    timer ??= setTimeout(sample, 220);
  });
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["class", "aria-busy", "aria-disabled", "aria-label", "disabled", "hidden"],
  });
  deadline = setTimeout(stop, 60_000);
  globalThis[key] = probe;
  return { state: "recording" };
}
