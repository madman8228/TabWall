const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("view icons map to the intended actions and use readable solid dots", () => {
  const html = fs.readFileSync("manager.html", "utf8");
  const buttons = [...html.matchAll(/<button class="view-button[^>]*data-view="(domain|original)"[\s\S]*?<\/button>/g)];
  assert.deepEqual(buttons.map((match) => match[1]), ["domain", "original"]);
  assert.match(buttons[0][0], /data-i18n-title="byWebsiteHint"/);
  assert.match(buttons[1][0], /data-i18n-title="originalViewHint"/);
  assert.equal((buttons[0][0].match(/r="1\.6"/g) || []).length, 6);
  assert.equal((buttons[1][0].match(/r="1\.6"/g) || []).length, 6);
});
