// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Dimensions (D43): an answer implicit in a source file, worked out once by an
 * agent and kept by the apx, so the next agent reads it instead of reasoning
 * again. The compiler checks the block wherever it is written and renders its
 * catalog; the apx hashes files and serves, validates and drops the cache:
 * `.agent-pack/cache/<defhash>/<file>.json`, the defhash being the dimension's
 * content without its name. `bundle all` removes the folders no dimension
 * produces any more. Driven the way a harness drives it: the real `bundle all`,
 * the real `.apx`, lines out and an exit code back.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamSource } from './helpers/team.mjs';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { documentDefHashes, fingerprint } = await import('../dist/src/apx/dimensions.js');
const { globRegExp } = await import('../dist/src/services/glob.js');
const { lintFile } = await import('../dist/src/lint.js');

const CLI = resolve(fileURLToPath(import.meta.url), '../../dist/index.js');
const root = mkdtempSync(join(tmpdir(), 'ap-dimensions-'));
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Array.isArray(lines) ? `${lines.join('\n')}\n` : lines); return file; };
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const stderrOf = async run => { const prior = console.error; const seen = []; console.error = (...a) => seen.push(a.join(' ')); try { return { result: await run(), stderr: seen.join('\n') }; } finally { console.error = prior; } };

try {
  // --- globs: ** any folders (none included), * within one name, {a,b}, [abc] ---
  {
    const m = (glob, path) => globRegExp(glob).test(path);
    assert.ok(m('src/**/*.py', 'src/a.py') && m('src/**/*.py', 'src/x/y/a.py'));
    assert.ok(!m('src/**/*.py', 'src/a.pyc') && !m('src/*.py', 'src/x/a.py') && !m('src/**/*.py', 'lib/a.py'));
    assert.ok(m('**/*.{ts,js}', 'a/b.js') && m('**/*.{ts,js}', 'b.ts') && !m('**/*.{ts,js}', 'b.md'));
    assert.ok(m('src/[ab].py', 'src/a.py') && !m('src/[!ab].py', 'src/a.py') && m('./src/?.py', 'src/c.py'));
  }

  // --- the fingerprint reads a file as code: endings, trailing spaces, blank lines aside; indentation counts ---
  {
    const base = 'def f():\n    return 1\n';
    assert.equal(fingerprint('def f():  \r\n\n    return 1\n\n\n'), fingerprint(base));
    assert.notEqual(fingerprint('def f():\n  return 1\n'), fingerprint(base), 'indentation is Python');
    assert.notEqual(fingerprint('def f():\n    return 1  # one\n'), fingerprint(base), 'a comment counts');
  }

  // --- compile errors: the block's contract, wherever it is written ---
  const lib = join(root, 'errors-lib');
  mkdirSync(lib, { recursive: true });
  // The agent names the dimension of the source with @WITH — a dimension no @WITH names applies nowhere.
  const withLines = (lines, body) => { const name = [...lines, ...body].join('\n').match(/DIMENSION\s+([^\s:]+)/)?.[1]; return name ? [`    @WITH ${name}:`, '        DO  read it first'] : []; };
  const agentSource = (lines, extra = [], body = [], named = true) => [
      'EXPORT AGENT a AS a-role:', '    ABOUT    an agent', '    MANDATE  do the work', ...body, ...(named ? withLines(lines, body) : []), '',
      'ROLE a-role:', '    ABOUT   a worker', '    ALWAYS  do the work', '',
      'TEMPLATE steps:', '    ABOUT  the steps of a function', '    SLOTS:', '        name: TEXT "the function"', '        steps: TEXT "its steps"', '    BODY:', '        {name}: {steps}', '',
      'TEMPLATE prose:', '    ABOUT  a prose template', '    DO  write something', '',
      ...extra, ...lines, '',
    ].join('\n');
  const compile = (lines, extra = [], body = [], named = true) => {
    const file = join(root, 'a.ap');
    writeFileSync(file, agentSource(lines, extra, body, named));
    return bundleAgentObject({ agentName: 'a', agentFile: file, agentDir: root, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
  };
  const dimension = ({ name = 'pseudocode', about = '    ABOUT  what each function does', forLine = '    FOR    src/**/*.py', each = '    EACH   function', as = '    AS     steps', rest = [], exported = false } = {}) =>
    [`${exported ? 'EXPORT ' : ''}DIMENSION ${name}:`, about, forLine, each, as, ...rest].flat().filter(l => l !== null);
  {
    const ok = await compile(dimension({ rest: ['    MUST   write one step per decision', '    NEVER  invent a step'] }));
    assert.equal(ok.structure.byKind('dimension').length, 1, 'the baseline compiles');
    await compile(dimension({ exported: true }));   // EXPORT inside the agent's own file: its own
    for (const [missing, opts] of [['ABOUT', { about: null }], ['FOR', { forLine: null }], ['EACH', { each: null }], ['AS', { as: null }]]) {
      await assert.rejects(compile(dimension(opts)), new RegExp(`DIMENSION block requires at least one ${missing}`), `missing ${missing}`);
    }
    await assert.rejects(compile(dimension({ as: '    AS     nope' })), /unknown template `nope`/);
    await assert.rejects(compile(dimension({ as: '    AS     prose' })), /DIMENSION pseudocode: AS `prose` is a template without SLOTS/);
    await assert.rejects(compile(dimension({ as: '    AS!    steps' })), /DIMENSION pseudocode: AS takes no level/);
    await assert.rejects(compile(dimension({ rest: ['    TYPE   tabeli'] })), /TYPE is not allowed inside DIMENSION \(expected one of: ABOUT, FOR, EACH/);
    await assert.rejects(compile(dimension({ rest: ['    MEM    the steps'] })), /MEM is not allowed inside DIMENSION — a dimension's rules say how its value is produced/);
    await assert.rejects(compile(dimension({ rest: ['    FOR    lib/*.py'] })), /DIMENSION block has 2 occurrences of FOR/);
    // a dimension is reached by its id, after the verb `dimension`: its name may be a verb's, or a store's
    await compile(dimension({ name: 'get' }));
    await compile(dimension({ name: 'notes' }), ['STORE notes:', '    ABOUT  notes', '    TYPE   tabeli', '    SLOTS:', '        topic: TEXT "t"', '']);
    // EACH naming a template renders as a reference to it; any other text, verbatim
    const each = await compile(dimension({ each: '    EACH   steps' }));
    const eachDim = each.structure.byKind('dimension')[0];
    assert.equal(eachDim.eachRef?.kind, 'template');
    assert.match(each.body, /each: one `steps` \(tpl-[0-9a-f]{8}\)/);
    // a library file under dimensions/ is linted by its kind: one block, its contract
    const file = write(join(lib, 'dimensions', 'broken.ap'), ['EXPORT DIMENSION broken:', '    ABOUT  x', '    EACH   function', '    AS     steps']);
    assert.ok(lintFile(file, readFileSync(file, 'utf-8')).some(e => /DIMENSION block requires at least one FOR/.test(e.message)));

    // --- B2, strict: its body holds ABOUT, FOR, EACH, AS and rule lines — no action, no prose, no nested block, at any depth ---
    const notAllowed = word => new RegExp(`${word} is not allowed inside DIMENSION \\(expected one of: ABOUT, FOR, EACH`);
    const strict = [
      [['    DO     read the file'], notAllowed('DO')],
      [['    DELEGATE    someone'], notAllowed('DELEGATE')],
      [['    IF the file is big:', '        MUST split it'], notAllowed('IF')],
      // WHEN is no line of a dimension — as a line or as a block: when it is read is the reader's WITH
      [['    WHEN a function is long'], notAllowed('WHEN')],
      [['    WHEN a function is long:', '        MUST split it'], notAllowed('WHEN')],
      [['    WHEN! {{request}} is long:', '        MUST split it'], notAllowed('WHEN')],
      [['    ON-INVOKE:', '        MUST start over'], notAllowed('WHEN')],
      [['    UNTIL every function is read:', '        MUST read the next'], notAllowed('UNTIL')],
      [['    MUST   follow these:', '        DO  read the file'], notAllowed('DO')],
      [['    MUST   write one step', '    per decision'], /a line of prose \(`per decision`\) is not allowed inside DIMENSION/],
    ];
    for (const [rest, why] of strict) {
      await assert.rejects(compile(dimension({ rest })), why, `compile: ${rest[0]}`);
      const libFile = write(join(lib, 'dimensions', 'strict.ap'), dimension({ name: 'strict', exported: true, rest }));
      assert.ok(lintFile(libFile, readFileSync(libFile, 'utf-8')).some(e => why.test(e.message)), `library lint: ${rest[0]}`);
    }
    // a rule that opens a block holds its own text beneath it
    await compile(dimension({ rest: ['    MUST   follow these:', '        - one step per decision', '        - no invented step'] }));

    // --- N4: FOR globs are read from the project root ---
    for (const glob of ['/abs/**/*.py', '../other/*.py', 'src/../../x.py', '~/x.py']) {
      await assert.rejects(compile(dimension({ forLine: `    FOR    src/*.py, ${glob}` })), new RegExp(`FOR \`${glob.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\`: a glob is read from the project root — no absolute path, no \`\\.\\.\``), glob);
    }

    // --- N5: a keyword alone on its line says what it lacks ---
    await assert.rejects(compile(dimension({ forLine: '    FOR' })), /:\d+ {2}FOR needs at least one glob/);
    await assert.rejects(compile(dimension({ each: '    EACH' })), /EACH needs what to translate in a file/);
    await assert.rejects(compile(dimension({ as: '    AS' })), /AS needs the template it names/);
    const bare = write(join(lib, 'dimensions', 'bare.ap'), dimension({ name: 'bare', exported: true, forLine: '    FOR' }));
    const bareErrors = lintFile(bare, readFileSync(bare, 'utf-8')).map(e => e.message);
    assert.ok(bareErrors.includes('FOR needs at least one glob') && !bareErrors.some(m => /did you mean|line of prose/.test(m)), bareErrors.join('\n'));
    for (const name of ['strict', 'bare']) rmSync(join(lib, 'dimensions', `${name}.ap`));

    // --- a dimension is read where @WITH names it — like a policy or a skill with no perimeter; one no @WITH names applies nowhere ---
    {
      const named = await compile(dimension(), [], ['    WHEN about to change a function:', '        @WITH pseudocode:', '            DO  change it, knowing what it does first'], false);
      const dim = named.structure.byKind('dimension')[0];
      assert.ok(named.body.includes(`For the work below, use the dimension \`pseudocode\` (${dim.id}):\n        Do change it, knowing what it does first`), named.body);
      // the entry opens with where it applies, as a policy's does
      assert.ok(named.body.includes('## `pseudocode` — what each function does\nApplies only to the work nested under a line that names it.\nFiles: `src/**/*.py`'), named.body);
      assert.ok(!/read this dimension/.test(named.body), 'no trigger of its own');
      // !WITH is gone: no negation
      await assert.rejects(compile(dimension(), [], ['    @WITH pseudocode:', '        DO  read it first', '    !WITH pseudocode:', '        DO  guess'], false), /!WITH was removed/);
      // named nowhere: it applies nowhere — a warning, where a policy gets an error: the apx serves it all the same
      const nowhere = /a\.ap:\d+ {2}dimension `pseudocode` applies nowhere — name it with `@WITH pseudocode` above the lines that read it/;
      for (const [lines, body] of [[dimension(), []], [dimension({ exported: true }), []]]) {
        const { result, stderr } = await stderrOf(() => compile(lines, [], body, false));
        assert.match(stderr, nowhere);
        assert.equal(result.structure.byKind('dimension').length, 1, 'kept all the same');
      }
      assert.ok(!nowhere.test((await stderrOf(() => compile(dimension()))).stderr), 'named by @WITH: no warning');
      // @WITH on a name no import brings
      await assert.rejects(compile([], [], ['    @WITH nope:', '        DO  read it']), /`@WITH nope`: no imported skill, policy or dimension is called `nope`/);
      // AS shapes a skill's answer — a dimension's value has its own AS
      await assert.rejects(compile(dimension(), [], ['    @WITH pseudocode AS steps:', '        DO  read it'], false), /`AS steps` shapes the answer of one skill — this @WITH names the dimension `pseudocode`/);
      // a trigger takes no star
      await assert.rejects(compile([], [], ['    WHEN* a function is long:', '        DO  split it']), /`WHEN\*` is not allowed — a trigger takes no star: write WHEN, or WHEN! \(a judge decides the condition\)/);
    }

    // --- B1: FOR and EACH are a DIMENSION's lines; a DIMENSION stands at the file top or directly in an agent's body ---
    await assert.rejects(compile([], [], ['    FOR    src/*.py']), /FOR is a line of a DIMENSION block — found inside AGENT/);
    await assert.rejects(compile([], [], ['    EACH   function']), /EACH is a line of a DIMENSION block — found inside AGENT/);
    await assert.rejects(compile(['PROCEDURE p:', '    ABOUT  a procedure', '    DO     work', '    EACH   function']), /EACH is a line of a DIMENSION block — found inside PROCEDURE/);
    await assert.rejects(compile(['FOR    src/*.py']), /FOR is a line of a DIMENSION block — found inside the file top/);
    await assert.rejects(compile(['PROCEDURE p:', '    ABOUT  a procedure', '    DO     work', ...dimension().map(l => `    ${l}`)]),
      /a DIMENSION is declared at the file top or directly in an agent's body — found inside PROCEDURE/);
    await assert.rejects(compile(['ROLE other:', '    ABOUT  another', ...dimension().map(l => `    ${l}`)]), /found inside ROLE/);
    const inAgent = await compile([], [], dimension().map(l => `    ${l}`));
    assert.equal(inAgent.structure.byKind('dimension').length, 1, 'a DIMENSION directly in the agent body is the agent\'s');
    // its lines stand where they were written, in the agent's body
    {
      const source = agentSource([], [], dimension({ rest: ['    MUST   write one step per decision'] }).map(l => `    ${l}`)).split('\n');
      const inAgentRule = await compile([], [], dimension({ rest: ['    MUST   write one step per decision'] }).map(l => `    ${l}`));
      const dim = inAgentRule.structure.byKind('dimension')[0];
      assert.equal(dim.source?.line, source.indexOf('    DIMENSION pseudocode:') + 1, 'its header');
      const lines = inAgentRule.structure.lines().filter(l => l.block.kind === 'dimension').map(l => [l.primitive, l.line, l.col]);
      assert.deepEqual(lines, [['MUST', source.indexOf('        MUST   write one step per decision') + 1, 9]]);
    }
    await assert.rejects(compile([], [], dimension({ rest: ['    DO  read it'] }).map(l => `    ${l}`)), notAllowed('DO'), 'its contract holds in the agent body too');

    // --- lint and compile check a dimension in an agent's file alike — exported, plain, or in the agent body ---
    const lintAgent = (lines, body = []) => lintFile(join(root, 'a.ap'), agentSource(lines, [], body)).map(e => e.message);
    for (const [lines, body] of [[dimension({ forLine: null, exported: true }), []], [dimension({ forLine: null }), []], [[], dimension({ forLine: null }).map(l => `    ${l}`)]]) {
      const errors = lintAgent(lines, body);
      assert.equal(errors.filter(m => /DIMENSION block requires at least one FOR/.test(m)).length, 1, errors.join('\n'));
    }
    assert.ok(lintAgent(dimension({ rest: ['    IF big:', '        MUST split'], exported: true })).some(m => notAllowed('IF').test(m)));
    assert.ok(lintAgent(dimension({ forLine: '    FOR    ../x/*.py' })).some(m => /FOR `\.\.\/x\/\*\.py`: a glob is read from the project root/.test(m)));
  }

  // --- N8: a block opener the token contracts do not name still closes the blocks it is no deeper than ---
  {
    const team = join(root, 'teams', 'crew');
    const flows = join(team, 'crew.ap');
    const errors = lintFile(flows, [...teamSource('crew', ['builder'], ['ABOUT  a crew', '', 'FLOW ship:', '    STEP build:', '        BY builder', '        DO  build it']), '',
      'POLICY careful:', '    ABOUT   be careful', '    ALWAYS  test first', ''].join('\n')).map(e => e.message);
    assert.ok(!errors.some(m => /ALWAYS is not allowed inside (FLOW|STEP)/.test(m)), `the POLICY's lines are not the FLOW's:\n${errors.join('\n')}`);
  }

  // --- the defhash: the content without the names — a rename keeps it, an edit changes it ---
  {
    const hashOf = async (name, template, rule = 'write one step per decision', slot = 'its steps', { each = 'function', unit = 'a function' } = {}) => {
      const file = join(root, 'h.ap');
      writeFileSync(file, [
        'EXPORT AGENT h AS h-role:', '    ABOUT    h', '    MANDATE  m', `    @WITH    ${name}:`, '        DO  read it first', '',
        'ROLE h-role:', '    ABOUT   r', '    ALWAYS  work', '',
        `TEMPLATE ${template}:`, '    ABOUT  the steps', '    SLOTS:', '        name: TEXT "the function"', `        steps: TEXT "${slot}"`, '',
        'TEMPLATE unit:', '    ABOUT  what to translate', '    SLOTS:', `        what: TEXT "${unit}"`, '',
        'TEMPLATE fn:', '    ABOUT  what to translate', '    SLOTS:', `        what: TEXT "${unit}"`, '',
        `DIMENSION ${name}:`, '    ABOUT  what each function does', '    FOR    src/**/*.py', `    EACH   ${each}`, `    AS     ${template}`, `    MUST   ${rule}`, '',
      ].join('\n'));
      const c = await bundleAgentObject({ agentName: 'h', agentFile: file, agentDir: root, libraryRoot: lib, libraryRoots: [lib], bundleConfig: { runtime: false } });
      return documentDefHashes(c.structure)[0];
    };
    const base = await hashOf('pseudocode', 'steps');
    assert.match(base, /^[0-9a-f]{8}$/);
    assert.equal(await hashOf('pseudo', 'steps'), base, 'renaming the dimension keeps its cache');
    assert.equal(await hashOf('pseudocode', 'pseudo-steps'), base, 'renaming its template keeps its cache');
    assert.notEqual(await hashOf('pseudocode', 'steps', 'write one step per branch'), base, 'a rule edited: a new definition');
    assert.notEqual(await hashOf('pseudocode', 'steps', undefined, 'the steps, in order'), base, 'its template edited: a new definition');
    // N1: the template EACH names counts with its content, not its name
    const eachBase = await hashOf('pseudocode', 'steps', undefined, undefined, { each: 'unit' });
    assert.notEqual(eachBase, base, 'EACH naming a template is another definition');
    assert.equal(await hashOf('pseudocode', 'steps', undefined, undefined, { each: 'fn' }), eachBase, 'renaming the EACH template keeps the cache');
    assert.notEqual(await hashOf('pseudocode', 'steps', undefined, undefined, { each: 'unit', unit: 'a method' }), eachBase, 'the EACH template edited: a new definition');
  }

  // --- a project: the real bundle all, the real apx ---
  const proj = join(root, 'proj');
  write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", '};']);
  write(join(proj, 'library', 'templates', 'pseudo-steps.ap'), [
    'EXPORT TEMPLATE pseudo-steps:', '    ABOUT  the steps of one function', '    SLOTS:',
    '        name: TEXT "the function"', '        steps: TEXT "what it does, step by step"', '    BODY:', '        {name}: {steps}',
  ]);
  const dimFile = write(join(proj, 'library', 'dimensions', 'pseudocode.ap'), [
    'IMPORT pseudo-steps FROM @main.templates', '',
    'EXPORT DIMENSION pseudocode:', '    ABOUT  what each function does, step by step, in plain words',
    '    FOR    src/**/*.py', '    EACH   function', '    AS     pseudo-steps', '    MUST   write one step per decision the code takes',
  ]);
  const agentLines = (dim = 'pseudocode') => [
    `IMPORT ${dim} FROM @main.dimensions`, '',
    'EXPORT AGENT coder AS coder-role:', '    ABOUT    coder', '    MANDATE  understand the code',
    '    WHEN about to change a function:', `        @WITH ${dim}:`, '            DO  change it, knowing what it does first', '',
    'ROLE coder-role:', '    ABOUT   a reader of code', '    ALWAYS  read before you change', '',
  ];
  write(join(proj, 'agents', 'standalone', 'coder.ap'), agentLines());
  const a = write(join(proj, 'src', 'a.py'), 'def a():\n    return b()\n');
  const b = write(join(proj, 'src', 'b.py'), 'def b():\n    return 1\n');
  const c = write(join(proj, 'src', 'util', 'c.py'), 'def c():\n    return 2\n');
  write(join(proj, 'docs', 'x.md'), '# x\n');
  const bundle = () => {
    const r = spawnSync(process.execPath, [CLI, 'bundle', 'all'], { cwd: proj, encoding: 'utf-8' });
    assert.equal(r.status, 0, `bundle all failed:\n${r.stdout}${r.stderr}`);
    return `${r.stdout}${r.stderr}`;
  };
  bundle();
  const EXE = join(proj, '.agent-pack', 'apx', 'coder.apx');
  const CMD0 = 'node .agent-pack/apx/coder.apx';
  const apx = (args, input) => {
    const r = spawnSync(process.execPath, [EXE, ...args], { cwd: proj, encoding: 'utf-8', input });
    return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
  };
  // A dimension is reached by its id, like every block: `<apx> dimension <dim-id> <verb>`.
  const DIM = apx(['dimension']).out.match(/^(dim-[0-9a-f]{8}) {2}pseudocode/m)?.[1];
  assert.ok(DIM, apx(['dimension']).out);
  const CMD = op => `${CMD0} dimension ${op} ${DIM}`;
  const value = [{ name: 'a', steps: 'calls b, returns what it gives' }];
  const json = v => JSON.stringify(v);

  // --- the catalog: the compiled agent tells what each dimension answers and how to read and write it ---
  {
    const md = apx(['md']).out;
    has(md, '# Dimensions', '## `pseudocode` — what each function does, step by step, in plain words\nApplies only to the work nested under a line that names it.\nFiles: `src/**/*.py` — each: function — its value: a list of `pseudo-steps`',
      'Each dimension says what it holds and which files it covers; the lines it is for are the ones nested under a line that names it.', 'once read, whether you also need the code is your call',
      'When about to change a function:\n    For the work below, use the dimension `pseudocode` (dim-',
      `${CMD('read')} <file>`, `${CMD('write')} <file> [refs=<path>;<path>] - < value.json`, 'You must write one step per decision the code takes');
    has(apx(['scope']).out, 'dimensions:', 'dimension pseudocode', '— files: src/**/*.py');
    has(apx(['ls', 'kind=dimension']).out, '[only where @WITH names it]');
    has(apx(['help']).out, 'dimension read <dim-id> <file> [json]', 'dimension write <dim-id> <file> [refs=<path>;<path>] -|none', 'dimension find <dim-id> <text>');
    // the name is no way in any more: only the id, after `dimension`
    assert.equal(apx(['pseudocode', 'read', 'src/a.py']).code, 2, 'a dimension is not reached by its name');
    const wrong = apx(['dimension', 'read', 'dim-00000000', 'src/a.py']);
    assert.equal(wrong.code, 2);
    has(wrong.out, `no dimension \`dim-00000000\` in this agent — its dimensions: ${DIM} (pseudocode)`);
    const dims = apx(['dimension']);
    assert.equal(dims.code, 0);
    const compiled = await bundleAgentObject({
      agentName: 'coder', agentFile: join(proj, 'agents', 'standalone', 'coder.ap'), agentDir: join(proj, 'agents', 'standalone'),
      libraryRoot: join(proj, 'library'), libraryRoots: [join(proj, 'library')], libraries: { '@main': join(proj, 'library') }, bundleConfig: { runtime: false },
    });
    const [defhash] = documentDefHashes(compiled.structure);
    has(dims.out, `${DIM}  pseudocode  ${defhash}  — files: src/**/*.py — 0 entries`, `read: ${CMD('read')} <file>`);
    const claude = readFileSync(join(proj, '.claude', 'agents', 'coder.md'), 'utf-8');
    assert.ok(claude.includes('coder.apx'), 'the harness file points at the apx that serves the dimensions');
  }

  const cacheDir = () => readdirSync(join(proj, '.agent-pack', 'cache')).find(f => /^[0-9a-f]{8}$/.test(f));

  // --- read: never written → miss; write → hit, through the template's BODY ---
  {
    const miss = apx(['dimension', 'read', DIM, 'src/a.py']);
    assert.equal(miss.code, 1);
    has(miss.out, 'miss pseudocode src/a.py — never written', `${CMD('write')} src/a.py`);
    const w = apx(['dimension', 'write', DIM, 'src/a.py', '-'], json(value));
    assert.equal(w.code, 0, w.out);
    has(w.out, '# stored pseudocode src/a.py — .agent-pack/cache/', 'refs: (none)');
    const entry = JSON.parse(readFileSync(join(proj, '.agent-pack', 'cache', cacheDir(), 'src', 'a.py.json'), 'utf-8'));
    assert.deepEqual(Object.keys(entry), ['format', 'dimension', 'file', 'hash', 'refs', 'value', 'by', 'at']);
    assert.equal(entry.format, 1); assert.equal(entry.dimension, 'pseudocode'); assert.equal(entry.file, 'src/a.py'); assert.equal(entry.by, 'coder');
    const hit = apx(['dimension', 'read', DIM, 'src/a.py']);
    assert.equal(hit.code, 0);
    assert.match(hit.out, /^hit pseudocode src\/a\.py — by coder, \d{4}-\d{2}-\d{2}\na: calls b, returns what it gives$/);
    assert.deepEqual(JSON.parse(apx(['dimension', 'read', DIM, 'src/a.py', 'json']).out), value, 'json: the raw value');
    // a path from the project root or from elsewhere in it names the same file
    assert.equal(spawnSync(process.execPath, [EXE, 'dimension', 'read', DIM, 'a.py'], { cwd: join(proj, 'src'), encoding: 'utf-8' }).status, 0);
  }

  // --- the file edited: whitespace aside a hit, indentation or content a miss ---
  {
    write(a, 'def a():   \r\n\n    return b()\n\n');
    assert.equal(apx(['dimension', 'read', DIM, 'src/a.py']).code, 0, 'trailing spaces, CRLF, blank lines: still a hit');
    write(a, 'def a():\n  return b()\n');
    const indent = apx(['dimension', 'read', DIM, 'src/a.py']);
    assert.equal(indent.code, 1);
    has(indent.out, 'miss pseudocode src/a.py — changed: src/a.py');
    assert.ok(!indent.out.includes('calls b'), 'a miss never prints the old value');
    write(a, 'def a():\n    return b()\n');
    assert.equal(apx(['dimension', 'read', DIM, 'src/a.py']).code, 0, 'back as it was: a hit again');
    write(a, 'def a():\n    return b() + 1\n');
    has(apx(['dimension', 'read', DIM, 'src/a.py']).out, 'miss pseudocode src/a.py — changed: src/a.py');
    const why = apx(['dimension', 'why', DIM, 'src/a.py']);
    assert.equal(why.code, 0);
    assert.match(why.out, /^stale pseudocode src\/a\.py — changed: src\/a\.py/);
    assert.match(why.out, /file {2}src\/a\.py {2}kept [0-9a-f]{12} {2}now [0-9a-f]{12} {2}changed/);
  }

  // --- write refusals: outside FOR, a file that does not exist, a bad value, an answer still fresh ---
  {
    const outside = apx(['dimension', 'write', DIM, 'docs/x.md', '-'], json(value));
    assert.equal(outside.code, 2);
    has(outside.out, '`docs/x.md` is no file pseudocode covers — it covers: src/**/*.py');
    assert.equal(apx(['dimension', 'read', DIM, 'docs/x.md']).code, 2, 'reading outside FOR is a usage error too');
    assert.equal(apx(['dimension', 'write', DIM, '../elsewhere.py', '-'], json(value)).code, 2, 'outside the project');
    const absent = apx(['dimension', 'write', DIM, 'src/nope.py', '-'], json(value));
    assert.equal(absent.code, 1);
    has(absent.out, 'no file `src/nope.py` in the project');
    for (const [bad, why] of [['not json', 'the value is not a list of `pseudo-steps`: not valid JSON'], ['[]', 'expected ≥1 items'], [json([{ name: 'a' }]), 'pseudocode[0].steps: required field missing'],
      [json({ name: 'a', steps: 's' }), 'expected an array (list of <pseudo-steps>)'], [json([{ name: 'a', steps: 's', extra: 1 }]), 'pseudocode[0].extra: unknown field']]) {
      const r = apx(['dimension', 'write', DIM, 'src/a.py', '-'], bad);
      assert.equal(r.code, 2, `${bad}: ${r.out}`);
      has(r.out, why, 'nothing was written');
    }
    has(apx(['dimension', 'read', DIM, 'src/a.py']).out, 'miss pseudocode src/a.py — changed');   // a refused write leaves the stale entry as it was
    assert.equal(apx(['dimension', 'write', DIM, 'src/a.py', '-'], json(value)).code, 0, 'a stale entry is overwritten');
    const again = apx(['dimension', 'write', DIM, 'src/a.py', '-'], json(value));
    assert.equal(again.code, 4, 'another agent answered meanwhile');
    has(again.out, 'pseudocode src/a.py is already fresh — read it', 'nothing was written');
    const usage = apx(['dimension', 'write', DIM, 'src/a.py']);
    assert.equal(usage.code, 2);
    has(usage.out, 'pseudocode write takes the value on stdin with -, or none', `${CMD('write')} <file> [refs=<path>;<path>] -|none`);
    const refGone = apx(['dimension', 'write', DIM, 'src/b.py', 'refs=src/missing.py', '-'], json(value));
    assert.equal(refGone.code, 1);
    has(refGone.out, 'refs: `src/missing.py` is no file of the project');
    const verb = apx(['dimension', 'reed', DIM, 'src/a.py']);
    assert.equal(verb.code, 2);
    has(verb.out, "'reed' is no operation of a dimension", `${CMD0} dimension read|write|find|ls|why|clear|gc <dim-id>`);
  }

  // --- refs: declared ones and the project files the value names; each one's edit or loss stales the entry ---
  {
    const named = [{ name: 'b', steps: 'returns 1, used by src/util/c.py' }];
    const w = apx(['dimension', 'write', DIM, 'src/b.py', 'refs=src/a.py', '-'], json(named));
    assert.equal(w.code, 0, w.out);
    has(w.out, 'refs: src/a.py, src/util/c.py');
    assert.equal(apx(['dimension', 'read', DIM, 'src/b.py']).code, 0);
    write(c, 'def c():\n    return 3\n');
    has(apx(['dimension', 'read', DIM, 'src/b.py']).out, 'miss pseudocode src/b.py — changed: src/util/c.py');
    write(c, 'def c():\n    return 2\n');
    assert.equal(apx(['dimension', 'read', DIM, 'src/b.py']).code, 0);
    rmSync(c);
    const gone = apx(['dimension', 'read', DIM, 'src/b.py']);
    assert.equal(gone.code, 1);
    has(gone.out, 'miss pseudocode src/b.py — ref gone: src/util/c.py');
    has(apx(['dimension', 'why', DIM, 'src/b.py']).out, 'ref   src/util/c.py', 'now (none)  gone');
    write(c, 'def c():\n    return 2\n');
  }

  // --- find: across files, fresh entries only, case aside; nothing found exits 1 ---
  {
    const found = apx(['dimension', 'find', DIM, 'RETURNS 1']);
    assert.equal(found.code, 0, found.out);
    has(found.out, 'src/b.py  b: returns 1, used by src/util/c.py', '# 1 instance of pseudocode hold "RETURNS 1" — fresh entries only');
    assert.ok(!found.out.includes('src/a.py'), 'another file\'s instance that does not hold the text stays out');
    assert.equal(apx(['dimension', 'find', DIM, 'nothing like this']).code, 1);
    assert.equal(apx(['dimension', 'find', DIM]).code, 2, 'find needs text');
  }

  // --- none: nothing to report is an answer too ---
  {
    const n = apx(['dimension', 'write', DIM, 'src/util/c.py', 'none']);
    assert.equal(n.code, 0, n.out);
    const r = apx(['dimension', 'read', DIM, 'src/util/c.py']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^hit pseudocode src\/util\/c\.py — by coder, [\d-]+\nnone$/);
    assert.equal(apx(['dimension', 'read', DIM, 'src/util/c.py', 'json']).out, '"none"');
    rmSync(join(proj, '.agent-pack', 'cache', cacheDir(), 'src', 'util', 'c.py.json'));
    assert.equal(apx(['dimension', 'write', DIM, 'src/util/c.py', '-'], '"none"').code, 0, 'none as JSON on stdin');
  }

  // --- a file moved without an edit keeps its answer; a deleted one is gone ---
  {
    renameSync(b, join(proj, 'src', 'moved.py'));
    assert.equal(apx(['dimension', 'read', DIM, 'src/b.py']).code, 1, 'the old path: no file, no entry');
    const moved = apx(['dimension', 'read', DIM, 'src/moved.py']);
    assert.equal(moved.code, 0, moved.out);
    has(moved.out, 'hit pseudocode src/moved.py', 'b: returns 1');
    const dir = join(proj, '.agent-pack', 'cache', cacheDir(), 'src');
    assert.ok(existsSync(join(dir, 'moved.py.json')) && !existsSync(join(dir, 'b.py.json')), 'the entry moved with the file');
    assert.equal(JSON.parse(readFileSync(join(dir, 'moved.py.json'), 'utf-8')).file, 'src/moved.py');
    rmSync(a);
    const gone = apx(['dimension', 'read', DIM, 'src/a.py']);
    assert.equal(gone.code, 1);
    assert.equal(gone.out, 'gone pseudocode src/a.py — file not found');
    has(apx(['dimension', 'read', DIM, 'src/moved.py']).out, 'miss pseudocode src/moved.py — ref gone: src/a.py');   // its ref deleted: a miss
  }

  // --- ls and the counters; gc drops the entries of deleted files; clear by glob and by agent ---
  {
    const ls = apx(['dimension', 'ls', DIM]);
    assert.equal(ls.code, 0);
    assert.match(ls.out, /^gone {3}src\/a\.py {2}— file not found {2}\(by coder, /m);
    assert.match(ls.out, /^stale {2}src\/moved\.py {2}— ref gone: src\/a\.py {2}\(by coder, /m);
    assert.match(ls.out, /^fresh {2}src\/util\/c\.py {2}\(by coder, /m);
    assert.match(ls.out, /# pseudocode {2}\.agent-pack\/cache\/[0-9a-f]{8}\/ {2}3 entries: 1 fresh, 1 stale, 1 gone — \d+ hits, \d+ misses, hit rate \d+%/);
    has(apx(['dimension', 'ls', DIM, 'src/util/**']).out, '1 entry: 1 fresh');
    const gc = apx(['dimension', 'gc', DIM]);
    assert.equal(gc.code, 0);
    has(gc.out, 'removed src/a.py', '# 1 entry of deleted files removed from pseudocode');
    has(apx(['dimension', 'clear', DIM, 'src/util/**']).out, '# cleared 1 entry of pseudocode matching src/util/**');
    has(apx(['dimension', 'clear', DIM, '--by', 'someone-else']).out, '# cleared 0 entries');
    has(apx(['dimension', 'clear', DIM, '--by', 'coder']).out, '# cleared 1 entry of pseudocode written by coder');
    has(apx(['dimension', 'ls', DIM]).out, '0 entries');
    const stats = JSON.parse(readFileSync(join(proj, '.agent-pack', 'cache', 'stats', `${cacheDir()}.json`), 'utf-8'));
    assert.ok(stats.hits > 0 && stats.misses > 0, JSON.stringify(stats));
  }

  // --- bundle all removes the cache folders no dimension produces any more ---
  {
    const live = cacheDir();
    apx(['dimension', 'write', DIM, 'src/moved.py', 'none']);
    write(join(proj, '.agent-pack', 'cache', 'deadbeef', 'src', 'x.py.json'), '{}');
    write(join(proj, '.agent-pack', 'cache', 'stats', 'deadbeef.json'), '{"hits":1,"misses":0}');
    has(bundle(), '.agent-pack/cache/deadbeef/ removed');
    assert.ok(!existsSync(join(proj, '.agent-pack', 'cache', 'deadbeef')) && !existsSync(join(proj, '.agent-pack', 'cache', 'stats', 'deadbeef.json')));
    assert.ok(existsSync(join(proj, '.agent-pack', 'cache', live, 'src', 'moved.py.json')), 'a live dimension keeps its cache');
    // its rule edited: a new definition, a new folder — the old one is garbage
    write(dimFile, readFileSync(dimFile, 'utf-8').replace('one step per decision', 'one step per branch'));
    has(bundle(), `.agent-pack/cache/${live}/ removed`);
    assert.ok(!existsSync(join(proj, '.agent-pack', 'cache', live)));
    has(apx(['dimension', 'read', DIM, 'src/moved.py']).out, 'miss pseudocode src/moved.py — never written');
  }

  // --- an entry of another format is read as never written ---
  {
    assert.equal(apx(['dimension', 'write', DIM, 'src/moved.py', 'none']).code, 0);
    assert.equal(apx(['dimension', 'read', DIM, 'src/moved.py']).code, 0);
    const dir = join(proj, '.agent-pack', 'cache', cacheDir(), 'src');
    const path = join(dir, 'moved.py.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf-8')), format: 99 }));
    has(apx(['dimension', 'read', DIM, 'src/moved.py']).out, 'miss pseudocode src/moved.py — never written');
  }

  // --- B6: a dimension is an agent's — PROJECT.ap or a team's file that imports one fails the build ---
  {
    const { bundleStandaloneToString } = await import('../dist/src/compiler/index.js');
    const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
    const library = join(proj, 'library');
    const config = { libraryRoot: library, sharedLibraries: [] };
    const project = write(join(proj, 'PROJECT.ap'), ['ABOUT  the project', '', 'IMPORT pseudocode FROM @main.dimensions', '', 'WHEN you start:', '    DO  read the code']);
    await assert.rejects(bundleStandaloneToString(project, config), /PROJECT\.ap:3 {2}DIMENSION pseudocode: a dimension belongs to an agent — it is read and written through that agent's apx/);
    write(project, ['ABOUT  the project', '', ...dimension({ name: 'inline' }), '', 'WHEN you start:', '    DO  read the code']);
    await assert.rejects(bundleStandaloneToString(project, config), /PROJECT\.ap:3 {2}DIMENSION inline: a dimension belongs to an agent/);
    rmSync(project);
    const team = join(proj, 'agents', 'teams', 'crew');
    write(join(team, 'builder.ap'), ['EXPORT AGENT builder AS builder-role:', '    ABOUT    builds', '    MANDATE  ship', '', 'ROLE builder-role:', '    ABOUT   a builder', '    ALWAYS  test first']);
    write(join(team, 'crew.ap'), teamSource('crew', ['builder'], ['ABOUT  a crew', '', 'IMPORT pseudocode FROM @main.dimensions', '', 'WHEN asked to ship:', '    DO  ship it']));
    await assert.rejects(buildOrchestrationContent({ cwd: proj, standaloneAgentsDir: join(proj, 'agents', 'standalone'), teamsDir: join(proj, 'agents', 'teams'), libraryRoots: [library], libraries: { '@main': library } }),
      /crew\.ap:1 {2}DIMENSION pseudocode: a dimension belongs to an agent/);
    rmSync(join(proj, 'agents', 'teams'), { recursive: true });
  }

  console.log('dimension tests passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
