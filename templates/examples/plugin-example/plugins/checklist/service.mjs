// The checklist plugin's service: one function per OPERATION of plugin.ap,
// with the same name. The apx calls one only after checking the call against
// the manifest — the operation exists, the id is one of the agent's
// checklists, the input fits the operation's template — so each function
// does only its own work. It receives:
//
//   block  the checklist, as written: { id, name, about, item: [...] }
//   input  what follows the id, as a record of the operation's template
//   state  this checklist's memory in this session: get(fallback), set(value)
//   out    prints a line for the agent
//
// It returns an exit code, or { refuse: why } — a refusal the agent can act on.

/** `status <che-id>` — every item, ticked or not; exit 1 while one is open. */
export function status({ block, state, out }) {
  const ticked = state.get([]);
  for (const item of block.item) out(`${ticked.includes(item) ? 'x' : ' '}  ${item}`);
  return ticked.length === block.item.length ? 0 : 1;
}

/** `tick <che-id> item=<check>` — mark one item of the checklist done. */
export function tick({ block, input, state }) {
  if (!block.item.includes(input.item)) {
    return { refuse: `\`${input.item}\` is no item of ${block.name} — its items: ${block.item.join(', ')}` };
  }
  state.set([...new Set([...state.get([]), input.item])]);
  return 0;
}
