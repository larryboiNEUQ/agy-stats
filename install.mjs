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
  fs.copyFileSync(path.join(__dirname, 'src', 'statusline.mjs'), TARGET_SCRIPT);
  fs.copyFileSync(path.join(__dirname, 'src', 'protobuf.mjs'), TARGET_PROTO);
  // Keep import path aligned in installed flat directory
  const installedSrc = fs
    .readFileSync(TARGET_SCRIPT, 'utf8')
    .replace("from './protobuf.mjs'", "from './statusline-protobuf.mjs'");
  fs.writeFileSync(TARGET_SCRIPT, installedSrc);
  fs.chmodSync(TARGET_SCRIPT, 0o755);

  const settings = readSettings();
  settings.statusLine = {
    type: 'command',
    command: `${process.execPath} --no-warnings ${TARGET_SCRIPT}`,
    stack_with_default: true
  };
  writeSettings(settings);
  console.log(`Installed agy-statusline to ${TARGET_SCRIPT}`);
  console.log(`Updated ${SETTINGS_PATH}`);
} else if (action === 'uninstall') {
  const settings = readSettings();
  delete settings.statusLine;
  writeSettings(settings);
  for (const f of [TARGET_SCRIPT, TARGET_PROTO]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  console.log('Uninstalled agy-statusline and removed statusLine from settings.json');
} else {
  console.error('Usage: node install.mjs [install|uninstall]');
  process.exit(1);
}
