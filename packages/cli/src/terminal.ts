import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { YES } from "./patterns.js";
import type { Runtime } from "./runtime.js";

/** The process's streams, or stand-ins with `isTTY` set (the tests drive prompts through PassThrough streams). */
export interface Terminal {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
  env: Record<string, string | undefined>;
  cwd: string;
}

/** The real runtime: the given streams, with prompts written to stderr so stdout stays the result. */
export function terminalRuntime(t: Terminal): Runtime {
  return {
    stdout: (s) => void t.stdout.write(s),
    stderr: (s) => void t.stderr.write(s),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of t.stdin) chunks.push(Buffer.from(c as Buffer));
      return Buffer.concat(chunks).toString("utf8");
    },
    promptSecret: (question) => new Promise((resolve) => {
      // Echo off: the readline output is muted after the question is written.
      const rl = createInterface({ input: t.stdin, output: t.stderr, terminal: true });
      let muted = false;
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (!muted) write(s);
      };
      rl.question(question, (answer) => {
        rl.close();
        t.stderr.write("\n");
        resolve(answer);
      });
      muted = true;
    }),
    confirm: (question) => new Promise((resolve) => {
      const rl = createInterface({ input: t.stdin, output: t.stderr });
      // End of input (Ctrl-D, a closed pipe) is a no, never a hang.
      let answered = false;
      rl.on("close", () => answered || resolve(false));
      rl.question(question, (answer) => {
        answered = true;
        rl.close();
        resolve(YES.test(answer.trim()));
      });
    }),
    env: t.env,
    interactive: Boolean(t.stdin.isTTY && t.stderr.isTTY),
    stdoutIsTTY: Boolean(t.stdout.isTTY),
    cwd: t.cwd,
  };
}
