#!/usr/bin/env node

// Audit the bytes that npm would publish. This command never publishes or runs
// package lifecycle scripts, and all generated files stay in one fresh temp dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, statfsSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const expectedName = '@voidly/plugin-elizaos';
const expectedFiles = [
  'package.json', 'README.md', 'LICENSE',
  'dist/index.js', 'dist/index.d.ts', 'dist/walletKit.js', 'dist/walletKit.d.ts',
];
const expectedPaths = new Set(expectedFiles.map((path) => `package/${path}`));
const allowedDirectories = new Set(['package/', 'package/dist/']);
const maxArchiveBytes = 2 * 1024 * 1024;
const maxExpandedBytes = 4 * 1024 * 1024;
// Local Voidly checkouts need the 50 GiB write guard. GitHub's hosted runner
// has a 14 GiB disk; this audit writes a bounded <4 MiB archive/extraction.
const isGithubHosted = process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const minFreeBytes = (isGithubHosted ? 1n : 50n) * 1024n ** 3n;

function fail(message) {
  throw new Error(`packed-tarball audit: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, ...options,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} failed (${result.error?.code ?? `exit ${result.status}`}); see the package locally`);
  }
  return result.stdout;
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function tarOctal(bytes) {
  const value = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(value)) fail('invalid tar number');
  return Number.parseInt(value, 8);
}

function tarEntries(archive) {
  const expanded = gunzipSync(archive, { maxOutputLength: maxExpandedBytes });
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!expanded.subarray(offset).every((byte) => byte === 0)) fail('nonzero tar trailer');
      return entries;
    }
    const recordedChecksum = tarOctal(header.subarray(148, 156));
    let actualChecksum = 0;
    for (let i = 0; i < 512; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
    if (actualChecksum !== recordedChecksum) fail('tar header checksum mismatch');

    const prefix = tarString(header.subarray(345, 500));
    const name = tarString(header.subarray(0, 100));
    const path = prefix ? `${prefix}/${name}` : name;
    const type = header[156];
    const size = tarOctal(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size > maxExpandedBytes ||
        !Number.isSafeInteger(offset + 512 + size) ||
        offset + 512 + size > expanded.length) fail('invalid tar entry size');
    if (entries.has(path)) fail(`duplicate tar path: ${path}`);
    if (path.includes('\\') || path.includes('\0') || path.startsWith('/') ||
        path.split('/').some((part) => part === '.' || part === '..')) {
      fail(`unsafe tar path: ${path}`);
    }
    if (type === 53 && allowedDirectories.has(path)) {
      if (size !== 0) fail(`directory has data: ${path}`);
      entries.set(path, null);
    } else if ((type === 0 || type === 48) && expectedPaths.has(path)) {
      // Only regular files may be extracted. Links, PAX records, maps, source,
      // tests, dotfiles, credentials, and every other path fail closed.
      entries.set(path, Buffer.from(expanded.subarray(offset + 512, offset + 512 + size)));
    } else {
      fail(`unexpected tar entry: ${path} (type ${type})`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  fail('missing tar trailer');
}

function auditManifest(source, packed) {
  assert.equal(source.name, expectedName, 'source package name');
  assert.equal(packed.name, expectedName, 'packed package name');
  assert.match(source.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/, 'source version');
  assert.equal(packed.version, source.version, 'packed version must match source');
  assert.equal(source.type, 'module', 'source must be ESM');
  assert.equal(packed.type, 'module', 'packed package must be ESM');
  assert.notEqual(source.private, true, 'package must be publishable only after owner GO');
  const exportsShape = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
  assert.deepEqual(source.exports, exportsShape, 'source export map');
  assert.deepEqual(packed.exports, exportsShape, 'packed export map');
  if (source.types !== undefined) assert.equal(source.types, './dist/index.d.ts');
  if (packed.types !== undefined) assert.equal(packed.types, './dist/index.d.ts');
  assert.deepEqual(packed.scripts, source.scripts, 'packed scripts must match source');
  assert.deepEqual(packed.files, source.files, 'packed file list must match source');
  for (const name of ['prepublish', 'prepublishOnly', 'publish', 'postpublish']) {
    if (Object.hasOwn(packed.scripts ?? {}, name)) fail(`publication lifecycle script is present: ${name}`);
  }
}

function auditSecrets(entries) {
  const patterns = [
    ['private key PEM', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['OpenAI-style token', /\bsk-[A-Za-z0-9_-]{32,}\b/],
    ['npm auth token', /(?:^|\n)\s*(?:\/\/[^\n]+\/:)?_authToken\s*=\s*\S+/i],
    ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|private[_-]?key|signing[_-]?seed|client[_-]?secret)\b\s*[:=]\s*["'`](?!example|your|placeholder|REPLACE)[A-Za-z0-9_\-/+=]{24,}["'`]/i],
  ];
  for (const path of expectedPaths) {
    const content = entries.get(path).toString('utf8');
    for (const [label, pattern] of patterns) {
      if (pattern.test(content)) fail(`${label} appears in ${path}`);
    }
  }
}

function extractChecked(entries, destination) {
  for (const path of expectedPaths) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, entries.get(path), { flag: 'wx', mode: 0o600 });
  }
  return join(destination, 'package');
}

function auditConsumer(packageRoot) {
  const consumer = join(packageRoot, '.audit-consumer.mjs');
  writeFileSync(consumer, `
import assert from 'node:assert/strict';
globalThis.fetch = async () => { throw new Error('network use forbidden during package audit'); };
const imported = await import('@voidly/plugin-elizaos');
assert.equal(typeof imported.createVoidlyPublicPlugin, 'function');
assert.equal(typeof imported.createVoidlyWalletKitPlugin, 'function');
const expected = [
  'VOIDLY_PUBLIC_SERVICES', 'VOIDLY_PUBLIC_BOARD', 'VOIDLY_PUBLIC_POSTED_JOBS',
];
for (const plugin of [imported.default, imported.createVoidlyPublicPlugin(globalThis.fetch)]) {
  assert.equal(plugin.name, 'voidly-public-discovery');
  assert.deepEqual(plugin.actions.map((action) => action.name), expected);
  for (const action of plugin.actions) {
    assert.equal(typeof action.validate, 'function');
    assert.equal(typeof action.handler, 'function');
  }
}
`, { flag: 'wx', mode: 0o600 });
  run(process.execPath, [consumer], {
    cwd: packageRoot, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10_000,
  });
}

function main() {
  for (const path of [root, tmpdir()]) {
    const space = statfsSync(path, { bigint: true });
    if (space.bavail * space.bsize < minFreeBytes) {
      fail(`less than ${isGithubHosted ? 1 : 50} GiB free; no pack attempted`);
    }
  }
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const temp = mkdtempSync(join(tmpdir(), 'voidly-eliza-pack-'));
  try {
    const output = run('npm', [
      'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temp,
    ], {
      cwd: root,
      env: {
        ...process.env,
        npm_config_ignore_scripts: 'true', npm_config_offline: 'true',
        npm_config_cache: join(temp, 'npm-cache'), npm_config_audit: 'false',
        npm_config_fund: 'false', npm_config_update_notifier: 'false',
      },
    });
    const packs = JSON.parse(output);
    if (!Array.isArray(packs) || packs.length !== 1) fail('npm pack returned unexpected metadata');
    const pack = packs[0];
    if (pack.name !== expectedName || pack.version !== source.version ||
        pack.filename !== `voidly-plugin-elizaos-${source.version}.tgz`) {
      fail('npm pack name, version, or filename mismatch');
    }
    const packedPaths = pack.files?.map((file) => file.path);
    assert.deepEqual(packedPaths?.sort(), [...expectedFiles].sort(), 'npm pack file list');
    const archivePath = join(temp, pack.filename);
    const stat = lstatSync(archivePath);
    if (!stat.isFile() || stat.size > maxArchiveBytes) fail('archive is missing or too large');
    const archive = readFileSync(archivePath);
    const entries = tarEntries(archive);
    assert.deepEqual(
      [...entries].filter(([, bytes]) => bytes !== null).map(([path]) => path).sort(),
      [...expectedPaths].sort(), 'actual tar entries',
    );
    const packed = JSON.parse(entries.get('package/package.json').toString('utf8'));
    auditManifest(source, packed);
    auditSecrets(entries);
    const packageRoot = extractChecked(entries, join(temp, 'extracted'));
    auditConsumer(packageRoot);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    console.log(`Packed tarball PASS: ${pack.filename} sha256=${sha256} (${expectedFiles.length} files; ESM consumer OK)`);
  } finally {
    console.log(`Packed-tarball audit files retained at ${temp}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
