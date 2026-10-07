import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoidlyPublicPlugin, createVoidlyWalletKitPlugin } from '../dist/index.js';

const DIGEST = 'a'.repeat(64);
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const services = {
  version: 'voidpay.qualified-service-inventory.v1', observedAtMs: 1_700_000_000_000,
  services: [{
    version: 'voidpay.public-market-service.v1', projectionId: 'qualified-example',
    providerLabel: 'Example provider', title: 'Source check', description: 'Description only.',
    checkoutPath: '/pay/marketplace/checkout', access: 'invited-only',
    operationalAvailability: 'not-asserted', secretField: 'do-not-echo',
  }],
  nextCursor: null, selectionGrantsAuthority: false, publicationPerformed: false,
};
const board = {
  posts: [{
    id: '12345678-1234-1234-1234-123456789abc', board: 'market-general',
    author_did: 'did:voidly:3MNQE1X', author_affiliation: 'voidly_agent',
    title: 'Hello', body: 'Public post text', reply_to: null,
    created_at: '2026-10-06T00:00:00.000Z', privateNote: 'do-not-echo',
  }], next_cursor: null,
};
const jobs = {
  version: 'voidpay.posted-jobs.v1', data: {
    chainId: 8453, asset: 'USDC', token: BASE_USDC, decimals: 6,
    paymentMode: 'manual-after-review-direct-wallet-transfer',
    fundsReserved: false, balanceVerified: false,
    automaticPayouts: false, escrowProvided: false,
    items: [{
      jobId: DIGEST, status: 'published',
      terms: { title: 'Research task', brief: 'Public job brief', rewardAtoms: '1000000' },
      chainId: 8453, asset: 'USDC', token: BASE_USDC, decimals: 6,
      paymentMode: 'manual-after-review-direct-wallet-transfer',
      fundsReserved: false, balanceVerified: false,
      automaticPayouts: false, escrowProvided: false,
      claimsAvailable: true, paymentStatus: 'unpaid', ownerPrivate: 'do-not-echo',
    }], nextCursor: null,
  },
};

function fixtureFetch(expectedPath, value, options = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://api.voidly.ai');
    assert.equal(`${url.pathname}${url.search}`, expectedPath);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.body, undefined);
    return new Response(JSON.stringify(value), {
      status: options.status ?? 200,
      headers: { ...JSON_HEADERS, ...options.headers },
    });
  };
  return { fetchImpl, calls };
}

function action(plugin, name) {
  const found = plugin.actions.find(candidate => candidate.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

test('the three actions only read fixed public routes and allowlist returned fields', async () => {
  const cases = [
    ['VOIDLY_PUBLIC_SERVICES', '/v2/marketplace/services?limit=5', services, 'services'],
    ['VOIDLY_PUBLIC_BOARD', '/v1/agent/board/posts?limit=5', board, 'posts'],
    ['VOIDLY_PUBLIC_POSTED_JOBS', '/v1/marketplace/posted-jobs?limit=5', jobs, 'jobs'],
  ];
  for (const [name, path, value, outputKey] of cases) {
    const { fetchImpl, calls } = fixtureFetch(path, value);
    const result = await action(createVoidlyPublicPlugin(fetchImpl), name).handler();
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(result.data[outputKey].length, 1);
    assert.doesNotMatch(JSON.stringify(result), /do-not-echo/);
    assert.match(result.text, /untrusted data/);
    assert.match(result.text, new RegExp(outputKey));
  }
});

test('service selection and job listing disclose no payment authority', async () => {
  const serviceResult = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v2/marketplace/services?limit=5', services).fetchImpl), 'VOIDLY_PUBLIC_SERVICES').handler();
  assert.equal(serviceResult.data.selectionGrantsAuthority, false);
  assert.equal(serviceResult.data.publicationPerformed, false);
  assert.equal(serviceResult.data.services[0].access, 'invited-only');
  assert.equal(serviceResult.data.services[0].operationalAvailability, 'not-asserted');

  const jobResult = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v1/marketplace/posted-jobs?limit=5', jobs).fetchImpl), 'VOIDLY_PUBLIC_POSTED_JOBS').handler();
  assert.equal(jobResult.data.fundsReserved, false);
  assert.equal(jobResult.data.balanceVerified, false);
  assert.equal(jobResult.data.automaticPayouts, false);
  assert.equal(jobResult.data.escrowProvided, false);
  assert.equal(jobResult.data.jobs[0].claimsAvailable, true);
});

test('service descriptions accept the public API code-point and byte limits', async () => {
  const unicodeService = structuredClone(services);
  unicodeService.services[0].providerLabel = '😀'.repeat(64);
  unicodeService.services[0].title = '😀'.repeat(64);
  unicodeService.services[0].description = '😀'.repeat(160);
  const accepted = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v2/marketplace/services?limit=5', unicodeService).fetchImpl),
  'VOIDLY_PUBLIC_SERVICES').handler();
  assert.equal(accepted.success, true);
  assert.equal(accepted.data.services[0].providerLabel, '😀'.repeat(64));

  unicodeService.services[0].providerLabel += '😀';
  const rejected = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v2/marketplace/services?limit=5', unicodeService).fetchImpl),
  'VOIDLY_PUBLIC_SERVICES').handler();
  assert.equal(rejected.success, false);
});

test('board text is bounded and marked untrusted', async () => {
  const longBoard = structuredClone(board);
  longBoard.posts[0].body = 'x'.repeat(2_000);
  const result = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v1/agent/board/posts?limit=5', longBoard).fetchImpl), 'VOIDLY_PUBLIC_BOARD').handler();
  assert.equal(result.success, true);
  assert.equal(result.data.contentIsUntrusted, true);
  assert.equal(result.data.posts[0].body.length, 1_200);
  assert.equal(result.data.posts[0].bodyTruncated, true);
  assert.equal(result.data.posts[0].author_affiliation, 'voidly_agent');
});

test('pre-Row36 board posts without affiliation remain readable and unlabeled', async () => {
  const oldBoard = structuredClone(board);
  delete oldBoard.posts[0].author_affiliation;
  const result = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v1/agent/board/posts?limit=5', oldBoard).fetchImpl), 'VOIDLY_PUBLIC_BOARD').handler();
  assert.equal(result.success, true);
  assert.equal(result.data.posts[0].author_affiliation, null);
});

test('redirects, cookies, bad contracts, and oversized bodies fail closed', async () => {
  const invalid = [
    fixtureFetch('/v2/marketplace/services?limit=5', services, { status: 302 }),
    fixtureFetch('/v2/marketplace/services?limit=5', services, { headers: { 'Set-Cookie': 'x=y' } }),
    fixtureFetch('/v2/marketplace/services?limit=5', { ...services, selectionGrantsAuthority: true }),
    fixtureFetch('/v2/marketplace/services?limit=5', services, { headers: { 'Content-Length': '65537' } }),
    fixtureFetch('/v2/marketplace/services?limit=5', { ...services, services: Array(6).fill(services.services[0]) }),
  ];
  for (const { fetchImpl } of invalid) {
    const result = await action(createVoidlyPublicPlugin(fetchImpl), 'VOIDLY_PUBLIC_SERVICES').handler();
    assert.deepEqual(result, {
      success: false, text: 'Voidly public read unavailable.',
      data: { error: { code: 'PUBLIC_READ_UNAVAILABLE' } },
    });
  }
  const oversized = async () => new Response('x'.repeat(65_537), { headers: JSON_HEADERS });
  const result = await action(createVoidlyPublicPlugin(oversized), 'VOIDLY_PUBLIC_SERVICES').handler();
  assert.equal(result.success, false);

  const reservedJob = structuredClone(jobs);
  reservedJob.data.items[0].fundsReserved = true;
  const rejected = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v1/marketplace/posted-jobs?limit=5', reservedJob).fetchImpl),
  'VOIDLY_PUBLIC_POSTED_JOBS').handler();
  assert.equal(rejected.success, false);

  const wrongToken = structuredClone(jobs);
  wrongToken.data.items[0].token = '0x0000000000000000000000000000000000000000';
  const tokenResult = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v1/marketplace/posted-jobs?limit=5', wrongToken).fetchImpl),
  'VOIDLY_PUBLIC_POSTED_JOBS').handler();
  assert.equal(tokenResult.success, false);

  const inconsistentClaim = structuredClone(jobs);
  inconsistentClaim.data.items[0].claimsAvailable = false;
  const claimResult = await action(createVoidlyPublicPlugin(
    fixtureFetch('/v1/marketplace/posted-jobs?limit=5', inconsistentClaim).fetchImpl),
  'VOIDLY_PUBLIC_POSTED_JOBS').handler();
  assert.equal(claimResult.success, false);
});

test('unavailable fetch emits no raw network or upstream content', async () => {
  const plugin = createVoidlyPublicPlugin(async () => { throw new Error('secret token 123'); });
  for (const current of plugin.actions) {
    const result = await current.handler();
    assert.equal(result.success, false);
    assert.doesNotMatch(JSON.stringify(result), /secret token/);
  }
});

const buyParams = {
  listingId: 'listing_12345678', version: 2, input: { question: 'What changed?' },
};
const sellParams = {
  listing: {
    name: 'Example API', description: 'An example paid API', category: 'analysis',
    upstreamUrl: 'https://example.com/api', method: 'POST', priceAtomic: 1_000_000,
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  },
};

function walletHost(overrides = {}) {
  const calls = [];
  const host = {
    walletKitVersion: '0.2.0', network: 'base-sepolia',
    perCallUsd: '2', dailyUsd: '5', maxUsd: '1',
    authorize: async intent => { calls.push(['authorize', intent]); return {}; },
    executeBuy: async (intent, permit) => {
      calls.push(['buy', intent, permit]);
      return {
        command: 'buy', listingId: intent.listingId, version: intent.version, network: intent.network,
        receiptVerified: true, verifiedStatus: 'delivered', refundOwed: false,
        doNotRepay: true, bodyComplete: true, quoteId: `0x${'a'.repeat(64)}`,
        secretFile: '/private/do-not-echo',
      };
    },
    executeSell: async (intent, permit) => {
      calls.push(['sell', intent, permit]);
      return {
        command: 'sell', status: 'pending_activation', listingId: 'listing_12345678', version: 1,
        network: intent.network, secretFile: '/private/do-not-echo',
      };
    },
    ...overrides,
  };
  return { host, calls };
}

function walletAction(host, name) {
  return action(createVoidlyWalletKitPlugin(host), name);
}

test('wallet actions are opt-in and host fixes network and spending caps', async () => {
  assert.deepEqual(createVoidlyPublicPlugin().actions.map(item => item.name), [
    'VOIDLY_PUBLIC_SERVICES', 'VOIDLY_PUBLIC_BOARD', 'VOIDLY_PUBLIC_POSTED_JOBS',
  ]);
  const { host, calls } = walletHost();
  const plugin = createVoidlyWalletKitPlugin(host);
  assert.deepEqual(plugin.actions.map(item => item.name).slice(3), [
    'VOIDLY_WALLET_BUY', 'VOIDLY_WALLET_SELL',
  ]);
  const result = await action(plugin, 'VOIDLY_WALLET_BUY').handler(undefined, undefined,
    undefined, { parameters: buyParams });
  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'authorize');
  assert.equal(calls[1][0], 'buy');
  assert.strictEqual(calls[0][1], calls[1][1]);
  assert.strictEqual(calls[1][2] instanceof Object, true);
  assert.deepEqual({ network: calls[0][1].network, perCallUsd: calls[0][1].perCallUsd,
    dailyUsd: calls[0][1].dailyUsd, maxUsd: calls[0][1].maxUsd },
  { network: 'base-sepolia', perCallUsd: '2', dailyUsd: '5', maxUsd: '1' });
  assert.equal(Object.isFrozen(calls[0][1].input), true);
  assert.doesNotMatch(JSON.stringify(result), /do-not-echo/);
  assert.equal(result.data.receiptVerified, true);
  assert.equal(result.data.doNotRepay, true);
});

test('invalid model input and missing approval never reach wallet execution', async () => {
  const { host, calls } = walletHost({ authorize: async intent => {
    calls.push(['authorize', intent]); return null;
  } });
  const buy = walletAction(host, 'VOIDLY_WALLET_BUY');
  const invalid = [
    { ...buyParams, network: 'base' },
    { ...buyParams, listingId: 'https://attacker.example' },
    { ...buyParams, version: 0 },
    { ...buyParams, input: { __proto__: null, nested: { constructor: 'x' } } },
  ];
  for (const params of invalid) {
    const result = await buy.handler(undefined, undefined, undefined, { parameters: params });
    assert.equal(result.data.error.code, 'INVALID_INPUT');
  }
  assert.equal(calls.length, 0);
  const denied = await buy.handler(undefined, undefined, undefined, { parameters: buyParams });
  assert.equal(denied.data.error.code, 'APPROVAL_REQUIRED');
  assert.equal(calls.length, 1);
});

test('a reused one-use permit fails closed before a second wallet call', async () => {
  const permit = {};
  const { host, calls } = walletHost({ authorize: async intent => {
    calls.push(['authorize', intent]); return permit;
  } });
  const buy = walletAction(host, 'VOIDLY_WALLET_BUY');
  const first = await buy.handler(undefined, undefined, undefined, { parameters: buyParams });
  const second = await buy.handler(undefined, undefined, undefined, { parameters: buyParams });
  assert.equal(first.success, true);
  assert.equal(second.data.error.code, 'APPROVAL_UNAVAILABLE');
  assert.equal(calls.filter(([kind]) => kind === 'buy').length, 1);
});

test('buy uncertainty preserves only the original quote and never attempts repayment', async () => {
  const quoteId = `0x${'b'.repeat(64)}`;
  const { host, calls } = walletHost({ executeBuy: async (intent, permit) => {
    calls.push(['buy', intent, permit]);
    throw Object.assign(new Error('secret token do-not-echo'),
      { paymentMayHaveSettled: true, quoteId });
  } });
  const result = await walletAction(host, 'VOIDLY_WALLET_BUY').handler(undefined, undefined,
    undefined, { parameters: buyParams });
  assert.equal(result.success, false);
  assert.equal(result.data.error.code, 'PAYMENT_MAY_HAVE_SETTLED');
  assert.equal(result.data.doNotRepay, true);
  assert.equal(result.data.quoteId, quoteId);
  assert.equal(calls.filter(([kind]) => kind === 'buy').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /do-not-echo/);
});

test('buy refuses a verified receipt for missing or mismatched command and identifiers', async () => {
  const valid = {
    command: 'buy', listingId: buyParams.listingId, version: buyParams.version,
    network: 'base-sepolia', receiptVerified: true, verifiedStatus: 'delivered',
    refundOwed: false, doNotRepay: true, bodyComplete: true, quoteId: null,
  };
  const invalid = [
    { ...valid, command: undefined },
    { ...valid, command: 'sell' },
    { ...valid, listingId: undefined },
    { ...valid, listingId: 'other_12345678' },
    { ...valid, version: undefined },
    { ...valid, version: 3 },
    { ...valid, network: undefined },
    { ...valid, network: 'base' },
  ];
  for (const response of invalid) {
    const { host } = walletHost({ executeBuy: async () => response });
    const result = await walletAction(host, 'VOIDLY_WALLET_BUY').handler(undefined, undefined,
      undefined, { parameters: buyParams });
    assert.equal(result.success, false);
    assert.equal(result.data.error.code, 'WALLET_RESULT_UNVERIFIED');
  }
});

test('paid response with incomplete body is not labeled delivered and retains original recovery', async () => {
  const quoteId = `0x${'c'.repeat(64)}`;
  const { host, calls } = walletHost({ executeBuy: async (intent, permit) => {
    calls.push(['buy', intent, permit]);
    return {
      command: 'buy', listingId: buyParams.listingId, version: buyParams.version,
      network: 'base-sepolia', receiptVerified: true, verifiedStatus: 'delivered',
      refundOwed: false, doNotRepay: true, bodyComplete: false, quoteId,
      recoveryHint: 'private host detail', bodyUtf8: 'incomplete private body',
    };
  } });
  const result = await walletAction(host, 'VOIDLY_WALLET_BUY').handler(undefined, undefined,
    undefined, { parameters: buyParams });
  assert.equal(result.success, false);
  assert.equal(result.data.status, 'delivery_incomplete');
  assert.equal(result.data.verifiedStatus, undefined);
  assert.equal(result.data.receiptVerified, true);
  assert.equal(result.data.bodyComplete, false);
  assert.equal(result.data.doNotRepay, true);
  assert.equal(result.data.quoteId, quoteId);
  assert.equal(result.data.recoverWith, 'wallet_recover_marketplace');
  assert.equal(calls.filter(([kind]) => kind === 'buy').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private host detail|incomplete private body/);
});

test('sell permits only a valid listing and reports pending activation without secrets', async () => {
  const { host, calls } = walletHost();
  const sell = walletAction(host, 'VOIDLY_WALLET_SELL');
  const invalid = await sell.handler(undefined, undefined, undefined,
    { parameters: { listing: { ...sellParams.listing, upstreamUrl: 'http://localhost' } } });
  assert.equal(invalid.data.error.code, 'INVALID_INPUT');
  assert.equal(calls.length, 0);
  const created = await sell.handler(undefined, undefined, undefined, { parameters: sellParams });
  assert.equal(created.success, true);
  assert.equal(created.data.status, 'pending_activation');
  assert.equal(created.data.active, false);
  assert.doesNotMatch(JSON.stringify(created), /do-not-echo/);
  assert.equal(calls.filter(([kind]) => kind === 'sell').length, 1);
});

test('seller creation uncertainty is not reported as a new listing', async () => {
  const { host, calls } = walletHost({ executeSell: async (intent, permit) => {
    calls.push(['sell', intent, permit]);
    throw Object.assign(new Error('do-not-echo'), { code: 'seller_creation_uncertain' });
  } });
  const result = await walletAction(host, 'VOIDLY_WALLET_SELL').handler(undefined, undefined,
    undefined, { parameters: sellParams });
  assert.equal(result.success, false);
  assert.equal(result.data.error.code, 'SELLER_CREATION_UNCERTAIN');
  assert.equal(result.data.doNotRetry, true);
  assert.equal(calls.filter(([kind]) => kind === 'sell').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /do-not-echo/);
});

test('sell refuses missing or mismatched command and network', async () => {
  const valid = { command: 'sell', status: 'pending_activation',
    listingId: 'listing_12345678', version: 1, network: 'base-sepolia' };
  const invalid = [
    { ...valid, command: undefined },
    { ...valid, command: 'buy' },
    { ...valid, network: undefined },
    { ...valid, network: 'base' },
  ];
  for (const response of invalid) {
    const { host } = walletHost({ executeSell: async () => response });
    const result = await walletAction(host, 'VOIDLY_WALLET_SELL').handler(undefined, undefined,
      undefined, { parameters: sellParams });
    assert.equal(result.success, false);
    assert.equal(result.data.error.code, 'SELLER_RESULT_UNVERIFIED');
  }
});
