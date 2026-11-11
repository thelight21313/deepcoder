const adapter = location.origin === "https://chat.deepseek.com" ? globalThis.liveDeepSeekAdapter :
  location.origin === "http://127.0.0.1:8765" && location.pathname === "/mock/" ?
    globalThis.mockAdapter : null;
if (adapter) {
  let active;

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !message?.type) return false;
    if (message.type === "inspect") {
      respond({ state: active ? "provider_busy" : adapter.state(), route: adapter.route?.() });
      return false;
    }
    if (message.type === "abort") {
      if (active?.id === message.id) active.controller.abort();
      respond({});
      return false;
    }
    if (message.type === "prepare") {
      adapter.prepare(message.mode, message.conversation).then(
        prepared => respond({ prepared }),
        error => respond({
          status: adapter.gates.has(error.code) ? "paused" :
            error.code === "provider_busy" ? "retry" : "failed",
          error: error.code ?? "ui_changed",
        }),
      );
      return true;
    }
    if (message.type === "submit") {
      if (!Number.isFinite(message.sendBefore) || Date.now() >= message.sendBefore) {
        respond({ status: "failed", error: "generation_timeout" });
        return false;
      }
      if (active) {
        respond({ status: "uncertain", error: "provider_busy" });
        return false;
      }
      const controller = new AbortController();
      active = { id: message.id, controller };
      adapter.submit(message.prepared, message.prompt, controller.signal, message.timeout).then(
        result => respond(result),
        error => respond(error.code === "cancelled" ? { status: "cancelled" } : {
          status: error.code === "server_error" ? "failed" : "uncertain",
          error: error.code ?? "ui_changed",
        }),
      ).finally(() => { active = null; });
      return true;
    }
    return false;
  });
}
