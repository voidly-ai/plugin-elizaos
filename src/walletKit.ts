import type { Action } from '@elizaos/core';

export type VoidlyNetwork = 'base' | 'base-sepolia';

/** Wallet-kit 0.2.0 seller payload; validated again by its runtime validator. */
export interface VoidlySellerListingInput {
  name: string;
  description: string;
  category: string;
  upstreamUrl: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  priceAtomic: number;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tags?: string[];
  outputPrivacy?: 'plain-json' | 'buyer-encrypted';
}

export interface BuyIntent {
  readonly kind: 'buy';
  readonly network: VoidlyNetwork;
  readonly listingId: string;
  readonly version: number;
  readonly input: Readonly<Record<string, unknown>>;
  readonly perCallUsd: string;
  readonly dailyUsd: string;
  readonly maxUsd: string;
}

export interface SellIntent {
  readonly kind: 'sell';
  readonly network: VoidlyNetwork;
  readonly listing: Readonly<VoidlySellerListingInput>;
}

/**
 * The host owns approval, wallet-kit 0.2.0 CLI/API execution, durable state,
 * secret custody, and the one-use permit. A permit must be consumed atomically
 * by the host; the plugin also rejects reuse within this process.
 */
export interface WalletKitV02Host {
  readonly walletKitVersion: '0.2.0';
  readonly network: VoidlyNetwork;
  readonly perCallUsd: string;
  readonly dailyUsd: string;
  readonly maxUsd: string;
  authorize(intent: BuyIntent | SellIntent): Promise<object | null>;
  executeBuy(intent: BuyIntent, permit: object): Promise<unknown>;
  executeSell(intent: SellIntent, permit: object): Promise<unknown>;
}

const LISTING_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const QUOTE_ID = /^0x[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const USD = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/;

function usdAtomic(value: string): bigint {
  if (!USD.test(value)) throw new Error('INVALID_LIMIT');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('INVALID_INPUT');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('INVALID_INPUT');
  }
}

function checkedJsonObject(value: unknown, maxBytes: number): Record<string, unknown> {
  row(value);
  const ancestors = new Set<object>();
  let nodes = 0;
  function encode(item: unknown, depth: number): string {
    if (++nodes > 2_048 || depth >= 16) throw new Error('INVALID_INPUT');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        throw new Error('INVALID_INPUT');
      }
      return JSON.stringify(item);
    }
    if (typeof item === 'string') {
      if (item.length > 16_384 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) {
        throw new Error('INVALID_INPUT');
      }
      return JSON.stringify(item);
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('INVALID_INPUT');
    ancestors.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      if (item.length > 2_048 || item.some((_, index) => !(index in item))) throw new Error('INVALID_INPUT');
      encoded = `[${item.map(part => encode(part, depth + 1)).join(',')}]`;
    } else {
      const object = row(item);
      const fields = Object.keys(object).sort().map(key => {
        if (key.length > 128 || UNSAFE_KEYS.has(key)) throw new Error('INVALID_INPUT');
        const field = Object.getOwnPropertyDescriptor(object, key);
        if (!field || !Object.hasOwn(field, 'value')) throw new Error('INVALID_INPUT');
        return `${JSON.stringify(key)}:${encode(field.value, depth + 1)}`;
      });
      encoded = `{${fields.join(',')}}`;
    }
    ancestors.delete(item);
    return encoded;
  }
  const json = encode(value, 0);
  if (new TextEncoder().encode(json).byteLength > maxBytes) throw new Error('INVALID_INPUT');
  return JSON.parse(json) as Record<string, unknown>;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function parameters(options: unknown): Record<string, unknown> {
  const value = row(options);
  return row(value.parameters);
}

function buyParameters(options: unknown): { listingId: string; version: number; input: Record<string, unknown> } {
  const value = parameters(options);
  exactKeys(value, ['listingId', 'version', 'input']);
  if (typeof value.listingId !== 'string' || !LISTING_ID.test(value.listingId) ||
      !Number.isSafeInteger(value.version) || Number(value.version) < 1) throw new Error('INVALID_INPUT');
  return {
    listingId: value.listingId,
    version: value.version as number,
    input: checkedJsonObject(value.input, 65_536),
  };
}

function sellParameters(options: unknown): { listing: Record<string, unknown> } {
  const value = parameters(options);
  exactKeys(value, ['listing']);
  return { listing: checkedJsonObject(value.listing, 12_000) };
}

function safeResult(value: unknown): Record<string, unknown> | null {
  try { return row(value); } catch { return null; }
}

/** Read only named own data fields from wallet-kit error classes or CLI result objects. */
function marker(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, 'value') ? field.value : undefined;
}

function failure(code: string, text: string, data: Record<string, unknown> = {}) {
  return { success: false, text, data: { error: { code }, ...data } };
}

function buyUncertainty(value: unknown) {
  if (marker(value, 'paymentMayHaveSettled') !== true) return null;
  const rawQuoteId = marker(value, 'quoteId');
  const quoteId = typeof rawQuoteId === 'string' && QUOTE_ID.test(rawQuoteId) ? rawQuoteId : null;
  return failure('PAYMENT_MAY_HAVE_SETTLED',
    'Payment outcome is uncertain. Do not pay again; recover the original marketplace attempt.',
    { paymentMayHaveSettled: true, doNotRepay: true, quoteId,
      recoverWith: quoteId ? 'wallet_recover_marketplace' : null });
}

function sellerUncertainty(value: unknown) {
  const code = marker(value, 'code');
  if (code !== 'seller_creation_uncertain' && code !== 'seller_secret_persistence_failed') {
    return null;
  }
  const rawListingId = marker(value, 'listingId');
  const listingId = typeof rawListingId === 'string' && LISTING_ID.test(rawListingId)
    ? rawListingId : null;
  return failure('SELLER_CREATION_UNCERTAIN',
    'Seller creation may have succeeded. Do not submit it again; reconcile the original attempt.',
    { doNotRetry: true, listingId });
}

function buyResult(value: unknown, intent: BuyIntent) {
  const uncertain = buyUncertainty(value);
  if (uncertain) return uncertain;
  const result = safeResult(value);
  const quoteId = result?.quoteId === null ? null :
    typeof result?.quoteId === 'string' && QUOTE_ID.test(result.quoteId) ? result.quoteId : null;
  if (!result || result.command !== 'buy' || result.receiptVerified !== true || result.doNotRepay !== true ||
      (result.verifiedStatus !== 'delivered' && result.verifiedStatus !== 'refund_owed') ||
      typeof result.bodyComplete !== 'boolean' ||
      (result.quoteId !== undefined && result.quoteId !== null && quoteId === null) ||
      result.listingId !== intent.listingId || result.version !== intent.version ||
      result.network !== intent.network ||
      (result.refundOwed !== undefined && result.refundOwed !== (result.verifiedStatus === 'refund_owed'))) {
    return failure('WALLET_RESULT_UNVERIFIED', 'Wallet result could not be verified. Check the original attempt before another call.');
  }
  const delivered = result.verifiedStatus === 'delivered' && result.bodyComplete;
  const status = delivered ? 'delivered' : result.verifiedStatus === 'refund_owed'
    ? 'refund_owed' : 'delivery_incomplete';
  return {
    success: delivered,
    text: delivered ? 'Voidly marketplace delivery receipt verified.' :
      result.verifiedStatus === 'refund_owed' ? 'Voidly payment verified; refund is owed. Do not pay again.' :
        'Voidly receipt verified, but the response body is incomplete. Recover the original attempt; do not pay again.',
    data: {
      listingId: intent.listingId, version: intent.version, network: intent.network,
      status, receiptVerified: true,
      ...(status === 'delivery_incomplete' ? {} : { verifiedStatus: result.verifiedStatus }),
      refundOwed: result.verifiedStatus === 'refund_owed', doNotRepay: true,
      bodyComplete: result.bodyComplete, quoteId,
      recoverWith: quoteId ? 'wallet_recover_marketplace' : 'wallet_marketplace_attempts',
    },
  };
}

function sellResult(value: unknown, intent: SellIntent) {
  const uncertain = sellerUncertainty(value);
  if (uncertain) return uncertain;
  const result = safeResult(value);
  if (!result || result.command !== 'sell' || result.status !== 'pending_activation' ||
      typeof result.listingId !== 'string' || !LISTING_ID.test(result.listingId) ||
      !Number.isSafeInteger(result.version) || Number(result.version) < 1 ||
      result.network !== intent.network) {
    return failure('SELLER_RESULT_UNVERIFIED', 'Seller creation result could not be verified. Reconcile the original attempt.');
  }
  return {
    success: true,
    text: 'Voidly listing created pending activation. It is not available for buyers yet.',
    data: { status: 'pending_activation', listingId: result.listingId,
      version: result.version as number, network: intent.network, active: false },
  };
}

export function walletKitActions(host: WalletKitV02Host): Action[] {
  if (host.walletKitVersion !== '0.2.0' ||
      (host.network !== 'base' && host.network !== 'base-sepolia')) {
    throw new Error('Invalid wallet-kit 0.2.0 host configuration');
  }
  const perCall = usdAtomic(host.perCallUsd);
  const daily = usdAtomic(host.dailyUsd);
  const max = usdAtomic(host.maxUsd);
  if (perCall <= 0n || daily < perCall || max <= 0n || max > perCall) {
    throw new Error('Invalid wallet-kit 0.2.0 host spending caps');
  }
  const config = freezeDeep({ network: host.network, perCallUsd: host.perCallUsd,
    dailyUsd: host.dailyUsd, maxUsd: host.maxUsd });
  const usedPermits = new WeakSet<object>();
  async function authorize(intent: BuyIntent | SellIntent): Promise<object | null> {
    const permit = await host.authorize(intent);
    if (permit === null) return null;
    if (typeof permit !== 'object' || usedPermits.has(permit)) throw new Error('INVALID_PERMIT');
    usedPermits.add(permit);
    return permit;
  }
  return [
    {
      name: 'VOIDLY_WALLET_BUY',
      description: 'Buy one exact Voidly marketplace listing with a host-approved wallet-kit 0.2.0 operation. The host fixes network and USDC caps; payment may be irreversible.',
      parameters: [
        { name: 'listingId', description: 'Exact marketplace listing ID.', required: true,
          schema: { type: 'string', pattern: LISTING_ID.source, minLength: 8, maxLength: 64 } },
        { name: 'version', description: 'Exact positive listing version.', required: true,
          schema: { type: 'integer', minimum: 1 } },
        { name: 'input', description: 'JSON object for the listing request.', required: true,
          schema: { type: 'object', additionalProperties: true } },
      ],
      validate: async () => true,
      handler: async (_runtime, _message, _state, options) => {
        let intent: BuyIntent;
        try {
          const params = buyParameters(options);
          const walletKit = await import('@voidly/agent-wallet');
          const limits = walletKit.validateSpendLimits(config);
          const max = walletKit.usdToAtomic(config.maxUsd);
          if (max <= 0n || max > limits.perCall) throw new Error('INVALID_LIMIT');
          intent = freezeDeep({ kind: 'buy', ...config, ...params });
        } catch { return failure('INVALID_INPUT', 'Voidly buy request is invalid or wallet-kit 0.2.0 is unavailable.'); }
        let permit: object | null;
        try { permit = await authorize(intent); }
        catch { return failure('APPROVAL_UNAVAILABLE', 'Voidly buy approval is unavailable.'); }
        if (!permit) return failure('APPROVAL_REQUIRED', 'Voidly buy requires a host-issued one-use approval.');
        try { return buyResult(await host.executeBuy(intent, permit), intent); }
        catch (error) {
          return buyUncertainty(error) ?? failure('WALLET_EXECUTION_UNAVAILABLE',
            'Voidly buy did not return a verified result. Check the host attempt record before another call.');
        }
      },
    },
    {
      name: 'VOIDLY_WALLET_SELL',
      description: 'Create one Voidly marketplace listing with a host-approved wallet-kit 0.2.0 operation. A created listing remains pending activation.',
      parameters: [
        { name: 'listing', description: 'Exact seller listing JSON object.', required: true,
          schema: { type: 'object', additionalProperties: true } },
      ],
      validate: async () => true,
      handler: async (_runtime, _message, _state, options) => {
        let intent: SellIntent;
        try {
          const params = sellParameters(options);
          const walletKit = await import('@voidly/agent-wallet');
          intent = freezeDeep({ kind: 'sell', network: config.network,
            listing: walletKit.validateVoidlySellerListingInput(params.listing) });
        } catch { return failure('INVALID_INPUT', 'Voidly sell request is invalid or wallet-kit 0.2.0 is unavailable.'); }
        let permit: object | null;
        try { permit = await authorize(intent); }
        catch { return failure('APPROVAL_UNAVAILABLE', 'Voidly sell approval is unavailable.'); }
        if (!permit) return failure('APPROVAL_REQUIRED', 'Voidly sell requires a host-issued one-use approval.');
        try { return sellResult(await host.executeSell(intent, permit), intent); }
        catch (error) {
          return sellerUncertainty(error) ?? failure('WALLET_EXECUTION_UNAVAILABLE',
            'Voidly sell did not return a verified result. Reconcile the host attempt record.');
        }
      },
    },
  ];
}
