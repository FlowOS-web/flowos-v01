const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("both business dashboards link to password recovery", () => {
  for (const file of ["dashboard.html", "v1-preview/dashboard.html"]) {
    assert.match(read(file), /href="forgot-password\.html">Forgot password\?<\/a>/, file);
  }
});

test("both recovery request pages use Supabase Auth and the canonical reset redirect", () => {
  for (const file of ["forgot-password.html", "v1-preview/forgot-password.html"]) {
    const html = read(file);
    assert.match(html, /resetPasswordForEmail\(email,\s*\{\s*redirectTo:\s*RESET_REDIRECT_URL\s*\}\)/, file);
    assert.match(html, /https:\/\/gatebrook\.work\/reset-password\.html/, file);
    assert.match(html, /If an account exists for that email, a password-reset link will be sent shortly/, file);
  }
});

test("reset pages scrub recovery parameters before loading remote assets", () => {
  for (const file of ["reset-password.html", "v1-preview/reset-password.html"]) {
    const html = read(file);
    const scrub = html.indexOf('history.replaceState(null, "", location.pathname);');
    const css = html.indexOf('<link rel="stylesheet" href="theme.css?v=1">');
    const client = html.indexOf('src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js');
    assert.ok(scrub >= 0 && css > scrub && client > scrub, file + " must scrub tokens before remote assets load");
    assert.match(html, /detectSessionInUrl:\s*false/, file);
    assert.match(html, /exchangeCodeForSession/, file);
    assert.match(html, /auth\.setSession/, file);
    assert.match(html, /auth\.verifyOtp/, file);
    assert.match(html, /auth\.updateUser\(\{ password \}\)/, file);
    assert.match(html, /tokenType !== "recovery"/, file);
  }
});
