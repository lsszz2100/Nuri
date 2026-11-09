import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LlmProvider = 'gemini' | 'claude' | 'gpt';
export const PROVIDERS: LlmProvider[] = ['gemini', 'claude', 'gpt'];

export function assertProvider(p: unknown): LlmProvider {
  if (typeof p === 'string' && (PROVIDERS as string[]).includes(p)) return p as LlmProvider;
  throw Object.assign(new Error(`Unknown provider '${String(p)}'`), { status: 400 });
}

/** Empty working directory for step decisions, so the CLIs have no project files to touch. */
export const SANDBOX_DIR = path.join(os.homedir(), '.anb-llm-sandbox');

/** Environment without any API-key variables: the CLIs can only use their subscription logins. */
export function safeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    delete env[key];
  }
  return env;
}

// ---------- running the CLIs on Windows (server outside WSL) ----------
// On Windows `spawn('codex')` fails: npm installs CLIs as .cmd shims, which need a shell (and a
// shell would re-parse prompts and JSON arguments). Resolve the command instead: an .exe runs
// directly; an npm shim runs its JavaScript file with this Node (or the app runtime as Node).

interface ResolvedCli {
  file: string;
  prefix: string[];
}

const resolved = new Map<string, ResolvedCli>();

/** Folders searched besides PATH (installers put the CLIs there, and PATH may be stale). */
function extraDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, '.local', 'bin'), path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm')];
}

/** The JavaScript file an npm .cmd shim runs ("%dp0%\node_modules\pkg\bin\x.js" %*). */
export function shimTarget(shimText: string, shimDir: string): string | null {
  const m = /"%(?:~?dp0)%\\([^"]+?\.(?:c|m)?js)"/i.exec(shimText);
  return m ? path.win32.join(shimDir, m[1]) : null;
}

export function resolveCli(cmd: string): ResolvedCli {
  if (process.platform !== 'win32') return { file: cmd, prefix: [] };
  const hit = resolved.get(cmd);
  if (hit) return hit;
  const dirs = [...(process.env.PATH || process.env.Path || '').split(';').filter(Boolean), ...extraDirs()];
  let found: ResolvedCli = { file: cmd, prefix: [] }; // not installed: spawn reports ENOENT
  search: for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd']) {
      const file = path.join(dir, cmd + ext);
      if (!fs.existsSync(file)) continue;
      if (ext === '.exe') {
        found = { file, prefix: [] };
        break search;
      }
      const js = shimTarget(fs.readFileSync(file, 'utf8'), dir);
      if (js && fs.existsSync(js)) {
        found = { file: process.execPath, prefix: [js] };
        break search;
      }
    }
  }
  resolved.set(cmd, found);
  return found;
}

/** spawn() for a CLI by name, on Linux/WSL and on Windows. */
export function spawnCli(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  const r = resolveCli(cmd);
  return spawn(r.file, [...r.prefix, ...args], { windowsHide: true, ...opts });
}

export const CLAUDE_SUBSCRIPTION_SETTINGS = '{"forceLoginMethod":"claudeai"}';
/**
 * The agent's brain follows only the app's system prompt: the user's own Claude settings
 * (hooks, permissions) and instruction files (CLAUDE.md, rules) are not loaded. Without this a
 * personal "always answer in Korean" rule overrides the language chosen in the app.
 * (Assistant mode keeps them: it is meant to use what the user set up.)
 */
export const CLAUDE_ISOLATED = [
  '--setting-sources', 'project,local',
  '--settings', JSON.stringify({ forceLoginMethod: 'claudeai', claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**'] }),
];
export const CODEX_SUBSCRIPTION_FLAG = 'forced_login_method="chatgpt"';

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  mergeStderr?: boolean;
  signal?: AbortSignal;
}

/** Run a CLI to completion. stdin is closed (some CLIs wait for piped stdin otherwise). */
export function runCli(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const cwd = opts.cwd ?? SANDBOX_DIR;
  fs.mkdirSync(cwd, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? 600_000;
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { cwd, env: safeEnv(), stdio: ['ignore', 'pipe', 'pipe'] };
    const child = spawnCli(cmd, args, spawnOpts);
    let out = '';
    let err = '';
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    opts.signal?.addEventListener('abort', () => {
      kill();
      reject(new Error(`${cmd} cancelled`));
    });
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} could not start: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(opts.mergeStderr ? out + err : out);
      else reject(new Error(`${cmd} exited with code ${code}: ${(err || out).slice(-500)}`));
    });
  });
}

/** Run and never throw; failures come back as null. */
export async function tryRunCli(cmd: string, args: string[], timeoutMs = 30_000): Promise<string | null> {
  try {
    return await runCli(cmd, args, { timeoutMs, mergeStderr: true });
  } catch {
    return null;
  }
}

export interface ImageInput {
  mime: string; // image/png | image/jpeg
  data: string; // base64
}

/** Writes images to temp files (for CLIs that take image paths) and returns a cleanup function. */
export function writeTempImages(images: ImageInput[] = []): { files: string[]; cleanup: () => void } {
  const dir = path.join(SANDBOX_DIR, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const files = images.map((img, i) => {
    const ext = img.mime === 'image/png' ? 'png' : 'jpg';
    const file = path.join(dir, `shot-${Date.now()}-${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    return file;
  });
  return { files, cleanup: () => files.forEach((f) => fs.rmSync(f, { force: true })) };
}
