(() => {
  const s = globalThis.deepSeekSelectors;
  const gates = new Set(["login_required", "session_expired", "captcha", "usage_limited"]);
  let preparedTurn;

  const fault = code => Object.assign(new Error(code), { code });
  const normalize = text => text.replace(/\r\n?/g, "\n").trim();
  const textOf = node => normalize(node.innerText ?? node.textContent ?? "");
  const unique = (root, selector) => {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 ? matches[0] : null;
  };

  function route() {
    const path = location.pathname;
    return path === "/" || /^\/a\/chat\/s\/[a-z0-9_-]+$/i.test(path) ? path : null;
  }

  function iconCode(control) {
    const svg = control.querySelector(":scope > svg, :scope > span > svg, :scope > div > svg");
    if (!svg) return null;
    let hash = 2166136261;
    for (const path of svg.querySelectorAll("path")) {
      const shape = path.getAttribute("d") ?? "";
      for (let index = 0; index < shape.length; index++) {
        hash = Math.imul(hash ^ shape.charCodeAt(index), 16777619);
      }
    }
    return (hash >>> 0).toString(16);
  }

  function controls() {
    const input = unique(document, s.input);
    const composer = input?.closest(s.composer);
    const control = composer && unique(composer, s.control);
    if (!control) return null;
    return { input, control, icon: iconCode(control) };
  }

  function transcript(input) {
    const list = input.closest(s.transcript);
    const container = list && unique(list, s.rows);
    return container ? Array.from(container.children).filter(row => textOf(row) || row.querySelector(s.answer)) : null;
  }

  function state() {
    if (location.pathname === "/sign_in") return "login_required";
    const ui = controls();
    if (!route() || !ui) return "ui_changed";
    if (ui.icon === s.stopIcon || ui.control.querySelector(s.loading) || ui.input.value) {
      return "provider_busy";
    }
    return ui.icon === s.sendIcon && !ui.input.disabled ? "ready" : "ui_changed";
  }

  function observe(read, signal, timeout, code) {
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => finish(reject, fault(code)), timeout);
      const abort = () => finish(reject, fault("cancelled"));

      function finish(callback, value) {
        observer.disconnect();
        clearTimeout(timer);
        window.removeEventListener("popstate", check);
        signal.removeEventListener("abort", abort);
        callback(value);
      }

      function check() {
        try {
          const value = read();
          if (value !== undefined) finish(resolve, value);
        } catch (error) {
          finish(reject, error);
        }
      }

      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      window.addEventListener("popstate", check);
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
      check();
    });
  }

  async function prepare(mode, target) {
    preparedTurn = undefined;
    const status = state();
    if (status !== "ready") throw fault(status);
    const path = route();
    if (path !== (mode === "NEW_CHAT" ? "/" : target)) throw fault("conversation_changed");
    const rows = transcript(controls().input);
    if ((mode === "NEW_CHAT" && rows?.length) || (mode === "CONTINUE_CHAT" && !rows?.length)) {
      throw fault("conversation_changed");
    }
    const id = crypto.randomUUID();
    preparedTurn = { id, path, anchor: rows?.at(-1) };
    return { id };
  }

  async function submit(prepared, prompt, signal, timeout) {
    const turn = preparedTurn;
    preparedTurn = undefined;
    if (!turn || prepared?.id !== turn.id || route() !== turn.path) throw fault("conversation_changed");
    const status = state();
    if (status !== "ready") throw fault(status);
    const before = controls();
    if ((transcript(before.input)?.at(-1) ?? undefined) !== turn.anchor) throw fault("conversation_changed");
    const value = prompt.replace(/\r\n?/g, "\n");
    const expected = normalize(value);
    if (signal.aborted) throw fault("cancelled");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(before.input, value);
    before.input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    const ready = await observe(() => {
      const ui = controls();
      if (route() !== turn.path || !ui || ui.input !== before.input || ui.input.value !== value) {
        throw fault("conversation_changed");
      }
      if (ui.icon === s.sendIcon && !ui.control.matches(s.disabled) &&
          ui.control.getAttribute("aria-disabled") !== "true") return ui;
    }, signal, 2000, "input_unavailable");

    if (signal.aborted) throw fault("cancelled");
    const deadline = performance.now() + timeout;
    let conversation = turn.path === "/" ? null : turn.path;
    let confirmedUser;
    let generating = false;

    function newRows(input) {
      const rows = transcript(input);
      if (!rows) return null;
      const offset = turn.anchor ? rows.indexOf(turn.anchor) + 1 : 0;
      if (turn.anchor && !offset) throw fault("conversation_changed");
      const fresh = rows.slice(offset);
      if (fresh.length > 2) throw fault("conversation_changed");
      return fresh;
    }

    function response() {
      if (location.pathname === "/sign_in") throw fault("session_expired");
      const path = route();
      if (!path || (conversation && path !== conversation)) throw fault("conversation_changed");
      if (path === "/") return;
      conversation = path;
      const ui = controls();
      if (!ui) return;
      const [user, reply] = newRows(ui.input) ?? [];
      if (!user) return;
      if (user.querySelector(s.answer)) throw fault("conversation_changed");
      const matches = textOf(user) === expected ||
        Array.from(user.querySelectorAll("div,span,p,pre")).some(node => textOf(node) === expected);
      if (!matches) throw fault("conversation_changed");
      confirmedUser = user;
      if (ui.icon === s.stopIcon) generating = true;
      const answer = reply && unique(reply, s.answer);
      if (generating && answer && reply.matches(s.complete) &&
          ui.icon === s.sendIcon && ui.control.matches(s.disabled)) {
        const text = textOf(answer);
        if (text) return { status: "succeeded", answer: text, conversation };
      }
    }

    try {
      ready.control.click();
      const early = await observe(() => response() ?? (confirmedUser ? false : undefined),
        signal, Math.min(timeout, 12_000), "send_unconfirmed");
      if (early) return early;
      return await observe(response, signal, Math.max(0, deadline - performance.now()), "generation_timeout");
    } finally {
      if (generating && confirmedUser && route() === conversation) {
        const ui = controls();
        if (ui?.icon === s.stopIcon) {
          try {
            if (newRows(ui.input)?.[0] === confirmedUser) ui.control.click();
          } catch {
            // Ownership can no longer be established after the dialog changes.
          }
        }
      }
    }
  }

  globalThis.liveDeepSeekAdapter = { state, prepare, submit, gates, route };
})();
