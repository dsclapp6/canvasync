// Thin wrapper around the `claude` CLI.
// Mirrors canvas-sync/scripts/_util.js:claudeInvoke but kept local so this
// project has zero dependence on the sync repo.
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function claudeInvoke(prompt, { timeoutMs = 180_000, model = null } = {}) {
  if (process.env.CLAUDE_SKIP === '1') {
    throw new Error('CLAUDE_SKIP=1 — caller should not have reached claudeInvoke');
  }
  const args = ['-p', '-'];
  if (model) args.push('--model', model);

  const result = await _trySpawn('claude', args, prompt, timeoutMs).catch(async (err) => {
    if (err.code === 'STDIN_REJECTED' || err.code === 'SPAWN_ERROR') {
      return _spawnViaTmpFile(prompt, model, timeoutMs);
    }
    throw err;
  });
  return result.trim();
}

function _trySpawn(cmd, args, stdinData, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      err.code = 'SPAWN_ERROR';
      return reject(err);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); err.code = 'SPAWN_ERROR'; reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        const err = new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`);
        if (stderr.includes('stdin') || stderr.includes('--pipe')) err.code = 'STDIN_REJECTED';
        return reject(err);
      }
      resolve(stdout);
    });
    proc.stdin.write(stdinData, 'utf8');
    proc.stdin.end();
  });
}

async function _spawnViaTmpFile(prompt, model, timeoutMs) {
  const tmp = join(tmpdir(), 'csync-cal-' + randomBytes(8).toString('hex') + '.txt');
  await writeFile(tmp, prompt, 'utf8');
  const args = ['-p', tmp];
  if (model) args.push('--model', model);
  try {
    return await _trySpawn('claude', args, '', timeoutMs);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export function extractJsonFromResponse(raw) {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1) return trimmed.slice(first, last + 1);
  return trimmed;
}
