const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("confirmed recovery source is the selected 70-page snapshot and includes video sites", () => {
  const candidates = JSON.parse(fs.readFileSync("recovery-70-source.json", "utf8"));
  const snapshot = candidates.find((entry) => entry.sequence === 20 && entry.operation === "put");
  assert.equal(snapshot?.session?.tabs?.length, 70);

  const hosts = snapshot.session.tabs.map((tab) => new URL(tab.url).hostname);
  assert.ok(hosts.filter((host) => /bilibili/i.test(host)).length > 0);
  assert.ok(hosts.filter((host) => /youtube/i.test(host)).length > 0);
});
