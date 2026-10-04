/**
 * The environment every git child process of Intent Guard runs with.
 *
 * Replace objects (refs/replace/*) let anyone with write access to the
 * repository make git show one object in place of another. Left honoured, a
 * local replace ref can make a listing the gate depends on come back empty:
 * HEAD shown as a commit whose tree already matches the index empties the
 * --staged listing, and a branch tip shown as the base empties the --base one.
 * The trusted-base reads have the same exposure. So every git call disables
 * them, the same way the Stop hook does for its own git calls.
 *
 * Two parts, both environment only, so no git argument changes:
 * - GIT_NO_REPLACE_OBJECTS=1, the environment form of --no-replace-objects;
 * - core.useReplaceRefs=false passed through GIT_CONFIG_COUNT, because
 *   repository config setting core.useReplaceRefs=true would otherwise turn
 *   replace refs back on over that variable. Config passed this way sits above
 *   repository config. It is appended after any entries the caller's
 *   environment already carries. A git older than 2.31 ignores these
 *   variables, and the first part still applies there.
 */
export function gitSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const raw = base.GIT_CONFIG_COUNT ?? "0";
  const index = /^[0-9]+$/.test(raw) ? Number(raw) : 0;
  return {
    ...base,
    GIT_NO_REPLACE_OBJECTS: "1",
    [`GIT_CONFIG_KEY_${index}`]: "core.useReplaceRefs",
    [`GIT_CONFIG_VALUE_${index}`]: "false",
    GIT_CONFIG_COUNT: String(index + 1),
  };
}
