const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("view modes share one toggle with readable solid-dot SVG icons", () => {
  const html = fs.readFileSync("manager.html", "utf8");
  const viewButton = html.match(/<button id="view-toggle-button"[\s\S]*?<\/button>/)?.[0];
  assert.ok(viewButton);
  assert.equal((html.match(/id="view-toggle-button"/g) || []).length, 1);
  assert.equal((viewButton.match(/data-view-icon="(domain|original)"/g) || []).length, 2);
  assert.equal((viewButton.match(/r="1\.6"/g) || []).length, 12);
  assert.match(viewButton, /aria-pressed="false"/);
});

test("restore and clear actions are available from an accessible SVG menu", () => {
  const html = fs.readFileSync("manager.html", "utf8");
  assert.match(html, /id="batch-actions-button"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="batch-actions-menu"[^>]*role="menu"/);
  assert.match(html, /id="restore-all"[^>]*role="menuitem"/);
  assert.match(html, /id="clear-session"[^>]*role="menuitem"/);
  assert.equal((html.match(/class="more-icon"/g) || []).length, 1);
  assert.equal((html.match(/class="more-icon"[\s\S]*?<circle/g) || []).length, 1);
});

test("background refreshes do not replace the page count with a loading label", () => {
  const source = fs.readFileSync("manager.js", "utf8");
  assert.match(source, /async function renderSession\(showLoading = false\)/);
  assert.match(source, /if \(showLoading\) \{\s+sessionMeta\.textContent = translate\("loading"\);\s+\}/);
  assert.doesNotMatch(source, /async function renderSession\(showLoading = false\) \{\s+sessionMeta\.textContent = translate\("loading"\);/);
  const deleteHandler = source.match(/async function deleteTab\([\s\S]*?\n\}\n\nasync function clearSession/)[0];
  assert.doesNotMatch(deleteHandler, /renderSession\(/);
});

test("saved tabs can be searched by title, website, or URL", () => {
  const html = fs.readFileSync("manager.html", "utf8");
  const source = fs.readFileSync("manager.js", "utf8");
  assert.match(html, /id="tab-search"[^>]*type="search"/);
  assert.match(html, /id="search-empty-state"[^>]*hidden/);
  assert.match(source, /function filterTabsForSearch\(tabs\)/);
  assert.match(source, /function fuzzyMatch\(text, query\)/);
  assert.match(source, /getDomain\(tab\.url\)/);
});
