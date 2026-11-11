const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

function iconHash(path) {
  let hash = 2166136261;
  for (const character of path) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

test("DeepSeek adapter follows the observed DOM across new and continued chats", async () => {
  const page = new JSDOM(`
    <div id="root">
      <div class="_020ab5b">
        <textarea class="_27c9245"></textarea>
        <div role="button" class="ds-button--primary ds-button--circle ds-button--disabled">
          <div><svg><path d="M1 1"></path></svg></div>
        </div>
      </div>
    </div>
  `, { url: "https://chat.deepseek.com/", runScripts: "outside-only" });
  const { window } = page;
  try {
    for (const script of ["live-selectors.js", "live-deepseek.js"]) {
      if (script === "live-deepseek.js") {
        // Synthetic SVG paths let the fixture drive the observed icon states.
        window.deepSeekSelectors = {
          ...window.deepSeekSelectors, sendIcon: iconHash("M1 1"), stopIcon: iconHash("M2 2"),
        };
      }
      window.eval(readFileSync("chrome-extension/adapters/" + script, "utf8"));
    }
    const document = window.document;
    const adapter = window.liveDeepSeekAdapter;
    const input = document.querySelector("textarea");
    const button = document.querySelector("[role=button]");
    const svgPath = button.querySelector("path");
    const root = document.querySelector("#root");
    const composer = document.querySelector("._020ab5b");
    let rows;
    let wrongUser = false;

    input.addEventListener("input", () => button.classList.remove("ds-button--disabled"));
    button.addEventListener("click", () => {
      if (svgPath.getAttribute("d") !== "M1 1") return;
      if (!rows) {
        const list = document.createElement("div");
        list.className = "ds-virtual-list--printable";
        rows = document.createElement("div");
        rows.className = "ds-virtual-list-visible-items";
        list.append(rows, composer);
        root.append(list);
        window.history.pushState(null, "", "/a/chat/s/local-test");
      }
      const user = document.createElement("div");
      user.textContent = wrongUser ? "different prompt" : input.value;
      rows.append(user);
      input.value = "";
      svgPath.setAttribute("d", "M2 2");
      if (wrongUser) return;
      const reply = document.createElement("div");
      reply.innerHTML = '<div class="ds-message"><div class="ds-assistant-message-main-content"></div></div>';
      rows.append(reply);
      window.setTimeout(() => {
        reply.querySelector(".ds-assistant-message-main-content").textContent = "ответ " + rows.children.length;
        reply.className = "_43c05b5";
        svgPath.setAttribute("d", "M1 1");
        button.classList.add("ds-button--disabled");
      }, 25);
    });

    const signal = new window.AbortController().signal;
    assert.equal(adapter.state(), "ready");
    const fresh = await adapter.prepare("NEW_CHAT");
    const first = await adapter.submit(fresh, "строка один\nстрока два", signal, 1000);
    assert.equal(first.answer, "ответ 2");
    assert.equal(first.conversation, "/a/chat/s/local-test");
    const followUp = await adapter.prepare("CONTINUE_CHAT", first.conversation);
    const second = await adapter.submit(followUp, "продолжение", signal, 1000);
    assert.equal(second.answer, "ответ 4");
    assert.equal(second.conversation, first.conversation);

    wrongUser = true;
    const changed = await adapter.prepare("CONTINUE_CHAT", first.conversation);
    await assert.rejects(adapter.submit(changed, "мой запрос", signal, 1000),
      error => error.code === "conversation_changed");
    window.history.pushState(null, "", "/sign_in");
    assert.equal(adapter.state(), "login_required");
  } finally {
    page.window.close();
  }
});
