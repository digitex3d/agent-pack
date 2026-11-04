/**
 * Plugins (src/plugins.ts) — a block and the apx commands that serve it, added
 * without a change to the core. Driven the way a project uses one: a plugin
 * folder in the config, the real `bundle all`, the agent's apx run with a
 * session id.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = resolve(fileURLToPath(import.meta.url), '../../dist/index.js');
const root = mkdtempSync(join(tmpdir(), 'ap-plugins-'));
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Array.isArray(lines) ? `${lines.join('\n')}\n` : lines); return file; };
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };

// The example the package ships (templates/examples/plugin-example) — the test runs it as a project would.
const EXAMPLE = resolve(fileURLToPath(import.meta.url), '../../templates/examples/plugin-example');
const example = path => readFileSync(join(EXAMPLE, path), 'utf-8');
const MANIFEST = example('plugins/checklist/plugin.ap').replace(/\n$/, '').split('\n');
const SERVICE = example('plugins/checklist/service.mjs');
const EXAMPLE_AGENT = example('agents/standalone/releaser.ap');
/** The 1-based line of the manifest that holds `text`. */
const manifestLine = text => MANIFEST.findIndex(l => l.includes(text)) + 1;
const AGENT = (checklist = ['        ITEM   the tests pass', '        ITEM   the changelog has an entry']) => [
  'IMPORT before-deploy FROM @main.checklists', '',
  'EXPORT AGENT releaser AS release-engineer:', '    ABOUT    ships a release', '    MANDATE  deliver a release nothing is missing from', '',
  '    CHECKLIST before-release:', '        ABOUT  what a release needs before it goes out', ...checklist, '',
  'ROLE release-engineer:', '    ABOUT   a careful releaser', '    ALWAYS  check before you ship', '',
];

const project = (name, { manifest = MANIFEST, service = SERVICE, agent = EXAMPLE_AGENT } = {}) => {
  const proj = join(root, name);
  write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", "  plugins: ['plugins/checklist'],", '};']);
  write(join(proj, 'plugins', 'checklist', 'plugin.ap'), manifest);
  write(join(proj, 'plugins', 'checklist', 'service.mjs'), service);
  write(join(proj, 'library', 'checklists', 'before-deploy.ap'), example('library/checklists/before-deploy.ap'));
  write(join(proj, 'agents', 'standalone', 'releaser.ap'), agent);
  return proj;
};
const bundle = proj => {
  const r = spawnSync(process.execPath, [CLI, 'bundle', 'all'], { cwd: proj, encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

try {
  // --- the example, as it ships: a plugin's block compiles into its chapter, with the commands that serve it ---
  const proj = project('ok');
  const built = bundle(proj);
  assert.equal(built.code, 0, built.out);
  const md = readFileSync(join(proj, '.claude', 'agents', 'releaser.md'), 'utf-8');
  const apx = (args, session = 's-1') => {
    const r = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'releaser.apx'), ...args], { cwd: proj, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: session } });
    return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
  };
  const listed = apx(['checklist']);
  assert.equal(listed.code, 0, listed.out);
  const ID = listed.out.match(/^(che-[0-9a-f]{8}) {2}before-release/m)?.[1];
  const DEPLOY = listed.out.match(/^(che-[0-9a-f]{8}) {2}before-deploy/m)?.[1];
  assert.ok(ID && DEPLOY, `both checklists, the inline one and the imported one:\n${listed.out}`);
  has(md, 'Checklists', 'a list of checks an agent goes through before it delivers',
    '- ITEM: the tests pass', '- ITEM: the changelog has an entry', 'Its commands:',
    `- \`node .agent-pack/apx/releaser.apx checklist status ${ID}\` — every item, ticked or not`,
    `- \`node .agent-pack/apx/releaser.apx checklist tick ${ID} item=<check>\` — mark one item done`,
    '- ITEM: the backup is fresh');
  has(apx(['help']).out, `checklist tick <che-id> item=<check>`, 'mark one item done');

  // --- the apx checks the call against the manifest, then the plugin does the work ---
  let r = apx(['checklist', 'status', ID]);
  assert.equal(r.code, 1, 'items still open: exit 1');
  has(r.out, '   the tests pass', '   the changelog has an entry');
  assert.equal(apx(['checklist', 'tick', ID, 'item=the tests pass']).code, 0);
  r = apx(['checklist', 'status', ID]);
  has(r.out, 'x  the tests pass', '   the changelog has an entry');
  r = apx(['checklist', 'tick', ID, 'item=tests ok']);
  assert.equal(r.code, 1, r.out);
  has(r.out, '`tests ok` is no item of before-release');
  r = apx(['checklist', 'tick', ID, 'item=a check far too long to be one of the eight words allowed']);
  assert.equal(r.code, 2, 'the input breaks its template before the plugin runs');
  has(r.out, 'item: expected ≤8 words', `checklist tick ${ID} item=<check>`);
  has(apx(['checklist', 'tick', ID, 'colour=red']).out, 'colour: unknown field');
  has(apx(['checklist', 'tick', ID]).out, 'item: required field missing');
  has(apx(['checklist', 'status', ID, 'extra']).out, 'checklist status takes nothing after the id');
  has(apx(['checklist', 'tock', ID]).out, "'tock' is no operation of checklist");
  has(apx(['checklist', 'tick', 'che-00000000', 'item=x']).out, 'no checklist `che-00000000` in this agent');

  // --- the state is a block's, in a session ---
  has(apx(['checklist', 'status', DEPLOY]).out, '   the backup is fresh');
  has(apx(['checklist', 'status', ID], 's-2').out, '   the tests pass');
  const noSession = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'releaser.apx'), 'checklist', 'status', ID], { cwd: proj, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' } });
  assert.equal(noSession.status, 1);
  has(noSession.stdout, 'the state of checklist needs the harness session id');
  console.log('plugins: block, commands and state passed.');

  // --- a block breaking its template fails the build, where it is written ---
  r = bundle(project('no-item', { agent: AGENT([]) }));
  assert.notEqual(r.code, 0);
  has(r.out, 'releaser.ap:7  CHECKLIST before-release: ITEM: missing — the block needs this line');
  r = bundle(project('long-item', { agent: AGENT(['        ITEM   one check far too long to be one of the eight words']) }));
  assert.notEqual(r.code, 0);
  has(r.out, 'releaser.ap:7  CHECKLIST before-release: ITEM line 1: expected ≤8 words, got 12');
  r = bundle(project('stray-line', { agent: [...AGENT().slice(0, 9), '        ITEM   the tests pass', '    ITEM   outside', ...AGENT().slice(10)] }));
  assert.notEqual(r.code, 0);
  has(r.out, 'releaser.ap:11  ITEM is a line of a CHECKLIST block — found inside AGENT');

  // --- a manifest and its service agree, or nothing compiles ---
  r = bundle(project('no-function', { service: 'export function status() { return 0; }\n' }));
  assert.notEqual(r.code, 0);
  has(r.out, 'exports no function for OPERATION tick');
  r = bundle(project('extra-function', { service: `${SERVICE}\nexport function reset() { return 0; }\n` }));
  assert.notEqual(r.code, 0);
  has(r.out, 'exports reset, which no OPERATION declares');
  r = bundle(project('no-template', { manifest: MANIFEST.map(l => l.replace('AS     tick', 'AS     tock')) }));
  assert.notEqual(r.code, 0);
  has(r.out, 'AS `tock` is no template of this manifest');
  r = bundle(project('taken', { manifest: MANIFEST.map(l => l.replace('PLUGIN checklist:', 'PLUGIN domain:')) }));
  assert.notEqual(r.code, 0);
  has(r.out, 'plugin domain: its name');
  // The manifest's shape is checked by the language's own contracts — every line wrong, at once.
  r = bundle(project('shape', { manifest: MANIFEST.filter(l => !/^ {4}ABOUT/.test(l)).map(l => l.replace('        ABOUT  mark one item done', '        EACH   item')) }));
  assert.notEqual(r.code, 0);
  assert.ok(!r.out.includes('inside PLUGIN'), `an OPERATION's line is its own contract's, said once:\n${r.out}`);
  // One line fewer above the tick's ABOUT: the PLUGIN's own ABOUT is gone.
  has(r.out, `plugin.ap:${manifestLine('PLUGIN checklist:')}  PLUGIN block requires at least one ABOUT`,
    `plugin.ap:${manifestLine('ABOUT  mark one item done') - 1}  EACH is not allowed inside OPERATION (expected one of: ABOUT, AS)`, 'OPERATION block requires at least one ABOUT');
  r = bundle(project('op-name', { manifest: MANIFEST.map(l => l.replace('OPERATION tick:', 'OPERATION Tick:')) }));
  assert.notEqual(r.code, 0);
  has(r.out, 'OPERATION `Tick`: a name is lowercase words joined by hyphens');
  console.log('plugins: manifest errors passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
