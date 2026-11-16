// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The usage block a compiled agent reads for one store: one line per
 * operation, written with the store's real field names and the command that
 * serves it (the agent's apx — a store is never touched directly), so the
 * agent never has to turn a generic example into its own case.
 *
 * The verbs are the store API's, the same for every driver; a line for an
 * operation the driver lacks is never written.
 */
import type { ApSlot } from '../apdoc/types.js';
import type { StoreDecl, StoreDriver } from './types.js';

/** A field placeholder written with this slot's real type, not a generic one. */
function hint(slot: ApSlot): string {
  const slotType = slot.type;
  switch (slotType.kind) {
    case 'enum':
      return `<${slotType.values.join('|')}>`;
    case 'number':
      if (slotType.min !== undefined && slotType.max !== undefined) return `<${slotType.min}..${slotType.max}>`;
      if (slotType.min !== undefined) return `<≥${slotType.min}>`;
      if (slotType.max !== undefined) return `<≤${slotType.max}>`;
      return '<n>';
    case 'text':
      return "'…'";
    default:
      return '<…>';
  }
}

/** The values an enum needs to make a queue example: the state a record is in, and the one it moves to. */
const QUEUE_VALUES = 2;

/** The first enum slot with two values at least — the natural axis for a work-queue example. */
function statusSlot(store: StoreDecl): { name: string; values: string[] } | null {
  for (const slot of store.slots) {
    if (slot.type.kind === 'enum' && slot.type.values.length >= QUEUE_VALUES) return { name: slot.name, values: slot.type.values };
  }
  return null;
}

/** The usage lines of a store, its operations as `command(op)` writes them. */
export function storeUsage(store: StoreDecl, driver: StoreDriver, command: (op: string) => string): string[] {
  const can = new Set(driver.capabilities);
  const key = `<${store.key ?? 'id'}>`;
  const fields = store.slots.map(slot => `${slot.name}=${hint(slot)}`).join(' ');
  const lines = [`${command('put')} ${fields}`];

  const st = statusSlot(store);
  if (st) {
    const [first, second] = st.values;
    lines.push(`${command('find')} ${st.name}=${first}`);
    lines.push(`${command('find')} ${st.name}=${first} count            how many are left, for almost no tokens`);
    if (can.has('take')) lines.push(`${command('take')} ${st.name}=${first} set ${st.name}=${second}   atomic take — two agents never get the same record`);
    lines.push(can.has('guard')
      ? `${command('set')} ${key} ${st.name}=${second} if ${st.name}=${first}   'if' rejects a stale belief instead of overwriting it`
      : `${command('set')} ${key} ${st.name}=${second}`);
  } else {
    lines.push(`${command('find')}`, `${command('find')} count`, `${command('set')} ${key} <field>=<value>`);
    if (can.has('take')) lines.push(`${command('take')} <field>=<value> set <field>=<value>   atomic take — two agents never get the same record`);
  }
  lines.push(`${command('get')} ${key}`, `${command('remove')} ${key}`);
  if (can.has('since')) lines.push(`${command('mark')}   then later: ${command('since')} <mark>   only what changed since the mark`);
  lines.push('filters: <field>=<value>, != > < >= <=, ~ for "contains" — add limit=<n>, count or json to find');

  if (store.key) lines.push(`${store.key} identifies a record — putting the same ${store.key} again updates it, never duplicates`);
  return lines;
}
