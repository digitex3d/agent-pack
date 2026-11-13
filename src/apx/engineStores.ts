// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The engine's own tables, declared as stores: the session variables, the
 * checks a session's agents ran, the pieces they had carried out and the
 * registry of background work. Each is a StoreSpec written here instead of
 * in a `STORE` block — the same slots, the same checks on a write, the same
 * driver contract — resolved by the store API into a session's folder of the
 * state directory (src/apx/stores.ts). A field left empty is left out of the
 * record and read back as ''.
 */
import type { ApSlot, ApSlotType } from '../apdoc/types.js';
import { DEFAULT_DRIVER } from '../storeDrivers/types.js';
import { resolveStore, type OpenStore, type StoreSpec } from './stores.js';

/** The driver every engine table is kept by. */
export const ENGINE_DRIVER = DEFAULT_DRIVER;

const text = (): ApSlotType => ({ kind: 'text' });
const number = (): ApSlotType => ({ kind: 'number' });
const oneOf = (values: readonly string[]): ApSlotType => ({ kind: 'enum', values: [...values] });

/** One slot of an engine table: a name, a type, and whether a record may leave it out. */
function slot(name: string, type: ApSlotType, optional = false): ApSlot {
  return { name, optional, type, rules: [], chars: 0 };
}

function spec(name: string, about: string, slots: ApSlot[], storeKey: string | null): StoreSpec {
  return { name, about, slots, storeKey, id: `engine.${name}`, storeDriver: ENGINE_DRIVER, lasts: 'session' };
}

/** The variables of one scope — SESSION (`session`) or an agent's private ones (`private/<agent>`); a record per name. */
export const varsStore = (name: string): StoreSpec => spec(name, 'the variables of this session, one record per name', [
  slot('name', text()), slot('value', text(), true), slot('type', text(), true), slot('by', text()),
], 'name');

/** One `apx check` per record: the condition, who ran it, the round, the judge's answer. */
export const checksStore = spec('checks', 'every checked condition the session\'s agents ran', [
  slot('agent', text()), slot('cnd', text()), slot('level', number()), slot('round', number()),
  slot('fingerprint', text(), true), slot('model', text(), true), slot('p', text(), true),
  slot('threshold', number()), slot('outcome', oneOf(['open', 'closed'])), slot('at', text()),
], null);

/** One piece a delegate answered or a program ran, per record. */
export const executorsStore = spec('executors', 'every delegation answered and program run in the session', [
  slot('agent', text()), slot('exe', text()), slot('executor', number()), slot('who', text()),
  slot('fingerprint', text(), true), slot('outcome', oneOf(['answered', 'ran', 'refused', 'timeout', 'broken'])),
  slot('holds', oneOf(['true', 'false']), true), slot('at', text()),
], null);

/** The registry of background work: every piece a flow started, by its id, with its state (src/apx/delegations.ts). */
export const delegationsStore = (fields: readonly string[], states: readonly string[]): StoreSpec => spec('delegations',
  'the pieces of work this session handed out, and where each one stands',
  fields.map(field => field === 'state' ? slot('state', oneOf(states)) : slot(field, text(), field !== 'dlg')), 'dlg');

/** An engine table of one session, resolved under the project root. */
export function engineStore(root: string, sessionId: string, agent: string, store: StoreSpec): OpenStore {
  return resolveStore(store, root, agent, { kind: 'session', id: sessionId });
}
