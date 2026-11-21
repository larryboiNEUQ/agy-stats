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
const LOCAL_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const LOCAL_BIN_SHIM = path.join(LOCAL_BIN_DIR, process.platform === 'win32' ? 'agy-stats.cmd' : 'agy-stats');

const action = process.argv[2] || 'install';

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

function writeSettings(obj) {
  fs.mkdirSync(CLI_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2) + '\n');
}

if (action === 'install') {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`Node.js >= 22.13.0 is required (found ${process.versions.node}).`);
    process.exit(1);
  }

  fs.mkdirSync(CLI_DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'src', 'protobuf.mjs'), TARGET_PROTO);

  const installedStatusline = fs
    .readFileSync(path.join(__dirname, 'src', 'statusline.mjs'), 'utf8')
    .replace("from './protobuf.mjs'", "from './statusline-protobuf.mjs'");
  fs.writeFileSync(TARGET_SCRIPT, installedStatusline);
  fs.chmodSync(TARGET_SCRIPT, 0o755);

  const installedCli = fs
    .readFileSync(path.join(__dirname, 'src', 'cli.mjs'), 'utf8')
    .replace("from './protobuf.mjs'", "from './statusline-protobuf.mjs'")
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
} else if (action === 'uninstall') {
  const settings = readSettings();
  delete settings.statusLine;
  writeSettings(settings);
  for (const f of [TARGET_SCRIPT, TARGET_PROTO, TARGET_CLI, LOCAL_BIN_SHIM]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  console.log('Uninstalled agy-stats and removed statusLine from settings.json');
} else {
  console.error('Usage: node install.mjs [install|uninstall]');
  process.exit(1);
}
