(() => {
  const selectors = globalThis.mockSelectors;
  const errors = new Set([
    "server_error", "generation_interrupted", "usage_limited", "connection_lost",
  ]);
  const gates = new Set(["login_required", "session_expired", "captcha", "usage_limited"]);

  function fault(code) {
    return Object.assign(new Error(code), { code });
  }

  function controls() {
    const elements = {};
    for (const name of ["chat", "input", "send", "messages", "stop", "newChat", "error", "auth"]) {
      elements[name] = document.querySelector(selectors[name]);
    }
    return Object.values(elements).every(Boolean) ? elements : null;
  }

  function state() {
    const ui = controls();
    if (!ui) return "ui_changed";
    const gate = ui.auth.dataset.state;
    if (gates.has(gate)) return gate;
    return ui.stop.hidden ? "ready" : "provider_busy";
  }

  function currentConversation(ui) {
    if (location.hash !== "#chat/" + ui.chat.dataset.conversation) {
      throw fault("conversation_changed");
    }
    return ui.chat.dataset.conversation;
  }

  function observe(read, signal, timeout, timeoutCode) {
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => settle(reject, fault(timeoutCode)), timeout);
      const abort = () => settle(reject, fault("cancelled"));

      function settle(callback, value) {
        observer.disconnect();
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        window.removeEventListener("hashchange", check);
        callback(value);
      }

      function check() {
        try {
          const value = read();
          if (value !== undefined) settle(resolve, value);
        } catch (error) {
          settle(reject, error);
        }
      }

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      window.addEventListener("hashchange", check);
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
      check();
    });
  }

  async function prepare(mode, conversation) {
    const status = state();
    if (status !== "ready") throw fault(status);
    const ui = controls();
    if (ui.input.disabled || ui.input.value) throw fault("input_unavailable");
    const previous = currentConversation(ui);
    if (mode === "NEW_CHAT") {
      ui.newChat.click();
      await observe(() => {
        const next = controls();
        if (!next) throw fault("ui_changed");
        if (next.chat.dataset.conversation === previous) return;
        return currentConversation(next);
      }, null, 2500, "conversation_changed");
    } else if (previous !== conversation) {
      if (!/^[0-9a-f-]{36}$/.test(conversation ?? "")) throw fault("conversation_changed");
      location.hash = "chat/" + conversation;
      await observe(() => {
        const next = controls();
        if (!next) throw fault("ui_changed");
        if (next.chat.dataset.conversation !== conversation) return;
        return currentConversation(next);
      }, null, 2500, "conversation_changed");
    }
    const active = controls();
    return {
      conversation: currentConversation(active),
      revision: active.messages.lastElementChild?.dataset.messageId ?? null,
    };
  }

  async function submit(prepared, prompt, signal, timeout) {
    const status = state();
    if (status !== "ready") throw fault(status);
    const ui = controls();
    const conversation = currentConversation(ui);
    if (conversation !== prepared.conversation ||
        (ui.messages.lastElementChild?.dataset.messageId ?? null) !== prepared.revision) {
      throw fault("conversation_changed");
    }
    if (signal.aborted) throw fault("cancelled");
    if (ui.input.disabled || ui.input.value) throw fault("input_unavailable");

    const oldMessages = new Set(Array.from(ui.messages.children, node => node.dataset.messageId));
    const previousError = ui.error.dataset.code;
    const expected = prompt.replace(/\r\n?/g, "\n");
    ui.input.value = expected;
    ui.input.dispatchEvent(new Event("input", { bubbles: true }));
    if (ui.input.value !== expected || ui.send.disabled) throw fault("input_unavailable");

    const deadline = performance.now() + timeout;
    let userId;
    try {
      ui.send.click();
      userId = await observe(() => {
        if (currentConversation(ui) !== conversation) throw fault("conversation_changed");
        const freshUsers = Array.from(ui.messages.querySelectorAll(selectors.user))
          .filter(node => !oldMessages.has(node.dataset.messageId));
        if (freshUsers.length > 1) throw fault("conversation_changed");
        const sent = freshUsers[0];
        if (!sent) {
          const code = ui.error.dataset.code;
          if (code !== previousError && errors.has(code)) throw fault(code);
          return;
        }
        if (sent.textContent !== expected || !sent.dataset.messageId) throw fault("send_unconfirmed");
        return sent.dataset.messageId;
      }, signal, Math.min(timeout, 4000), "send_unconfirmed");

      return await observe(() => {
        if (currentConversation(ui) !== conversation) throw fault("conversation_changed");
        const live = controls();
        if (!live || live.messages !== ui.messages || live.stop !== ui.stop) throw fault("ui_changed");
        const newUsers = Array.from(ui.messages.querySelectorAll(selectors.user))
          .filter(node => !oldMessages.has(node.dataset.messageId));
        if (newUsers.length !== 1 || newUsers[0].dataset.messageId !== userId) {
          throw fault("conversation_changed");
        }
        const gate = ui.auth.dataset.state;
        if (gates.has(gate)) throw fault(gate);
        const responses = Array.from(ui.messages.querySelectorAll(selectors.assistant))
          .filter(node => node.dataset.replyTo === userId && !oldMessages.has(node.dataset.messageId));
        if (responses.length > 1) throw fault("conversation_changed");
        const response = responses[0];
        if (!response) return;
        if (response.dataset.state === "failed") {
          const code = ui.error.dataset.code;
          throw fault(errors.has(code) ? code : "server_error");
        }
        if (response.dataset.state === "complete" && ui.stop.hidden) {
          const answer = response.querySelector(selectors.plain)?.textContent;
          if (!answer) throw fault("generation_interrupted");
          return {
            status: "succeeded",
            answer,
            markdown: response.querySelector(selectors.markdown)?.textContent || null,
          };
        }
      }, signal, Math.max(0, deadline - performance.now()), "generation_timeout");
    } finally {
      const ownsCurrentResponse = Array.from(ui.messages.querySelectorAll(selectors.assistant))
        .some(node => node.dataset.replyTo === userId && node.dataset.state === "streaming");
      if (location.hash === "#chat/" + conversation && ownsCurrentResponse && !ui.stop.hidden) {
        ui.stop.click();
      }
    }
  }

  globalThis.mockAdapter = { state, prepare, submit, gates };
})();
