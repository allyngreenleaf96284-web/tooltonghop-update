import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}
const context = vm.createContext({
  state: { selectedFolderId: "all", fullProgressFilter: "all", fullResultFilter: "all", fullSearchQuery: "", fullBulkSearchQuery: "", profiles: [] },
  sheetValue: (profile, ...keys) => keys.map((key) => profile.sheetData?.[key]).find(Boolean) || "",
  $: () => null
});
vm.runInContext(["parseBulkTerms", "profileHaystack", "matchesProfileFilters", "orderProfilesByPastedTerms", "orderProfileIdsTopDown", "fullProfiles"].map(declaration).join("\n"), context);
const uids = ["61586286283938", "61585039689329", "61583913820549"];
const profiles = [
  { id: "profile-c", uid: uids[2], name: "A first alphabetically", folderName: "A", sheetData: {} },
  { id: "profile-b", uid: uids[1], name: "B middle", folderName: "B", sheetData: {} },
  { id: "profile-a", uid: uids[0], name: "Z last alphabetically", folderName: "Z", sheetData: {} }
];
const order = (items, query, bulk = "") => Array.from(context.orderProfilesByPastedTerms(items, query, bulk), (profile) => profile.id);

test("pasted UIDs override name/folder order in exactly the supplied sequence", () => {
  assert.deepEqual(order(profiles, uids.join("\n")), ["profile-a", "profile-b", "profile-c"]);
  assert.deepEqual(order(profiles, uids.join("\r\n")), ["profile-a", "profile-b", "profile-c"]);
  assert.deepEqual(order(profiles, ` ${uids[0]} ; ${uids[1]},${uids[2]} `), ["profile-a", "profile-b", "profile-c"]);
});

test("blank lines, duplicates, and missing UIDs preserve relative order of the matches", () => {
  assert.deepEqual(order(profiles, `missing\n${uids[0]}\n\n${uids[0]}\n${uids[2]}\n${uids[1]}`), ["profile-a", "profile-c", "profile-b"]);
});

test("exact UID/profile IDs take precedence over incidental matches in names", () => {
  const items = profiles.map((profile) => ({ ...profile }));
  items[0].name = `contains another UID ${uids[0]}`;
  assert.deepEqual(order(items, uids.join("\n")), ["profile-a", "profile-b", "profile-c"]);
  assert.deepEqual(order(items, "profile-c\nprofile-a\nprofile-b"), ["profile-c", "profile-a", "profile-b"]);
});

test("single searches and no search keep the existing sort unchanged", () => {
  assert.deepEqual(order(profiles, ""), profiles.map((profile) => profile.id));
  assert.deepEqual(order(profiles, "California"), profiles.map((profile) => profile.id));
});

test("Full table order and outgoing run IDs follow pasted order despite checkbox selection order", () => {
  context.state.profiles = profiles;
  context.state.fullSearchQuery = uids.join("\n");
  context.state.fullBulkSearchQuery = uids.join("\n");
  const displayed = Array.from(context.fullProfiles());
  assert.deepEqual(displayed.map((profile) => profile.uid), uids);
  context.$ = () => ({ querySelectorAll: () => displayed.map((profile) => ({ querySelector: () => ({ dataset: { id: profile.id } }) })) });
  const requested = Array.from(context.orderProfileIdsTopDown(["profile-c", "profile-a", "profile-b"], "fullRows"));
  assert.deepEqual(requested, ["profile-a", "profile-b", "profile-c"]);
});
