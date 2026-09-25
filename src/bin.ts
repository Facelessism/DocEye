#!/usr/bin/env node
import { main } from "./cli";

main(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  cwd: process.cwd(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`doceye: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
