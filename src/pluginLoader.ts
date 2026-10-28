// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The compiler's side of plugins (src/plugins.ts): read a plugin's folder,
 * refuse what is wrong with it before any agent compiles, then install it —
 * one row in each table the core already reads a block kind from. Nothing
 * else in the core knows a plugin exists.
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { parseBlocks, type Block, type Line } from './parseBlocks.js';
import { exportedBlockBodies } from './services/text.js';
import { parseTemplate } from './shapeCompiler.js';
import { parseTypeSpec } from './shapeSchema.js';
import { KEYWORDS, addPluginLineKeywords } from './lexer.js';
import { BLOCK_TYPES, PLUGIN_KEY, OPERATION_KEY } from './blockTypes.js';
import { BLOCK_CONTRACTS } from './blockContracts.js';
import { registerLineOwner, pluginManifestErrors } from './lint.js';
import { registerIngestKind } from './ingest.js';
import { STRATEGIES, defaults } from './definition.js';
import { KIND_STRATEGIES, installPluginKind } from './apdoc/blocks.js';
import { namesOf, lineKeyOf, pluginOf, registerPlugin, templateSlots, type PluginSpec, type PluginTemplate } from './plugins.js';

export const PLUGIN_MANIFEST = 'plugin.ap';
export const PLUGIN_SERVICE = 'service.mjs';

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Load each plugin folder of the config, in order, and install it — the first error stops the build. */
export async function loadPlugins(dirs: readonly string[]): Promise<PluginSpec[]> {
  const loaded: PluginSpec[] = [];
  for (const dir of dirs) {
    const spec = await readPlugin(dir);
    installPlugin(spec);
    loaded.push(spec);
  }
  return loaded;
}

/** A plugin folder as its spec — or an Error naming the file, each line wrong and the fix. */
export async function readPlugin(dir: string): Promise<PluginSpec> {
  const manifest = join(dir, PLUGIN_MANIFEST);
  if (!existsSync(manifest)) throw new Error(`plugin ${dir}: no ${PLUGIN_MANIFEST} — a plugin folder holds its manifest and its ${PLUGIN_SERVICE}`);
  const source = readFileSync(manifest, 'utf-8');
  const fail = (line: number, message: string): never => { throw new Error(`${manifest}:${line}  ${message}`); };

  // Its shape is the language's: the PLUGIN and OPERATION contracts (blockContracts.ts), as every block is checked.
  const blocks = parseBlocks(source).blocks;
  const heads = blocks.filter(b => b.key === PLUGIN_KEY);
  if (heads.length !== 1) fail(1, `a manifest holds one \`${PLUGIN_KEY} <name>:\` block — found ${heads.length}`);
  const shapeErrors = pluginManifestErrors(manifest, blocks);
  if (shapeErrors.length > 0) throw new Error(shapeErrors.map(e => `${e.file}:${e.line}  ${e.message}`).join('\n'));

  const head = heads[0];
  const name = namedAs(head, fail);
  const templates = manifestTemplates(source, head, fail);
  const lineOf = (b: Block, key: string) => b.children.find((c): c is Line => c.type === 'line' && c.keyword === key);
  /** The record template an AS line names — one of the manifest's, with SLOTS. */
  const recordOf = (as: Line, of: string): string => {
    const t = templates[as.rest.trim()];
    if (!t) return fail(as.line, `${of}: AS \`${as.rest.trim()}\` is no template of this manifest — declare it: EXPORT TEMPLATE ${as.rest.trim()}:`);
    if ('scalar' in t) return fail(as.line, `${of}: AS \`${as.rest.trim()}\` is a scalar template — it takes a record, with SLOTS`);
    return as.rest.trim();
  };

  const operations = head.children.flatMap(c => (c.type === 'block' && c.key === OPERATION_KEY ? [c] : [])).map(op => {
    const opName = namedAs(op, fail);
    const as = lineOf(op, 'AS');
    return { op: opName, about: lineOf(op, 'ABOUT')!.rest.trim(), input: as ? recordOf(as, `${OPERATION_KEY} ${opName}`) : null };
  });
  const twice = operations.find((o, i) => operations.findIndex(p => p.op === o.op) !== i);
  if (twice) fail(head.startLine, `${OPERATION_KEY} ${twice.op} is declared twice`);

  const block = recordOf(lineOf(head, 'AS')!, `${PLUGIN_KEY} ${name}`);
  const spec: PluginSpec = { name, about: lineOf(head, 'ABOUT')!.rest.trim(), ...namesOf(name), block, operations, templates, service: resolve(dir, PLUGIN_SERVICE) };
  // A slot of its block is a line of its own: never a word the language already has.
  for (const slot of templateSlots(spec, block)) {
    const key = lineKeyOf(slot.name);
    if (KEYWORDS.includes(key) || BLOCK_TYPES[key]) fail(head.startLine, `TEMPLATE ${block}: slot ${slot.name} would be the line \`${key}\`, a word of the language — name the slot otherwise`);
  }
  await checkService(spec, fail);
  return spec;
}

/** A PLUGIN's or an OPERATION's name: lowercase words joined by hyphens — it is written in commands. */
function namedAs(b: Block, fail: (line: number, message: string) => never): string {
  const name = b.name ?? '';
  return NAME_RE.test(name) ? name : fail(b.startLine, `${b.key} \`${name}\`: a name is lowercase words joined by hyphens — it is written in every command`);
}

/** The templates a manifest declares — each a record or a scalar, every template a slot names among them. */
function manifestTemplates(source: string, head: Block, fail: (line: number, message: string) => never): Record<string, PluginTemplate> {
  const templates: Record<string, PluginTemplate> = {};
  for (const t of exportedBlockBodies(source).filter(b => b.key === 'TEMPLATE')) {
    // The template as a file holds it — its header first: a scalar's type is the line under it.
    const parsed = parseTemplate(`TEMPLATE ${t.name}:\n${t.body.split('\n').map(l => `    ${l}`).join('\n')}`);
    if (!parsed) fail(head.startLine, `TEMPLATE ${t.name}: neither SLOTS nor a type — a plugin's template is a record or a scalar`);
    templates[t.name] = parsed!.scalar
      ? { scalar: parsed!.scalar.rawType }
      : { slots: parsed!.slots.map(sl => ({ name: sl.name, optional: sl.optional, rawType: sl.rawType })) };
  }
  for (const [name, t] of Object.entries(templates)) {
    for (const slot of 'slots' in t ? t.slots : []) {
      const type = parseTypeSpec(slot.rawType);
      if ((type.kind === 'shape' || type.kind === 'list') && !templates[type.ref]) fail(head.startLine, `TEMPLATE ${name}: slot ${slot.name} names \`${type.ref}\`, no template of this manifest`);
    }
  }
  return templates;
}

/** The service holds one function per operation, and none that no operation names. */
async function checkService(spec: PluginSpec, fail: (line: number, message: string) => never): Promise<void> {
  if (spec.operations.length === 0) return;
  if (!existsSync(spec.service)) fail(1, `no ${PLUGIN_SERVICE} beside the manifest — it exports one function per ${OPERATION_KEY}: ${spec.operations.map(o => o.op).join(', ')}`);
  const mod = await import(pathToFileURL(spec.service).href) as Record<string, unknown>;
  const missing = spec.operations.filter(o => typeof mod[o.op] !== 'function').map(o => o.op);
  if (missing.length > 0) fail(1, `${spec.service} exports no function for ${OPERATION_KEY} ${missing.join(', ')} — export function ${missing[0]}({ block, input, state, out })`);
  const extra = Object.keys(mod).filter(k => typeof mod[k] === 'function' && !spec.operations.some(o => o.op === k));
  if (extra.length > 0) fail(1, `${spec.service} exports ${extra.join(', ')}, which no ${OPERATION_KEY} declares — declare it in the manifest, or drop it`);
}

/**
 * Install a plugin: its block keyword and contract, its lines, its library
 * folder, its kind in the document. A name, keyword or id prefix some kind
 * already has is refused — a plugin never shadows the core or another plugin.
 */
export function installPlugin(spec: PluginSpec): void {
  const known = pluginOf(spec.name);
  if (known && known.service === spec.service) return;
  const taken = known ? `the plugin at ${known.service}`
    : BLOCK_TYPES[spec.key] ? `the block ${spec.key} of the language`
      : KIND_STRATEGIES.find(s => s.kind === spec.name || s.prefix === spec.prefix || s.folder === spec.folder)?.kind ?? null;
  if (taken) throw new Error(`plugin ${spec.name}: its name, prefix (${spec.prefix}) or folder (${spec.folder}) is taken by ${taken} — rename the plugin`);

  const slots = templateSlots(spec, spec.block);
  const keys = slots.map(s => lineKeyOf(s.name));
  // A LIST slot is a line written again and again — required when its range asks for at least one.
  const required = slots.filter(s => (s.spec.kind === 'list' ? (s.spec.min ?? 0) > 0 : !s.optional)).map(s => lineKeyOf(s.name));
  const once = slots.filter(s => s.spec.kind !== 'list').map(s => lineKeyOf(s.name));

  registerPlugin(spec);
  installPluginKind(spec);
  addPluginLineKeywords(keys);
  BLOCK_TYPES[spec.key] = { key: spec.key };
  BLOCK_CONTRACTS[spec.key] = { allows: ['ABOUT', ...keys], requiresAll: ['ABOUT', ...required], unique: ['ABOUT', ...once] };
  for (const key of keys) registerLineOwner(key, spec.key);
  registerIngestKind(spec.name, spec.folder, spec.key);
  STRATEGIES.push({ ...defaults(spec.name), sectionTitle: spec.folder });
}
