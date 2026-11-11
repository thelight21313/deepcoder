const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const { promisify } = require("node:util");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const BASE = "http://127.0.0.1:8765";
const MOCK = BASE + "/mock/";
const python = process.env.BRIDGE_TEST_PYTHON;
const nativeLauncher = process.env.BRIDGE_TEST_NATIVE_LAUNCHER;
const state = process.env.DEEPSEEK_BRIDGE_STATE;
const extensionId = process.env.DEEPSEEK_BRIDGE_EXTENSION_ID;
const extensionURL = "chrome-extension://" + extensionId + "/";
const storage = new Map();
const run = promisify(execFile);
let server;
let page;
let worker;
let token;

function spawnBridge() {
  let logs = "";
  const process = spawn(python, ["-m", "bridge.main"], { stdio: ["ignore", "ignore", "pipe"] });
  process.stderr.on("data", chunk => { logs += chunk; });
  return { process, logs: () => logs };
}

async function stopBridge() {
  if (!server || server.process.exitCode !== null) return;
  const closed = once(server.process, "close");
  server.process.kill();
  await closed;
}

async function eventually(check, message, limit = 8000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await wait(30);
  }
  throw new Error(message);
}

async function startBridge() {
  server = spawnBridge();
  await eventually(async () => {
    if (server.process.exitCode !== null) throw new Error(server.logs());
    try {
      token = readFileSync(join(state, "token"), "utf8").trim();
      return (await api("/v1/overview")).tasks;
    } catch {
      return false;
    }
  }, "Bridge did not start");
}

async function api(path, body) {
  const headers = { Authorization: "Bearer " + token };
  const options = { headers };
  if (body !== undefined) {
    options.method = "POST";
    options.body = body === "" ? "" : JSON.stringify(
      path === "/v1/tasks" ? { provider: "mock", ...body } : body,
    );
    headers["Content-Type"] = "application/json";
  }
  const reply = await fetch(BASE + path, options);
  assert.ok(reply.ok, reply.status + " " + path);
  return reply.json();
}

function status(task) {
  return api("/v1/tasks/" + task.task_id + "/result");
}

function finished(task, expected) {
  return eventually(async () => {
    const result = await status(task);
    if (["queued", "leased", "running"].includes(result.status)) return false;
    assert.equal(result.status, expected, JSON.stringify(result));
    return result;
  }, "Task did not finish: " + task.task_id);
}

function event() {
  const listeners = [];
  return { addListener: callback => listeners.push(callback), emit: (...args) => {
    for (const listener of listeners) listener(...args);
  } };
}

function nativePort() {
  const native = spawn(nativeLauncher, [extensionURL], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const onMessage = event();
  const onDisconnect = event();
  let buffer = Buffer.alloc(0);
  native.on("close", () => onDisconnect.emit());
  native.stdin.on("error", () => {});
  native.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE();
      if (buffer.length < size + 4) break;
      onMessage.emit(JSON.parse(buffer.subarray(4, size + 4)));
      buffer = buffer.subarray(size + 4);
    }
  });
  return {
    onMessage, onDisconnect, close: () => native.stdin.end(),
    postMessage(message) {
      const data = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(data.length);
      native.stdin.write(Buffer.concat([header, data]));
    },
  };
}

async function openPage() {
  const response = await fetch(MOCK);
  assert.equal(response.status, 200);
  const dom = new JSDOM(await response.text(), { url: MOCK, runScripts: "outside-only" });
  let handler;
  dom.window.chrome = {
    runtime: {
      id: extensionId,
      onMessage: { addListener: listener => { handler = listener; } },
    },
  };
  const mock = await fetch(MOCK + "mock.js");
  assert.equal(mock.status, 200);
  dom.window.eval(await mock.text());
  for (const script of ["adapters/selectors.js", "adapters/deepseek.js", "content.js"]) {
    dom.window.eval(readFileSync("chrome-extension/" + script, "utf8"));
  }
  return {
    dom,
    scenario(value) {
      const select = dom.window.document.querySelector("#scenario");
      select.value = value;
      select.dispatchEvent(new dom.window.Event("change"));
    },
    send(message) {
      return new Promise(resolve => {
        const waiting = handler(message, { id: extensionId }, resolve);
        if (!waiting) resolve();
      });
    },
  };
}

function startWorker() {
  const timers = new Set();
  const ports = new Set();
  const workerSetTimeout = (callback, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      callback();
    }, ms);
    timers.add(id);
    return id;
  };
  let stopped = false;
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: path => extensionURL + path,
      onMessage: event(),
      connectNative(name) {
        assert.equal(name, "com.deepseek.bridge");
        const port = nativePort();
        ports.add(port);
        port.onDisconnect.addListener(() => ports.delete(port));
        return port;
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: page.dom.window.location.href }],
      get: async () => ({ id: 1 }),
      sendMessage: async (id, message) => {
        assert.equal(id, 1);
        return page.send(message);
      },
    },
    storage: {
      local: {
        get: async key => ({ [key]: storage.get(key) }),
        set: async values => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        },
      },
    },
    action: { setBadgeText: async () => {} },
    alarms: { onAlarm: event(), create() {} },
  };
  vm.runInNewContext(readFileSync("chrome-extension/background.js", "utf8"), {
    chrome, URL, crypto: { randomUUID }, clearTimeout,
    setTimeout: (callback, ms) => stopped ? undefined : workerSetTimeout(callback, ms),
  });
  return {
    disconnect() {
      for (const port of ports) port.close();
    },
    close() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      this.disconnect();
    },
  };
}

async function main() {
  await startBridge();
  page = await openPage();
  const tasks = [];
  for (let index = 1; index <= 100; index += 1) {
    tasks.push(await api("/v1/tasks", { prompt: "Задание " + index + "\nВторая строка" }));
  }
  worker = startWorker();
  for (const task of tasks) {
    const result = await finished(task, "succeeded");
    assert.equal(result.answer, "Тестовый ответ 1\n\n" + task.prompt);
  }
  assert.equal(new Set(tasks.map(task => task.conversation_id)).size, 100);
  console.log("100 sequential tasks returned the matching multiline response");

  page.scenario("markdown");
  const followUp = await api("/v1/tasks", {
    prompt: "Продолжение", mode: "CONTINUE_CHAT", conversation_id: tasks[0].conversation_id,
  });
  const result = await finished(followUp, "succeeded");
  assert.match(result.answer, /Тестовый ответ 2/);
  assert.match(result.markdown, /print\('bridge'\)/);
  assert.match(result.markdown, /\| Bridge \| Готов \|/);
  const document = page.dom.window.document;
  assert.equal(document.querySelector("[data-role=assistant] pre code").textContent, "print('bridge')");
  assert.equal(document.querySelectorAll("[data-role=assistant] li").length, 2);
  assert.equal(document.querySelector("table tbody td").textContent, "Bridge");

  page.scenario("long");
  const long = await api("/v1/tasks", { prompt: "Длинный ответ" });
  assert.ok((await finished(long, "succeeded")).answer.length > 5000);

  page.scenario("captcha");
  const paused = await api("/v1/tasks", { prompt: "Пауза" });
  assert.equal((await finished(paused, "paused")).error, "captcha");
  page.scenario("normal");
  await api("/v1/tasks/" + paused.task_id + "/resume", "");
  await finished(paused, "succeeded");

  page.scenario("server_error");
  const failed = await api("/v1/tasks", { prompt: "Ошибка" });
  assert.equal((await finished(failed, "failed")).error, "server_error");

  page.scenario("generation_interrupted");
  const interrupted = await api("/v1/tasks", { prompt: "Прерывание" });
  assert.equal((await finished(interrupted, "uncertain")).error, "generation_interrupted");

  page.scenario("hang");
  const cancelled = await api("/v1/tasks", { prompt: "Отмена" });
  await eventually(() => !page.dom.window.document.querySelector("[data-bridge-stop]").hidden,
    "Mock did not begin streaming");
  await api("/v1/tasks/" + cancelled.task_id + "/cancel", "");
  await finished(cancelled, "cancelled");

  const moved = await api("/v1/tasks", { prompt: "Смена диалога" });
  await eventually(() => !document.querySelector("[data-bridge-stop]").hidden,
    "Mock did not start the second stream");
  document.querySelector("[data-bridge-new]").click();
  assert.equal((await finished(moved, "uncertain")).error, "conversation_changed");
  const delayed = await page.send({ type: "submit", sendBefore: Date.now() - 1 });
  assert.equal(delayed.error, "generation_timeout");
  assert.equal(document.querySelectorAll("[data-role=user]").length, 0);

  page.scenario("ui_changed");
  const changed = await api("/v1/tasks", { prompt: "Смена DOM" });
  assert.equal((await finished(changed, "uncertain")).error, "ui_changed");
  page.dom.window.close();
  page = await openPage();

  await api("/v1/processing/pause", "");
  const persisted = await api("/v1/tasks", { prompt: "Перезапуск Bridge" });
  await stopBridge();
  await startBridge();
  assert.equal((await status(persisted)).status, "queued");
  await api("/v1/processing/resume", "");
  await finished(persisted, "succeeded");

  worker.close();
  worker = startWorker();
  const restored = await api("/v1/tasks", {
    prompt: "Перезапуск service worker", mode: "CONTINUE_CHAT",
    conversation_id: persisted.conversation_id,
  });
  assert.match((await finished(restored, "succeeded")).answer, /Тестовый ответ 2/);

  worker.disconnect();
  const { stdout } = await run(python, ["-c", [
    "import asyncio",
    "from bridge.client import bridge",
    'result = asyncio.run(bridge.ask(provider="mock", prompt="Проверка Python-клиента", timeout=12))',
    'assert result.status == "succeeded", result',
    "print(result.answer)",
  ].join("\n")]);
  assert.match(stdout, /Тестовый ответ 1\s+Проверка Python-клиента/);

  const dashboard = new JSDOM(await (await fetch(BASE)).text(), {
    url: BASE, runScripts: "outside-only",
  });
  try {
    dashboard.window.fetch = (path, options) => fetch(new URL(path, BASE), options);
    dashboard.window.eval(await (await fetch(BASE + "/dashboard.js")).text());
    const view = dashboard.window.document;
    view.querySelector("#token").value = token;
    view.querySelector("#auth").dispatchEvent(new dashboard.window.Event("submit", { cancelable: true }));
    await eventually(() => !view.querySelector("#overview").hidden, "Dashboard did not connect");
    assert.equal(view.querySelector("#history strong").textContent, "Проверка Python-клиента");
    view.querySelector('[data-action="pause"]').click();
    await eventually(async () => !(await api("/v1/overview?limit=0")).enabled,
      "Dashboard pause did not reach the API");
  } finally {
    dashboard.window.close();
  }
  console.log("Verified conversation isolation, pauses, failures, cancellation and recovery");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  worker?.close();
  page?.dom.window.close();
  await stopBridge();
});
