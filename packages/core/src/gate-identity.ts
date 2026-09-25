// SPDX-License-Identifier: Apache-2.0

// Gate identity decisions (gate-v1, E02/STORY-008), replay side only.
//
// A gate satisfied under an out-of-band identity roster recorded the decision in its
// extensions: the actor that satisfied it and the digest of the roster in force. The
// roster reader, the permission check and the verbs that wrote gates are retired with the
// rest of the authority family (TCRN-CROSS-STORY-467 R2). What stays is the check replay
// needs: an entry already on a chain must be well formed, and it never re-reads a roster,
// because a chain whose readability depended on an external file still being present
// would brick on ordinary key rotation or a restore onto a fresh machine.

import { assertProtocolId, compareCanonicalText } from "../../protocol/src/index.js";

export const GATE_IDENTITY_REASON_CODES = Object.freeze([
  "GATE_IDENTITY_AUTHORITY_MALFORMED",
] as const);

export type GateIdentityReasonCode = typeof GATE_IDENTITY_REASON_CODES[number];

export class GateIdentityError extends Error {
  readonly reasonCode: GateIdentityReasonCode;
  constructor(reasonCode: GateIdentityReasonCode, message: string) {
    super(message);
    this.name = "GateIdentityError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: GateIdentityReasonCode, message: string): never {
  throw new GateIdentityError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", label);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (actual.length !== wanted.length || wanted.some((field, index) => field !== actual[index])) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", label);
  }
}

// The decision a satisfied gate carries: who satisfied it and which roster was in force.
export interface GateIdentityDecision {
  readonly actorId: string;
  readonly authorityFileSha256: string;
}

export function validateGateIdentityDecision(value: unknown): GateIdentityDecision {
  const decision = record(value, "gate identity decision");
  exact(decision, ["actorId", "authorityFileSha256"], "gate identity decision");
  try {
    assertProtocolId(decision.actorId);
  } catch {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "decision actorId");
  }
  if (typeof decision.authorityFileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(decision.authorityFileSha256)) {
    fail("GATE_IDENTITY_AUTHORITY_MALFORMED", "decision authorityFileSha256");
  }
  return Object.freeze({
    actorId: decision.actorId as string,
    authorityFileSha256: decision.authorityFileSha256,
  });
}
