#!/usr/bin/env node
import {
  coachMessage,
  scorePrompt,
} from "@vaultcompass/conductor-core";
import { isHelpFlag, printUsage } from "./usage.js";

const USAGE = `Usage: conductor coach <prompt text>

Score a prompt for scope and clarity risks before it becomes an Intent
Contract. Everything after the command is treated as the prompt text.

Flags:
  --help, -h   Show this help

Example:
  conductor coach "Add CSV export. No new API endpoints."`;

const argv = process.argv.slice(2);
// coach takes free text rather than flags, so a help flag only counts in the
// leading position. Anywhere else it is part of the prompt being scored.
if (argv.length > 0 && isHelpFlag(argv[0])) printUsage(USAGE);

const text = argv.join(" ").trim();
if (!text) {
  console.error(USAGE);
  process.exit(1);
}

const scored = scorePrompt(text);
const message = coachMessage(scored, text);
console.log(
  JSON.stringify({
    score: scored.score,
    issues: scored.issues,
    coaching: message,
    needs_coaching: scored.score < 60 || scored.issues.length > 0,
  }),
);
