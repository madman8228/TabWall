const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("view modes share one toggle with readable solid-dot SVG icons", () => {
  const html = fs.readFileSync("manager.html", "utf8");
  const source = fs.readFileSync("manager.js", "utf8");
  const viewButton = html.match(/<button id="view-toggle-button"[\s\S]*?<\/button>/)?.[0];
  assert.ok(viewButton);
  assert.equal((html.match(/id="view-toggle-button"/g) || []).length, 1);
  assert.equal((viewButton.match(/data-view-icon="(domain|original)"/g) || []).length, 2);
  assert.equal((viewButton.match(/r="1\.6"/g) || []).length, 12);
  assert.match(viewButton, /aria-pressed="false"/);
  assert.match(source, /function setViewMode\(nextMode\)/);
  assert.match(source, /setViewMode\(viewMode === "domain" \? "original" : "domain"\)/);
  assert.match(source, /updateViewButtons\(\);\s+try \{\s+localStorage\.setItem/);
  assert.match(source, /viewToggleButton\.dataset\.viewMode = viewMode/);
  assert.match(source, /viewIcons\.domain\.style\.display = isDomainView \? "block" : "none"/);
  assert.match(source, /viewIcons\.original\.style\.display = isDomainView \? "none" : "block"/);
});

test("restore and clear actions are available from an accessible SVG menu", () => {
  const html = fs.readFileSync("manager.html", "utf8");
  const batchButton = html.match(/<button id="batch-actions-button"[^>]*>/)?.[0];
  assert.ok(batchButton);
  assert.doesNotMatch(batchButton, /title=/);
  assert.match(batchButton, /data-i18n-aria-label="batchActionsAria"/);
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

test("search field expands smoothly when focused", () => {
  const css = fs.readFileSync("manager.css", "utf8");
  assert.match(css, /\.search-control input \{[\s\S]*?width: 58px;/);
  assert.match(css, /\.search-control input \{[\s\S]*?transition: width 180ms ease/);
  assert.match(css, /\.search-control input \{[\s\S]*?text-align: center;/);
  assert.match(css, /\.search-control input:focus,[\s\S]*?width: clamp\(112px, 12\.75vw, 173px\)/);
  assert.match(css, /\.header-actions \{[\s\S]*?gap: 11px;/);
});

test("website groups expose collapsible SVG controls", () => {
  const source = fs.readFileSync("manager.js", "utf8");
  const css = fs.readFileSync("manager.css", "utf8");
  const en = JSON.parse(fs.readFileSync("_locales/en/messages.json", "utf8"));
  const zh = JSON.parse(fs.readFileSync("_locales/zh_CN/messages.json", "utf8"));
  assert.equal(en.otherGroup.message, "Other");
  assert.equal(zh.otherGroup.message, "Other");
  assert.match(source, /renderDomainGroup\(otherTabs, translate\("otherGroup"\)/);
  assert.equal(en.tabsGroupCountMany.message, "($1)");
  assert.equal(zh.tabsGroupCountMany.message, "($1)");
  assert.match(source, /function setDomainGroupCollapsed\(/);
  assert.match(source, /className = "group-toggle"/);
  assert.match(source, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  assert.match(source, /groupContent\.hidden = collapsed/);
  assert.match(source, /collapsedDomains\.has\(domain\)/);
  assert.match(source, /heading\.append\(toggleButton, domainLabel, count\)/);
  assert.match(css, /\.group-toggle-icon \{/);
  assert.match(css, /\.group-toggle\.is-collapsed \.group-toggle-icon/);
  assert.doesNotMatch(css, /\.group-toggle \{[\s\S]*?margin-left: auto;/);
  assert.match(css, /\.tab-group-content\[hidden\] \{/);
  assert.match(css, /\.tab-wall \{[\s\S]*?gap: 6px;/);
  assert.match(css, /\.tab-group-heading \{[\s\S]*?margin: 8px 0 0;/);
  for (const key of ["collapseGroupAria", "expandGroupAria"]) {
    assert.ok(en[key]?.message);
    assert.ok(zh[key]?.message);
  }
});

test("tabs-per-row value increments when clicked", () => {
  const html = fs.readFileSync("manager.html", "utf8");
  const source = fs.readFileSync("manager.js", "utf8");
  assert.match(html, /<button id="tabs-per-row-value"[^>]*type="button"/);
  assert.match(html, /id="tabs-per-row-value"[^>]*data-i18n-title="incrementTabsPerRow"/);
  assert.match(source, /tabsPerRowValue\.addEventListener\("click", \(\) => \{\s+void incrementTabsPerRow\(\);/);
  assert.match(source, /async function incrementTabsPerRow\(\)/);
  assert.match(source, /tabsPerRow \+ 1/);
  assert.match(source, /tabsPerRow >= MAX_TABS_PER_ROW_SETTING/);
});
