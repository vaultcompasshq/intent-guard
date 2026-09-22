// The portfolio-name guard and pnpm lint each carry a copy of the hash
// blocklist. Nothing else notices if one copy gains or drops an entry.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function bannedHashes(rel) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  const start = text.indexOf("const BANNED_HASHES = new Set([");
  const end = text.indexOf("]);", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const hashes = [...text.slice(start, end).matchAll(/[0-9a-f]{64}/gi)].map((match) =>
    match[0].toLowerCase(),
  );
  expect(new Set(hashes).size).toBe(hashes.length);
  return hashes.sort();
}

describe("hygiene hash blocklists", () => {
  it("keeps the two copies equal", () => {
    const portfolio = bannedHashes("scripts/validate-no-portfolio-names.mjs");
    const lint = bannedHashes("scripts/check-public-hygiene.mjs");
    expect(portfolio).toHaveLength(13);
    expect(lint).toEqual(portfolio);
  });
});
