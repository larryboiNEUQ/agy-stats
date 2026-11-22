#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const SETTINGS_PATH = path.join(CLI_DIR, 'settings.json');
const TARGET_SCRIPT = path.join(CLI_DIR, 'statusline.mjs');
const TARGET_PROTO = path.join(CLI_DIR, 'statusline-protobuf.mjs');
const TARGET_CLI = path.join(CLI_DIR, 'agy-stats-cli.mjs');
const TARGET_PRICING = path.join(CLI_DIR, 'agy-stats-pricing.mjs');
const LOCAL_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const LOCAL_BIN_SHIM = path.join(LOCAL_BIN_DIR, process.platform === 'win32' ? 'agy-stats.cmd' : 'agy-stats');

const AGENTS_SKILL_DIR = path.join(os.homedir(), '.agents', 'skills', 'agy-stats');
const GEMINI_SKILLS_DIR = path.join(os.homedir(), '.gemini', 'config', 'skills');
const GEMINI_SKILL_LINK = path.join(GEMINI_SKILLS_DIR, 'agy-stats');

const args = process.argv.slice(2);
const action = args.find((a) => !a.startsWith('-')) || 'install';
const skipSkill = args.includes('--no-skill');

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

function writeSettings(obj) {
  fs.mkdirSync(CLI_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2) + '\n');
}

function removePath(p) {
  try {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isSymbolicLink() || st.isFile()) {
      fs.unlinkSync(p);
    } else {
      fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
}

function installSkill() {
  const srcSkill = path.join(__dirname, 'skills', 'agy-stats');
  if (!fs.existsSync(srcSkill)) return;

  fs.mkdirSync(AGENTS_SKILL_DIR, { recursive: true });
  fs.cpSync(srcSkill, AGENTS_SKILL_DIR, { recursive: true });

  fs.mkdirSync(GEMINI_SKILLS_DIR, { recursive: true });
  removePath(GEMINI_SKILL_LINK);

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(AGENTS_SKILL_DIR, GEMINI_SKILL_LINK, 'junction');
    } else {
      const relTarget = path.relative(GEMINI_SKILLS_DIR, AGENTS_SKILL_DIR);
      fs.symlinkSync(relTarget, GEMINI_SKILL_LINK, 'dir');
    }
  } catch {
    fs.cpSync(AGENTS_SKILL_DIR, GEMINI_SKILL_LINK, { recursive: true });
  }
  console.log(`Installed skill to ${AGENTS_SKILL_DIR} (linked at ${GEMINI_SKILL_LINK})`);
}

if (action === 'install') {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`Node.js >= 22.13.0 is required (found ${process.versions.node}).`);
    process.exit(1);
  }

  fs.mkdirSync(CLI_DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'src', 'protobuf.mjs'), TARGET_PROTO);
  fs.copyFileSync(path.join(__dirname, 'src', 'pricing.mjs'), TARGET_PRICING);

  const installedStatusline = fs
    .readFileSync(path.join(__dirname, 'src', 'statusline.mjs'), 'utf8')
    .replace("from './protobuf.mjs'", "from './statusline-protobuf.mjs'");
  fs.writeFileSync(TARGET_SCRIPT, installedStatusline);
  fs.chmodSync(TARGET_SCRIPT, 0o755);

  const installedCli = fs
    .readFileSync(path.join(__dirname, 'src', 'cli.mjs'), 'utf8')
    .replace("from './protobuf.mjs'", "from './statusline-protobuf.mjs'")
    .replace("from './pricing.mjs'", "from './agy-stats-pricing.mjs'")
    .replace("from './statusline.mjs'", "from './statusline.mjs'");
  fs.writeFileSync(TARGET_CLI, installedCli);
  fs.chmodSync(TARGET_CLI, 0o755);

  if (fs.existsSync(LOCAL_BIN_DIR)) {
    if (process.platform === 'win32') {
      fs.writeFileSync(LOCAL_BIN_SHIM, `@echo off\r\n"${process.execPath}" --no-warnings "${TARGET_CLI}" %*\r\n`);
    } else {
      fs.writeFileSync(LOCAL_BIN_SHIM, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${TARGET_CLI}" "$@"\n`);
      fs.chmodSync(LOCAL_BIN_SHIM, 0o755);
    }
    console.log(`Installed agy-stats CLI to ${LOCAL_BIN_SHIM}`);
  }

  const settings = readSettings();
  settings.statusLine = {
    type: 'command',
    command: `"${process.execPath}" --no-warnings "${TARGET_SCRIPT}"`,
    stack_with_default: true
  };
  writeSettings(settings);
  console.log(`Installed statusLine to ${TARGET_SCRIPT}`);
  console.log(`Updated ${SETTINGS_PATH}`);

  if (!skipSkill) {
    installSkill();
  }
} else if (action === 'uninstall') {
  const settings = readSettings();
  delete settings.statusLine;
  writeSettings(settings);
  for (const f of [TARGET_SCRIPT, TARGET_PROTO, TARGET_CLI, TARGET_PRICING, LOCAL_BIN_SHIM, GEMINI_SKILL_LINK, AGENTS_SKILL_DIR]) {
    removePath(f);
  }
  console.log('Uninstalled agy-stats, skill, and removed statusLine from settings.json');
} else {
  console.error('Usage: node install.mjs [install|uninstall] [--no-skill]');
  process.exit(1);
}
