// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `tabeli` store type — a `.tbl` file: engine, data and manual in one
 * executable, driven by its own CLI.
 *
 * What this contributes at compile time is the translation from an abstract
 * store to concrete commands: the agent reads `<its apx> cards a card='…'
 * status=<raw|questioning|ready>`, with its own field names and its own enum
 * values already in the line. It never has to turn a generic example into its
 * own case, which is where a hand-written rule usually goes wrong.
 *
 * The one thing this backing cannot do is nesting: a `.tbl` record is flat
 * `key=value`, so a slot holding another shape or a list of them has no
 * representation. `rejects` says so at compile time rather than letting it fail
 * silently at the first write.
 */
import type { StoreDecl, StoreType } from '../types.js';
import type { ApSlot } from '../../apdoc/types.js';

/** A field placeholder written with this slot's real type, not a generic one. */
function hint(slot: ApSlot): string {
  const t = slot.type;
  switch (t.kind) {
    case 'enum':
      return `<${t.values.join('|')}>`;
    case 'number':
      if (t.min !== undefined && t.max !== undefined) return `<${t.min}–${t.max}>`;
      if (t.min !== undefined) return `<≥${t.min}>`;
      if (t.max !== undefined) return `<≤${t.max}>`;
      return '<n>';
    case 'text':
      return "'…'";
    default:
      return '<…>';
  }
}

/** The first enum slot, if any — the natural axis for a work-queue example. */
function statusSlot(store: StoreDecl): { slot: ApSlot; values: string[] } | null {
  for (const slot of store.slots) {
    if (slot.type.kind === 'enum' && slot.type.values.length >= 2) {
      return { slot, values: slot.type.values };
    }
  }
  return null;
}

const tabeliStore: StoreType = {
  type: 'store',
  name: 'tabeli',

  location(store) {
    return store.lasts === 'project'
      ? `stores/${store.agent}/${store.name}.tbl`
      : `.agent-pack/apx/${store.agent}.state/${store.name}.tbl`;
  },

  rejects(slot) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(slot.name)) {
      return `slot "${slot.name}": a tabeli field name uses letters, digits and _ only — write ${slot.name.replace(/[^A-Za-z0-9_]/g, '_')}`;
    }
    const t = slot.type;
    if (t.kind === 'shape') {
      return `slot "${slot.name}" holds another shape (<${t.ref.target}>), and a tabeli record is flat key=value — ` +
        `give the nested shape its own STORE and point at it by key`;
    }
    if (t.kind === 'list') {
      return `slot "${slot.name}" holds a list of <${t.ref.target}>, and a tabeli record is flat key=value — ` +
        `give the listed shape its own STORE, with a slot naming the record it belongs to`;
    }
    return null;
  },

  usage(store, command) {
    const fields = store.slots.map(s => `${s.name}=${hint(s)}`).join(' ');
    const lines: string[] = [];

    lines.push(`${command}                       run it bare for its own manual`);
    lines.push(`${command} a ${fields}`);

    const st = statusSlot(store);
    if (st) {
      const [first, second] = st.values;
      lines.push(`${command} q ${st.slot.name}=${first}`);
      lines.push(`${command} q ${st.slot.name}=${first} count            how many are left, for almost no tokens`);
      lines.push(`${command} next ${st.slot.name}=${first} set ${st.slot.name}=${second}   atomic take — two agents never get the same record`);
      lines.push(`${command} s <id> ${st.slot.name}=${second} if ${st.slot.name}=${first}   'if' rejects a stale belief instead of overwriting it`);
    } else {
      lines.push(`${command} q`);
      lines.push(`${command} q count`);
      lines.push(`${command} s <id> <field>=<value>`);
    }

    if (store.key) {
      lines.push(`${store.key} identifies a record — re-adding the same ${store.key} updates it, never duplicates`);
    }
    return lines;
  },
};

export default tabeliStore;
