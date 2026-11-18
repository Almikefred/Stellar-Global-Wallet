import { scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  CONTRACT_EVENT_VERSION,
  GENERATED_EVENT_SCHEMAS,
  type GeneratedEventSchema,
} from "./generated/walletEvents.generated";

/**
 * Decodes globe-wallet contract events (issue #192). Every event's topics are
 * `(name: Symbol, version: u32)`; struct payloads listed in the generated
 * schema are decoded into plain objects with stable JS types:
 * addresses/strings as strings, 64/128-bit integers as decimal strings,
 * bytes as lowercase hex, `Option<T>` as `T | null`.
 */
export interface DecodedContractEvent {
  name: string;
  version: number;
  /** True when `name` has a generated typed schema. */
  typed: boolean;
  payload: unknown;
}

export class UnsupportedEventVersionError extends Error {
  constructor(readonly eventName: string, readonly version: number) {
    super(
      `globe-wallet event "${eventName}" has schema version ${version}; this backend understands ${CONTRACT_EVENT_VERSION}`
    );
    this.name = "UnsupportedEventVersionError";
  }
}

export class EventDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventDecodeError";
  }
}

function convert(kind: string, value: unknown, path: string): unknown {
  const opt = kind.match(/^option<(.+)>$/);
  if (opt) return value === null || value === undefined ? null : convert(opt[1], value, path);
  const vec = kind.match(/^vec<(.+)>$/);
  if (vec) {
    if (!Array.isArray(value)) throw new EventDecodeError(`${path}: expected vec`);
    return value.map((v, i) => convert(vec[1], v, `${path}[${i}]`));
  }
  switch (kind) {
    case "address":
    case "string":
    case "symbol":
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return Buffer.from(value).toString("utf-8");
      throw new EventDecodeError(`${path}: expected ${kind}`);
    case "bool":
      if (typeof value !== "boolean") throw new EventDecodeError(`${path}: expected bool`);
      return value;
    case "u32":
      if (typeof value !== "number") throw new EventDecodeError(`${path}: expected u32`);
      return value;
    case "u64":
    case "i64":
    case "u128":
    case "i128":
      if (typeof value !== "bigint" && typeof value !== "number") {
        throw new EventDecodeError(`${path}: expected ${kind}`);
      }
      return value.toString();
    case "bytes":
      if (!(value instanceof Uint8Array)) throw new EventDecodeError(`${path}: expected bytes`);
      return Buffer.from(value).toString("hex");
    default:
      return value;
  }
}

export function decodeTypedPayload(schema: GeneratedEventSchema, data: xdr.ScVal): Record<string, unknown> {
  const native = scValToNative(data) as Record<string, unknown>;
  if (native === null || typeof native !== "object" || Array.isArray(native)) {
    throw new EventDecodeError(`${schema.event}: expected struct payload`);
  }
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (!(field.name in native)) throw new EventDecodeError(`${schema.event}.${field.name}: missing`);
    out[field.name] = convert(field.kind, native[field.name], `${schema.event}.${field.name}`);
  }
  return out;
}

export function decodeGlobeWalletEvent(topics: xdr.ScVal[], data: xdr.ScVal): DecodedContractEvent {
  if (topics.length !== 2) {
    throw new EventDecodeError(`expected (name, version) topics, got ${topics.length} topic(s)`);
  }
  const name = scValToNative(topics[0]);
  const version = scValToNative(topics[1]);
  if (typeof name !== "string" || typeof version !== "number") {
    throw new EventDecodeError("topics must be (Symbol, u32)");
  }
  if (version !== CONTRACT_EVENT_VERSION) throw new UnsupportedEventVersionError(name, version);
  const schema = GENERATED_EVENT_SCHEMAS[name];
  if (!schema) return { name, version, typed: false, payload: scValToNative(data) };
  return { name, version, typed: true, payload: decodeTypedPayload(schema, data) };
}
