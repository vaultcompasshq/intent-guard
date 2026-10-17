import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateProtectedPathFlag } from "./budget-paths.js";

// Extensions that make a bare token ("README.md", "usage.ts") read as a file.
const KNOWN_EXTENSION_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|md|mdx|txt|py|go|rs|rb|java|kt|swift|c|h|cpp|cs|php|css|scss|html|sql|sh|lock|env|ini|cfg|proto|graphql)$/i;
// Characters a path token may carry. Anything else (a comma, a quote) is
// trimmed from its ends first.
const PATH_TOKEN_RE = /^[A-Za-z0-9._\-/*]+$/;

function topLevelDirectories(projectRoot: string | undefined): Set<string> {
  const dirs = new Set<string>();
  if (!projectRoot || !existsSync(projectRoot)) return dirs;
  for (const name of readdirSync(projectRoot)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    try {
      if (statSync(join(projectRoot, name)).isDirectory()) dirs.add(name);
    } catch {
      // A name that vanished or cannot be read suggests nothing.
    }
  }
  return dirs;
}

function asGlob(token: string, isDirectory: boolean): string {
  const bare = token.replace(/\/+$/, "");
  return isDirectory && !bare.endsWith("**") ? `${bare}/**` : bare;
}

/**
 * Path budgets an ask names, as `allowed_paths` globs to SUGGEST. Nothing
 * here writes a budget: extract and import-spec print these and leave the
 * draft without one, and the person accepts a suggestion by adding it.
 *
 * A token is a path when it contains a slash and either ends in one, ends
 * in a known extension, or starts with a top-level directory of the
 * repository ("src/parser/" -> "src/parser/**"); when it has a known
 * extension on its own ("README.md"); or when it is exactly the name of a
 * top-level directory ("packages" -> "packages/**"). "read/write" is not a
 * path, nor is a URL. A token the budget matcher could never match (a
 * leading slash, a ".." segment, a brace) is dropped.
 */
export function suggestPathBudgets(text: string, projectRoot?: string): string[] {
  const dirs = topLevelDirectories(projectRoot);
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.replace(/^[`'"(<[]+/, ""))) continue;
    const token = raw.replace(/^[`'"(<[]+/, "").replace(/[`'")>\],;:!?]+$/, "").replace(/\.$/, "");
    if (token.length === 0 || !PATH_TOKEN_RE.test(token)) continue;

    let glob: string | null = null;
    if (token.includes("/")) {
      const first = token.split("/")[0];
      const hasExtension = KNOWN_EXTENSION_RE.test(token);
      if (token.endsWith("/") || hasExtension || dirs.has(first)) {
        glob = asGlob(token, !hasExtension);
      }
    } else if (KNOWN_EXTENSION_RE.test(token)) {
      glob = token;
    } else if (dirs.has(token)) {
      glob = asGlob(token, true);
    }
    if (glob === null || validateProtectedPathFlag(glob) !== null) continue;
    if (!out.includes(glob)) out.push(glob);
  }
  return out;
}
