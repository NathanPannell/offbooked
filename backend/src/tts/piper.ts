import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { Log } from "../log.ts";
import { VOICE_MODELS, type Voice } from "./voices.ts";

const run = promisify(execFile);

// Text in, WAV file out. Tests use a fake; production uses Piper.
export interface Synthesizer {
  // Engine label for /health and cache keys (e.g. "piper 1.2.0"), or null when it can't run here.
  probe(): Promise<string | null>;
  synthesize(text: string, voice: Voice, outWav: string): Promise<void>;
  // Optional: load a model ahead of the first request for it.
  prewarm?(model: string): void;
  close(): Promise<void>;
}

const UTTERANCE_TIMEOUT_MS = 120_000;

// One long-lived `piper --json-input` process with one model loaded. Loading a model takes a
// second or more, so processes are reused; each handles one utterance at a time.
class PiperProcess {
  readonly model: string;
  busy = false;
  alive = true;
  private proc: ChildProcessWithoutNullStreams;
  private waiting: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;
  private stderr = "";
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(bin: string, binArgs: string[], modelPath: string, model: string, onExit: (p: PiperProcess) => void) {
    this.model = model;
    this.proc = spawn(bin, [...binArgs, "-q", "--json-input", "-m", modelPath], { windowsHide: true });
    this.proc.stdin.on("error", () => {});
    this.proc.stderr.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-2000);
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const w = this.waiting;
      this.waiting = null;
      w?.resolve(line);
    });
    const fail = (err: Error) => {
      if (!this.alive) return;
      this.alive = false;
      const w = this.waiting;
      this.waiting = null;
      w?.reject(err);
      onExit(this);
    };
    this.proc.on("error", fail);
    this.proc.on("exit", (code) => fail(new Error(`piper exited (${code}): ${this.stderr.trim().slice(-500)}`)));
  }

  speak(payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("piper is not running"));
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error("piper timed out"));
        this.kill();
      }, UTTERANCE_TIMEOUT_MS);
      this.waiting = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  idleFor(ms: number, onIdle: () => void) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(onIdle, ms);
    this.idleTimer.unref();
  }

  kill() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.alive) this.proc.kill();
  }
}

// A small pool of Piper processes, at most maxProcs at once. A process keeps its model; when the
// pool is full, an idle process with another model is replaced. Idle processes exit after a minute.
// Replacing one means loading a model again (about a second locally, several on a shared CPU), so
// maxProcs should be at least the number of models: with fewer, a scene whose speakers use
// different models reloads a model for nearly every line (see pooledProcs).
export class PiperSynthesizer implements Synthesizer {
  private bin: string;
  private binArgs: string[];
  private voicesDir: string;
  private maxProcs: number;
  private idleMs: number;
  private log: Log;
  private procs: PiperProcess[] = [];
  private waiters: (() => void)[] = [];
  private probed: Promise<string | null> | null = null;

  /** Processes started so far (for logs and tests). */
  started = 0;

  constructor(opts: { bin: string; binArgs?: string[]; voicesDir: string; maxProcs: number; idleMs?: number; log: Log }) {
    this.bin = opts.bin;
    this.binArgs = opts.binArgs ?? [];
    this.voicesDir = opts.voicesDir;
    this.maxProcs = Math.max(1, opts.maxProcs);
    this.idleMs = opts.idleMs ?? 60_000;
    this.log = opts.log;
  }

  probe(): Promise<string | null> {
    this.probed ??= (async () => {
      try {
        for (const model of VOICE_MODELS) {
          await access(this.modelPath(model));
          await access(`${this.modelPath(model)}.json`);
        }
        const { stdout } = await run(this.bin, [...this.binArgs, "--version"], { timeout: 15_000, windowsHide: true });
        return `piper ${stdout.trim().split("\n")[0]}`;
      } catch (err) {
        this.log.warn({ bin: this.bin, voicesDir: this.voicesDir, err: String((err as Error).message ?? err) }, "Piper TTS unavailable; unrecorded lines render as silence");
        return null;
      }
    })();
    return this.probed;
  }

  private modelPath(model: string): string {
    return path.join(this.voicesDir, `${model}.onnx`);
  }

  private async acquire(model: string): Promise<PiperProcess> {
    for (;;) {
      const same = this.procs.find((p) => !p.busy && p.alive && p.model === model);
      if (same) {
        same.busy = true;
        return same;
      }
      if (this.procs.length < this.maxProcs) {
        const p = this.spawn(model);
        p.busy = true;
        return p;
      }
      const idle = this.procs.find((p) => !p.busy);
      if (idle) {
        this.log.info({ model, replacing: idle.model }, "piper model switch");
        idle.kill();
        this.remove(idle);
        continue;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  // Starts an idle process for a model when the pool has room and none has it loaded, so the next
  // line in that voice skips the model load. Never replaces a running process.
  prewarm(model: string): void {
    const loaded = () => this.procs.length >= this.maxProcs || this.procs.some((p) => p.alive && p.model === model);
    if (loaded()) return;
    void this.probe().then((engine) => {
      if (!engine || loaded()) return;
      this.release(this.spawn(model));
    });
  }

  private spawn(model: string): PiperProcess {
    const p = new PiperProcess(this.bin, this.binArgs, this.modelPath(model), model, (dead) => this.remove(dead));
    this.procs.push(p);
    this.started++;
    this.log.info({ model, procs: this.procs.length, started: this.started }, "piper process started");
    return p;
  }

  private release(p: PiperProcess) {
    p.busy = false;
    if (p.alive) {
      p.idleFor(this.idleMs, () => {
        if (p.busy) return;
        p.kill();
        this.remove(p);
      });
    }
    this.waiters.shift()?.();
  }

  private remove(p: PiperProcess) {
    const i = this.procs.indexOf(p);
    if (i >= 0) this.procs.splice(i, 1);
    if (i >= 0) this.waiters.shift()?.();
  }

  async synthesize(text: string, voice: Voice, outWav: string): Promise<void> {
    const payload: Record<string, unknown> = { text, output_file: path.resolve(outWav) };
    if (voice.speaker !== null) payload.speaker_id = voice.speaker;
    // One retry on a fresh process: a crashed or timed-out process is dropped from the pool.
    for (let attempt = 0; ; attempt++) {
      const p = await this.acquire(voice.model);
      try {
        await p.speak(payload);
        return;
      } catch (err) {
        if (attempt >= 1) throw err;
        p.kill();
        this.remove(p);
      } finally {
        this.release(p);
      }
    }
  }

  async close(): Promise<void> {
    for (const p of this.procs) p.kill();
    this.procs = [];
  }
}

// Piper processes to allow: enough that every model keeps a loaded process even while
// `concurrency` utterances run at once (two of them maybe on the same model), so no model is
// ever unloaded to make room for another while a run-through plays.
export function pooledProcs(concurrency: number): number {
  return Math.max(1, concurrency) + VOICE_MODELS.length - 1;
}
