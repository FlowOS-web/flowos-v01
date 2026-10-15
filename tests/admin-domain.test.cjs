// Exercise the real setup-link validator with a fixture-only DOM, as in the
// existing admin-console integration harness. No browser or network is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BUSINESS = "44444444-4444-4444-8444-444444444444";
const TOKEN = "a".repeat(64);
const fragment = "#token_hash=" + TOKEN + "&type=invite&business_id=" + BUSINESS;
const trustedPages = [
  "https://gatebrook.work/activate.html",
  "https://gatebrook.work/v1-preview/activate.html",
  "https://flowos-web.github.io/flowos-v01/activate.html",
  "https://flowos-web.github.io/flowos-v01/v1-preview/activate.html",
];

function harness(page) {
  const html = fs.readFileSync(path.join(__dirname, "..", page), "utf8");
  const start = html.indexOf("    function showSetupLink(");
  const end = html.indexOf("    function renderResult(", start);
  assert.ok(start > 0 && end > start, "real validator must be found");
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", textContent: "", hidden: true,
      classList: {
        add() { nodes.get(id).hidden = true; },
        remove() { nodes.get(id).hidden = false; },
      },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({ $, URL, URLSearchParams });
  vm.runInContext(html.slice(start, end), context);
  return { $, show: context.showSetupLink };
}

for (const page of ["admin.html", "v1-preview/admin.html"]) {
  test(page + " displays trusted new and legacy activation pages for invite and recovery", () => {
    const h = harness(page);
    for (const base of trustedPages) for (const type of ["invite", "recovery"]) {
      const url = base + fragment.replace("type=invite", "type=" + type);
      h.show(url, "owner@example.test", BUSINESS);
      assert.equal(h.$("setupLink").value, url);
      assert.equal(h.$("setupSection").hidden, false);
    }
    h.show(trustedPages[0] + fragment, "owner@example.test", BUSINESS, "detail");
    assert.equal(h.$("detailSetupLink").value, trustedPages[0] + fragment);
    assert.equal(h.$("detailSetupSection").hidden, false);
  });

  test(page + " rejects lookalike origins, untrusted paths and malformed credentials without retaining a token", () => {
    const h = harness(page);
    const invalid = [
      "https://gatebrook.work.attacker.example/activate.html" + fragment,
      "https://sub.gatebrook.work/activate.html" + fragment,
      "http://gatebrook.work/activate.html" + fragment,
      "https://gatebrook.work:444/activate.html" + fragment,
      "https://user:password@gatebrook.work/activate.html" + fragment,
      "https://flowos-web.github.io/activate.html" + fragment,
      "https://gatebrook.work/flowos-v01/activate.html" + fragment,
      "https://gatebrook.work/other/activate.html" + fragment,
      "https://gatebrook.work/activate.html?redirect=https://attacker.example" + fragment,
      trustedPages[0] + fragment.replace("type=invite", "type=magiclink"),
      trustedPages[0] + fragment.replace(TOKEN, "short"),
      trustedPages[0] + fragment.replace(BUSINESS, "33333333-3333-4333-8333-333333333333"),
    ];
    for (const url of invalid) {
      h.show(trustedPages[0] + fragment, "owner@example.test", BUSINESS);
      assert.throws(() => h.show(url, "owner@example.test", BUSINESS), /could not be verified/);
      assert.equal(h.$("setupLink").value, "");
      assert.equal(h.$("setupSection").hidden, true);
    }
  });
}

