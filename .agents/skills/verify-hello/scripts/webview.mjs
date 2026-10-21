// `webview ID snapshot|click|fill|eval` for the mac and ios targets.
//
// mac: snapshot, click and fill go through the macOS Accessibility API (a small native helper
// built on first use), so a click is an AXPress on the WebKit element and a fill sets the
// field's AXValue, the way VoiceOver drives a page. eval runs JavaScript in the page world
// through a library the harness loads into the app with DYLD_INSERT_LIBRARIES; it answers
// only where dyld honors that (debug builds and any build without the hardened runtime).
//
// ios: everything goes through the WebKit remote inspector of the simulator (the protocol
// Safari's Develop menu uses), so snapshot, click and fill run in the page with a user gesture.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { openInspector } from "./webkit-inspector.mjs";

const NATIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), "native");

/** Compiles `native/<name>.m` once per source hash into `<toolsDir>`; returns the path. */
export function nativeTool(toolsDir, name, { dylib = false } = {}) {
  const source = join(NATIVE_DIR, `${name}.m`);
  const hash = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex")
    .slice(0, 12);
  const out = join(toolsDir, `${name}-${hash}${dylib ? ".dylib" : ""}`);
  if (existsSync(out)) return out;
  mkdirSync(toolsDir, { recursive: true });
  const frameworks = dylib
    ? ["-framework", "AppKit", "-framework", "WebKit", "-framework", "Foundation"]
    : [
        "-framework",
        "AppKit",
        "-framework",
        "ApplicationServices",
        "-framework",
        "Foundation",
      ];
  const result = spawnSync(
    "/usr/bin/clang",
    [
      "-fobjc-arc",
      "-O2",
      ...(dylib ? ["-dynamiclib"] : []),
      ...frameworks,
      source,
      "-o",
      out,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`compiling ${name} failed:\n${result.stderr}`);
  return out;
}

/** Wraps an axi-style expression (a value, or a function that is called and awaited) as a body returning JSON. */
export function evalBody(js) {
  return `const __f = (${js});
const __v = typeof __f === 'function' ? await __f() : await __f;
return __v === undefined ? '{"undefined":true}' : JSON.stringify({ value: __v });`;
}

function decodeResult(text) {
  const parsed = JSON.parse(text);
  return parsed.undefined ? undefined : parsed.value;
}

/** In-page accessibility view for the ios target: roles and names as ARIA computes them. */
const DOM_LIB = `(() => {
  const visible = (el) => { if (!el.getClientRects().length) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'INPUT') { const t = (el.type || 'text').toLowerCase(); if (t === 'checkbox') return 'checkbox'; if (t === 'radio') return 'radio'; if (['button','submit','reset'].includes(t)) return 'button'; if (t === 'hidden') return null; return 'textbox'; }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'OL' || tag === 'UL') return 'list';
    if (tag === 'LI') return 'listitem';
    if (tag === 'DIALOG') return 'dialog';
    if ((tag === 'SECTION' || tag === 'ASIDE' || tag === 'NAV' || tag === 'MAIN') && el.hasAttribute('aria-label')) return 'region';
    return null;
  };
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label'); if (label) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\\s+/).map((id) => text(document.getElementById(id) || document.createElement('i'))).join(' ').trim();
    if (el.labels && el.labels.length) return text(el.labels[0]);
    const role = roleOf(el);
    if (['button','link','heading','listitem','checkbox','radio','option','menuitem','tab'].includes(role)) { const t = text(el); if (t) return t; }
    return (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
  };
  const all = () => [...document.querySelectorAll('*')].filter((el) => roleOf(el) && visible(el));
  const describe = (el) => {
    const role = roleOf(el);
    const node = { role, name: nameOf(el) };
    if (role === 'textbox') node.value = el.value ?? '';
    if (role === 'combobox' && el.options) { node.value = el.selectedOptions[0]?.textContent.trim() ?? ''; node.options = [...el.options].map((o) => ({ text: o.textContent.trim(), value: o.value, selected: o.selected, disabled: o.disabled })); }
    if (role === 'checkbox') node.checked = !!el.checked;
    if (el.disabled) node.disabled = true;
    if (el.dataset && el.dataset.itemId) node.itemId = el.dataset.itemId;
    return node;
  };
  const snapshot = () => {
    const lines = [];
    const walk = (node, depth) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const t = child.textContent.replace(/\\s+/g, ' ').trim();
          if (t && child.parentElement && visible(child.parentElement) && !roleOf(child.parentElement)) lines.push('  '.repeat(depth) + '- text ' + JSON.stringify(t));
          continue;
        }
        if (child.nodeType !== 1 || !visible(child)) continue;
        const role = roleOf(child);
        if (!role) { walk(child, depth); continue; }
        const d = describe(child);
        let line = '  '.repeat(depth) + '- ' + role + ' ' + JSON.stringify(d.name);
        if (d.value !== undefined && d.value !== '') line += ': ' + JSON.stringify(d.value);
        if (d.checked) line += ' checked';
        if (d.disabled) line += ' disabled';
        if (d.itemId) line += ' [item=' + d.itemId + ']';
        lines.push(line);
        if (!['button','link','textbox','combobox','checkbox','heading','option'].includes(role)) walk(child, depth + 1);
      }
    };
    walk(document.body, 0);
    return { url: location.href, title: document.title, lines, nodes: all().map(describe) };
  };
  const find = (role, name) => {
    const found = all().filter((el) => roleOf(el) === role && nameOf(el) === name);
    if (found.length !== 1) throw new Error(found.length + ' elements match ' + role + ' ' + JSON.stringify(name) + '; ' + role + 's: ' + JSON.stringify(all().filter((el) => roleOf(el) === role).map(nameOf)));
    return found[0];
  };
  const click = (role, name) => { const el = find(role, name); el.scrollIntoView({ block: 'center' }); if (el.focus) el.focus(); el.click(); return describe(el); };
  const fill = (role, name, value) => {
    const el = find(role, name);
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find((o) => o.textContent.trim() === value || o.value === value);
      if (!option) throw new Error('no option ' + JSON.stringify(value) + ' in ' + JSON.stringify([...el.options].map((o) => o.textContent.trim())));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
    } else if (el.type === 'checkbox') {
      if (String(el.checked) !== String(value === 'true' || value === true)) el.click();
      return describe(el);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return describe(el);
  };
  return { snapshot, find, click, fill, describe };
})()`;

const AX_ROLES = {
  AXButton: "button",
  AXTextField: "textbox",
  AXTextArea: "textbox",
  AXSecureTextField: "textbox",
  AXPopUpButton: "combobox",
  AXComboBox: "combobox",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXLink: "link",
  AXHeading: "heading",
  AXStaticText: "text",
  AXList: "list",
  AXMenu: "menu",
  AXMenuItem: "menuitem",
  AXWebArea: "document",
  AXSheet: "dialog",
  AXImage: "img",
  AXTabGroup: "tablist",
};

function axRole(node) {
  if (node.role === "AXWindow") return node.subrole === "AXDialog" ? "dialog" : "window";
  if (node.role === "AXGroup" && node.subrole === "AXLandmarkRegion") return "region";
  if (node.role === "AXGroup" && node.subrole === "AXApplicationDialog") return "dialog";
  return AX_ROLES[node.role] ?? (node.desc || node.title ? "group" : null);
}

function axName(node) {
  if (node.role === "AXStaticText") return node.value ?? node.title ?? node.desc ?? "";
  return node.title ?? node.desc ?? node.placeholder ?? node.help ?? "";
}

/** The AX tree flattened to `{path, role, name, value, ...}` with roles named as ARIA does. */
export function axNodes(tree) {
  const out = [];
  const walk = (node, depth, windowIndex) => {
    const role = axRole(node);
    if (role) {
      out.push({
        path: node.path,
        window: windowIndex,
        depth,
        role,
        axRole: node.role,
        subrole: node.subrole,
        name: axName(node),
        value: ["AXStaticText", "AXHeading"].includes(node.role) ? undefined : node.value,
        disabled: node.disabled ?? false,
        focused: node.focused ?? false,
        frame: node.frame,
      });
    }
    for (const child of node.children ?? [])
      walk(child, role ? depth + 1 : depth, windowIndex);
  };
  tree.windows.forEach((window, i) => walk(window, 0, i));
  return out;
}

export function axSnapshotText(nodes) {
  return nodes
    .map((n) => {
      let line = `${"  ".repeat(n.depth)}- ${n.role} ${JSON.stringify(n.name)}`;
      if (n.value !== undefined && n.value !== "" && n.role !== "text")
        line += `: ${JSON.stringify(n.value)}`;
      if (n.disabled) line += " disabled";
      if (n.focused) line += " focused";
      return line;
    })
    .join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWebview({
  fail,
  readState,
  appProcess,
  webviewSocket,
  toolsDir,
  bundleId,
}) {
  const ax = (args) => {
    const tool = nativeTool(toolsDir, "webview-ax");
    const result = spawnSync(tool, args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0)
      fail(`webview-ax ${args[0]} failed: ${result.stderr.trim()}`);
    return JSON.parse(result.stdout);
  };

  const macPid = (state) => {
    const app = appProcess(state);
    if (!app) fail(`the ${state.id} app is not running`);
    return app.pid;
  };

  // Accessibility lists only windows on the current Space; bring the app forward when it lists none.
  const macTree = (state) => {
    const pid = String(macPid(state));
    let tree = ax(["tree", pid]);
    for (let i = 0; tree.windows.length === 0 && i < 15; i++) {
      if (i === 0)
        spawnSync("osascript", [
          "-e",
          `tell application "System Events" to tell (first process whose unix id is ${pid}) to set {visible, frontmost} to {true, true}`,
        ]);
      spawnSync("/bin/sleep", ["0.2"]);
      tree = ax(["tree", pid]);
    }
    return tree;
  };

  const macFind = (state, role, name, { attempts = 20 } = {}) => {
    let matches = [];
    let nodes = [];
    for (let i = 0; i < attempts; i++) {
      nodes = axNodes(macTree(state));
      matches = nodes.filter((n) => n.role === role && n.name === name);
      if (matches.length === 1) return matches[0];
      spawnSync("/bin/sleep", ["0.25"]);
    }
    fail(
      `${matches.length} elements match ${role} ${JSON.stringify(name)} in the ${state.id} window; ${role}s: ${JSON.stringify(nodes.filter((n) => n.role === role).map((n) => n.name))}`,
    );
  };

  const macEval = (state, js) =>
    new Promise((settle, reject) => {
      const path = webviewSocket(state);
      if (!existsSync(path)) {
        reject(
          new Error(
            `no eval channel in the ${state.id} app: ${path} is missing (the app ignored DYLD_INSERT_LIBRARIES, as a build with the hardened runtime does)`,
          ),
        );
        return;
      }
      const socket = createConnection(path);
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("error", reject);
      socket.on("end", () => {
        try {
          const answer = JSON.parse(data.trim());
          if (!answer.ok) reject(new Error(answer.error));
          else settle(decodeResult(answer.result));
        } catch (error) {
          reject(error);
        }
      });
      socket.write(`${JSON.stringify({ js: evalBody(js) })}\n`);
    });

  // webinspectord_sim now and then answers a fresh connection with no applications; a new connection gets them.
  const iosInspector = async (state) => {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await openInspector(state.simulator.udid, bundleId, {
          pickUrl: (url) => /^(https?|capacitor):/.test(url),
          timeout: 8000,
        });
      } catch (error) {
        last = error;
        await sleep(750);
      }
    }
    return fail(`webview ${state.id}: ${last.message}`);
  };

  const iosEval = async (state, js) => {
    const inspector = await iosInspector(state);
    try {
      const value = await inspector.evaluate(`(async () => { ${evalBody(js)} })()`);
      return decodeResult(value);
    } finally {
      await inspector.close();
    }
  };

  const domCall = (state, call) =>
    iosEval(state, `() => { const W = ${DOM_LIB}; return ${call}; }`);

  async function snapshot(state, file, { json = false } = {}) {
    let result;
    if (state.target === "ios") {
      const snap = await domCall(state, "W.snapshot()");
      result = { text: snap.lines.join("\n"), json: snap };
    } else {
      const tree = macTree(state);
      const nodes = axNodes(tree);
      result = { text: axSnapshotText(nodes), json: { pid: tree.pid, nodes } };
    }
    if (file) {
      mkdirSync(dirname(resolve(file)), { recursive: true });
      writeFileSync(
        resolve(file),
        json ? `${JSON.stringify(result.json, null, 2)}\n` : `${result.text}\n`,
      );
    }
    return result;
  }

  async function click(state, role, name) {
    if (state.target === "ios")
      return domCall(state, `W.click(${JSON.stringify(role)}, ${JSON.stringify(name)})`);
    const node = macFind(state, role, name);
    ax(["press", String(macPid(state)), node.path]);
    return { role, name, path: node.path };
  }

  async function fill(state, role, name, text) {
    if (state.target === "ios")
      return domCall(
        state,
        `W.fill(${JSON.stringify(role)}, ${JSON.stringify(name)}, ${JSON.stringify(text)})`,
      );
    const pid = String(macPid(state));
    const node = macFind(state, role, name);
    if (role === "combobox") {
      ax(["press", pid, node.path]);
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        const item = axNodes(macTree(state)).find(
          (n) => n.role === "menuitem" && n.name === text,
        );
        if (item) {
          ax(["press", pid, item.path]);
          return { role, name, value: text };
        }
      }
      fail(
        `no menu item ${JSON.stringify(text)} after opening combobox ${JSON.stringify(name)}`,
      );
    }
    ax(["setvalue", pid, node.path, text]);
    for (let i = 0; i < 10; i++) {
      const now = axNodes(macTree(state)).find((n) => n.path === node.path);
      if (
        now?.value === text ||
        (role === "textbox" &&
          now &&
          now.value !== undefined &&
          text.length > 0 &&
          /^•+$/.test(now.value) &&
          now.value.length === text.length)
      )
        return { role, name, path: node.path };
      await sleep(100);
    }
    ax(["setvalue", pid, node.path, ""]);
    ax(["focus", pid, node.path]);
    ax(["type", pid, text, "30"]);
    return { role, name, path: node.path, typed: true };
  }

  async function evaluate(state, js) {
    return state.target === "ios" ? iosEval(state, js) : macEval(state, js);
  }

  async function command([id, action, ...args]) {
    const state = readState(id);
    if (state.target === "web")
      fail(`web instances are driven with: hello.mjs browser ${id} ...`);
    const print = (value) =>
      process.stdout.write(
        `${value === undefined ? "undefined" : JSON.stringify(value, null, 2)}\n`,
      );
    switch (action) {
      case "snapshot": {
        const { values, positionals } = parseArgs({
          args,
          allowPositionals: true,
          options: { json: { type: "boolean" } },
        });
        const result = await snapshot(state, positionals[0], { json: values.json });
        if (!positionals[0]) process.stdout.write(`${result.text}\n`);
        else process.stdout.write(`${resolve(positionals[0])}\n`);
        return;
      }
      case "click":
        if (args.length < 2) fail("usage: webview ID click ROLE NAME");
        return print(await click(state, args[0], args[1]));
      case "fill":
        if (args.length < 3) fail("usage: webview ID fill ROLE NAME TEXT");
        return print(await fill(state, args[0], args[1], args[2]));
      case "eval":
        if (!args[0]) fail("usage: webview ID eval JS");
        return print(
          await evaluate(state, args[0]).catch((error) =>
            fail(`eval failed: ${error.message}`),
          ),
        );
      case "tree":
        if (state.target !== "mac") fail("tree is the raw macOS accessibility tree");
        return print(macTree(state));
      default:
        fail(
          "usage: webview ID snapshot [FILE] [--json] | click ROLE NAME | fill ROLE NAME TEXT | eval JS",
        );
    }
  }

  return { command, snapshot, click, fill, evaluate, macTree, ax };
}
