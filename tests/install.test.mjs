import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('install, run through the shell like agy does, then uninstall', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGY_CONVERSATIONS_DIR: path.join(home, 'none') };
  const cliDir = path.join(home, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(cliDir, 'settings.json');
  const agentsSkill = path.join(home, '.agents', 'skills', 'agy-stats', 'SKILL.md');
  const geminiSkillLink = path.join(home, '.gemini', 'config', 'skills', 'agy-stats');

  const inst = spawnSync(process.execPath, [path.join(root, 'install.mjs'), 'install'], { env, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.statusLine.type, 'command');
  assert.equal(settings.statusLine.stack_with_default, true);
  assert.equal(fs.existsSync(agentsSkill), true);
  assert.equal(fs.existsSync(path.join(geminiSkillLink, 'SKILL.md')), true);

  // agy runs the command with `sh -c` (`cmd /c` on Windows) and pipes JSON to stdin.
  const run = spawnSync(settings.statusLine.command, {
    shell: true,
    env,
    input: JSON.stringify({ conversation_id: '', context_window: { context_window_size: 0, current_usage: null } }),
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Ctx 0% \(0\/256k\)/);
  assert.match(run.stdout, /今日/);

  const un = spawnSync(process.execPath, [path.join(root, 'install.mjs'), 'uninstall'], { env, encoding: 'utf8' });
  assert.equal(un.status, 0, un.stderr);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, undefined);
  assert.equal(fs.existsSync(path.join(cliDir, 'statusline.mjs')), false);
  assert.equal(fs.existsSync(agentsSkill), false);
  assert.equal(fs.lstatSync(geminiSkillLink, { throwIfNoEntry: false }), undefined);

  // --no-skill skips installing the skill
  const instNoSkill = spawnSync(process.execPath, [path.join(root, 'install.mjs'), 'install', '--no-skill'], {
    env,
    encoding: 'utf8'
  });
  assert.equal(instNoSkill.status, 0, instNoSkill.stderr);
  assert.equal(fs.existsSync(agentsSkill), false);

  fs.rmSync(home, { recursive: true, force: true });
});
