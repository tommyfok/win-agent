#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binName = 'win-agent';
const target = path.join(root, 'dist', 'index.js');
const home = os.homedir();

function isWritableDirectory(dir) {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries() {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function selectBinDir() {
  const entries = pathEntries();
  for (const entry of entries) {
    if (!entry.startsWith(`${home}${path.sep}`)) continue;
    if (!isWritableDirectory(entry)) continue;
    const existing = path.join(entry, binName);
    try {
      if (fs.lstatSync(existing).isSymbolicLink()) return entry;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  const localBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  if (entries.includes(localBin) && isWritableDirectory(localBin)) return localBin;

  const homeEntries = entries.filter((entry) => entry === home || entry.startsWith(`${home}${path.sep}`));
  const writableHomeEntry = homeEntries.find(isWritableDirectory);
  if (writableHomeEntry) return writableHomeEntry;

  return localBin;
}

function replaceSymlink(dest) {
  try {
    const stat = fs.lstatSync(dest);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${dest} already exists and is not a symlink`);
    }
    fs.rmSync(dest);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  fs.symlinkSync(target, dest);
}

if (!fs.existsSync(target)) {
  throw new Error(`Missing build output: ${target}. Run pnpm build first.`);
}

fs.chmodSync(target, 0o755);

const binDir = selectBinDir();
const dest = path.join(binDir, binName);
replaceSymlink(dest);

const inPath = pathEntries().includes(binDir);
console.log(`Linked ${binName} -> ${target}`);
console.log(`Bin path: ${dest}`);
if (!inPath) {
  console.log(`Note: add ${binDir} to PATH to run ${binName} directly.`);
}
