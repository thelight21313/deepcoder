const MOCK_URL = "http://127.0.0.1:8765/mock/";
const DEEPSEEK_ORIGIN = "https://chat.deepseek.com";
const deepSeekRoute = /^\/a\/chat\/s\/[a-z0-9_-]+$/i;
const HOST = "com.deepseek.bridge";
const ALARM = "bridge-reconnect";
const pending = new Map();
let port;
let scheduled;
let running = false;
let current = { connected: false, state: "disconnected" };

function publish(connected, state) {
  current = { connected, state };
  const attention = ["login_required", "session_expired", "captcha", "usage_limited"];
  chrome.action.setBadgeText({ text: attention.includes(state) ? "!" : "" }).catch(() => {});
}

function connect() {
  if (port) return port;
  const opened = chrome.runtime.connectNative(HOST);
  port = opened;
  opened.onMessage.addListener(message => {
    if (port !== opened) return;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  opened.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port !== opened) return;
    port = undefined;
    publish(false, "disconnected");
    for (const request of pending.values()) request.reject(new Error("connection_lost"));
    schedule(2000);
  });
  return opened;
}

function rpc(method, body, taskId) {
  const native = connect();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error("bridge_timeout")), 4200);
    function finish(callback, value) {
      clearTimeout(timer);
      pending.delete(id);
      callback(value);
    }
    pending.set(id, {
      resolve: value => finish(resolve, value),
      reject: error => finish(reject, error),
    });
    try {
      native.postMessage({ id, method, body, task_id: taskId });
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function browserTab(provider) {
  const live = provider === "deepseek";
  const tabs = await chrome.tabs.query({ url: live ? DEEPSEEK_ORIGIN + "/*" : "http://127.0.0.1/mock/*" });
  const candidates = tabs.filter(candidate => {
    try {
      const url = new URL(candidate.url);
      return live ? url.origin === DEEPSEEK_ORIGIN : url.href.split("#")[0] === MOCK_URL;
    } catch {
      return false;
    }
  });
  if (live && candidates.length > 1) return { state: "ui_changed" };
  const tab = candidates[0];
  if (!tab) return { state: "tab_missing" };
  if (tab.discarded || tab.frozen) return { state: "connection_lost", tab };
  if (live && new URL(tab.url).pathname === "/sign_in") return { state: "login_required", tab };
  try {
    return { ...(await sendToTab(tab.id, { type: "inspect" }, 1400)), tab };
  } catch {
    return { state: "connection_lost", tab };
  }
}

async function loadDeepSeekChat(tab, target) {
  if (new URL(tab.url).pathname === target) return { state: "ready" };
  await chrome.tabs.update(tab.id, { url: DEEPSEEK_ORIGIN + target });
  const deadline = Date.now() + 5500;
  while (Date.now() < deadline) {
    const actual = await chrome.tabs.get(tab.id);
    if (actual.url && new URL(actual.url).pathname === "/sign_in") {
      return { state: "login_required" };
    }
    const status = await sendToTab(tab.id, { type: "inspect" }, 700).catch(() => null);
    if (status?.route === target && status.state === "ready") return status;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return { state: "connection_lost" };
}

function unavailable(state) {
  if (["login_required", "session_expired", "captcha", "usage_limited"].includes(state)) {
    return { status: "paused", error: state };
  }
  return { status: state === "ui_changed" ? "failed" : "retry", error: state };
}

async function execute(task, browser, phase) {
  if (browser.state !== "ready") return unavailable(browser.state);
  const deadline = Date.now() + task.timeout_ms;
  const tabId = browser.tab.id;
  const key = "chat:" + task.conversation_id;
  const previous = (await chrome.storage.local.get(key))[key];
  const live = task.provider === "deepseek";
  if (task.mode === "CONTINUE_CHAT" && !previous) {
    return { status: "failed", error: "conversation_changed" };
  }
  if (live) {
    const target = task.mode === "NEW_CHAT" ? "/" : previous;
    if (target !== "/" && !deepSeekRoute.test(target)) {
      return { status: "failed", error: "conversation_changed" };
    }
    const loaded = await loadDeepSeekChat(browser.tab, target);
    if (loaded.state !== "ready") return unavailable(loaded.state);
  }
  const preparation = await sendToTab(tabId, {
    type: "prepare", mode: task.mode, conversation: previous,
  });
  if (!preparation.prepared) return preparation;
  if (!live && task.mode === "NEW_CHAT") {
    await chrome.storage.local.set({ [key]: preparation.prepared.conversation });
  }

  const body = { lease: task.lease };
  if (deadline - Date.now() <= 6000) return { status: "failed", error: "generation_timeout" };
  phase.started = true;
  const start = await rpc("start", body, task.task_id);
  if (start.cancel_requested) return { status: "cancelled" };

  const timeout = Math.max(1, deadline - Date.now() - 4000);
  let timer;
  let stopping = false;
  const abort = () => sendToTab(tabId, {
    type: "abort", id: task.task_id,
  }, 1000).catch(() => {});

  const heartbeat = async () => {
    try {
      const status = await rpc("heartbeat", body, task.task_id);
      if (status.cancel_requested) await abort();
    } catch {
      await abort();
    } finally {
      if (!stopping) timer = setTimeout(heartbeat, 1500);
    }
  };

  try {
    timer = setTimeout(heartbeat, 1500);
    const { conversation, ...outcome } = await sendToTab(tabId, {
      type: "submit", id: task.task_id, prepared: preparation.prepared,
      prompt: task.prompt, timeout, sendBefore: Math.min(deadline - 3000, Date.now() + 3000),
    }, timeout + 1600);
    if (live && outcome.status === "succeeded") {
      if (!deepSeekRoute.test(conversation ?? "") || (previous && previous !== conversation)) {
        return { status: "uncertain", error: "conversation_changed" };
      }
      await chrome.storage.local.set({ [key]: conversation });
    }
    return outcome;
  } catch (error) {
    if (error.message !== "tab_timeout") throw error;
    await abort();
    return { status: "uncertain", error: "generation_timeout" };
  } finally {
    stopping = true;
    clearTimeout(timer);
  }
}

async function sendToTab(tabId, message, timeout = 4000) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("tab_timeout")), timeout);
      }),
    ]);
  } catch (error) {
    if (error.message === "tab_timeout") throw error;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    throw new Error(tab ? "connection_lost" : "tab_closed");
  } finally {
    clearTimeout(timer);
  }
}

function schedule(delay) {
  clearTimeout(scheduled);
  scheduled = setTimeout(tick, delay);
}

async function tick() {
  if (running) return;
  running = true;
  let next = 850;
  try {
    const [mock, deepseek] = await Promise.all([browserTab("mock"), browserTab("deepseek")]);
    const status = deepseek.state === "tab_missing" ? mock.state : deepseek.state;
    const task = await rpc("claim", { state: status, protocol_version: 2 });
    publish(true, status);
    if (task) {
      const phase = { started: false };
      let outcome;
      try {
        outcome = await execute(task, task.provider === "deepseek" ? deepseek : mock, phase);
      } catch (error) {
        outcome = {
          status: phase.started ? "uncertain" : "retry",
          error: error.message === "tab_closed" ? "tab_closed" : "connection_lost",
        };
      }
      await rpc("finish", { ...outcome, lease: task.lease }, task.task_id);
      next = 0;
    }
  } catch {
    publish(false, "disconnected");
    next = 2000;
  } finally {
    running = false;
    schedule(next);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) {
    return false;
  }
  if (message?.type === "status") {
    respond(current);
  }
  return false;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) schedule(0);
});
chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
schedule(0);
