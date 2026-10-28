/**
 * Block decorators (src/decorators.ts) — the structure every decorator goes
 * through, proven with two test decorators registered here: one that adds up
 * (union), one that narrows (intersection). No real decorator is registered
 * yet: WITH and WITHIN move onto this structure in the next pieces.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

const { lex } = await import('../dist/src/lexer.js');
const { parseBlocks } = await import('../dist/src/parseBlocks.js');
const { checkVocabulary } = await import('../dist/src/lint.js');
const { registerDecorator, decoratorOf, resolveDecorator, DecoratorScope } = await import('../dist/src/decorators.js');
const { renderTree } = await import('../dist/src/bundlers/renderTree.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');

const SHAPE = { key: 'SHAPE', names: ['template'], combine: 'union', intro: 'For the work below, shape it with' };
const ONLY = { key: 'ONLY', names: ['template', 'policy'], combine: 'intersection', intro: 'For the work below, only' };
registerDecorator(SHAPE);
registerDecorator(ONLY);

const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const messages = (file, body) => checkVocabulary(file, body).map(e => `${e.line}: ${e.message}`);

// --- the lexer: `@KEY items`, `@KEY items:` — a lowercase `@name` stays what it was ---
{
  const [above, opens, bare, lower] = ['@SHAPE a, #forms', '    @ONLY a:', '@SHAPE:', '@main x'].map(l => lex(l)[0]);
  assert.deepEqual([above.kind, above.key, above.rest, above.opens], ['decorator', 'SHAPE', 'a, #forms', false]);
  assert.deepEqual([opens.key, opens.rest, opens.opens, opens.indent], ['ONLY', 'a', true, 4]);
  assert.deepEqual([bare.key, bare.rest, bare.opens], ['SHAPE', '', true]);
  assert.equal(lower.kind, 'procRef');
  console.log('decorators: lexer passed.');
}

// --- the parser: above a block it is the block's; with a colon it opens a transparent block ---
{
  const src = [
    'PROCEDURE p:', '    @SHAPE a', '    @ONLY b',
    '    WHEN asked:', '        DO one', '        @SHAPE c:', '            DO two', '        DO three',
  ].join('\n');
  const { blocks, errors } = parseBlocks(src);
  assert.deepEqual(errors, []);
  const p = blocks[0].children.find(c => c.type === 'block');
  assert.deepEqual(p.decorators.map(d => `${d.key} ${d.rest}`), ['SHAPE a', 'ONLY b'], 'stacked, in order');
  const opened = p.children.find(c => c.type === 'block');
  assert.deepEqual([opened.key, opened.decorator.key, opened.decorator.rest], ['@SHAPE', 'SHAPE', 'c']);
  assert.equal(opened.children[0].rest, 'two');

  const dangling = parseBlocks(['PROCEDURE p:', '    @SHAPE a', '    DO one'].join('\n')).errors;
  assert.equal(dangling.length, 1);
  assert.match(dangling[0].message, /`@SHAPE` decorates no block/);
  assert.match(parseBlocks(['PROCEDURE p:', '    DO one', '    @SHAPE a'].join('\n')).errors[0].message, /decorates no block/, 'at the end of a body');
  assert.match(parseBlocks(['PROCEDURE p:', '    @SHAPE a:', '    DO one'].join('\n')).errors[0].message, /opens a block, and nothing is nested below it/);
  // A definition is decorated from inside its body, not yet from above.
  assert.match(parseBlocks(['@SHAPE a', 'EXPORT PROCEDURE p:', '    DO one'].join('\n')).errors[0].message, /`@SHAPE` stands above PROCEDURE, a definition — decorate its work from inside/);
  console.log('decorators: parser passed.');
}

// --- the registry, the resolver and the scope: one way for every decorator ---
{
  assert.equal(decoratorOf('@SHAPE'), SHAPE);
  assert.equal(decoratorOf('NOPE'), null);
  const blocks = { template: [{ name: 'a', tags: ['#forms'] }, { name: 'b', tags: ['#forms'] }, { name: 'c', tags: [] }], policy: [{ name: 'p', tags: ['#forms'] }] };
  const lookup = kind => blocks[kind] ?? [];
  assert.deepEqual(resolveDecorator(SHAPE, ['a', '#forms'], lookup), { uses: [{ kind: 'template', name: 'a' }, { kind: 'template', name: 'b' }], problems: [] }, 'a tag selects, a name met twice counts once');
  assert.deepEqual(resolveDecorator(ONLY, ['#policy:forms'], lookup).uses, [{ kind: 'policy', name: 'p' }]);
  has(resolveDecorator(ONLY, ['#forms'], lookup).problems[0], 'a tag says which: `#<kind>:forms`');
  has(resolveDecorator(SHAPE, ['#skill:x'], lookup).problems[0], 'not a skill');
  has(resolveDecorator(SHAPE, ['zz'], lookup).problems[0], 'no imported template is called `zz`');
  has(resolveDecorator(SHAPE, ['#none'], lookup).problems[0], 'no imported template has #none');

  const t = name => ({ kind: 'template', name });
  const added = DecoratorScope.EMPTY.enter(SHAPE, [t('a')]).enter(SHAPE, [t('b'), t('a')]);
  assert.deepEqual(added.get('SHAPE').map(u => u.name), ['a', 'b'], 'union: nested decorators add up');
  const narrowed = DecoratorScope.EMPTY.enter(ONLY, [t('a'), t('b')]).enter(ONLY, [t('b'), t('c')]);
  assert.deepEqual(narrowed.get('ONLY').map(u => u.name), ['b'], 'intersection: nested decorators narrow');
  const outer = DecoratorScope.EMPTY.enter(SHAPE, [t('a')]);
  outer.enter(SHAPE, [t('b')]);
  assert.deepEqual(outer.get('SHAPE').map(u => u.name), ['a'], 'entering never changes the enclosing scope');
  assert.equal(outer.get('ONLY'), null);
  console.log('decorators: registry, resolver and scope passed.');
}

// --- the lint: the key, the items, the place — and a decorator's block is transparent ---
{
  const agent = body => ['EXPORT AGENT a AS r:', '    ABOUT    x', '    MANDATE  y', ...body, '', 'ROLE r:', '    ABOUT   z', '    ALWAYS  be careful'].join('\n');
  assert.deepEqual(messages('/x/a.ap', agent(['    @SHAPE a', '    WHEN asked:', '        DO it', '        @SHAPE b:', '            DO more'])), [], 'above a WHEN, and opening a block in it');
  has(messages('/x/a.ap', agent(['    @SHAPN a', '    WHEN asked:', '        DO it'])).join('\n'), '`@SHAPN`: no decorator has that name — the decorators:', '@SHAPE', '@ONLY');
  has(messages('/x/a.ap', agent(['    @SHAPE', '    WHEN asked:', '        DO it'])).join('\n'), '`@SHAPE` needs what it names');
  has(messages('/x/a.ap', agent(['    @SHAPE a b', '    WHEN asked:', '        DO it'])).join('\n'), '`a b`: a decorator names blocks or tags');
  has(messages('/x/a.ap', agent(['    WHEN asked:', '        @SHAPE a', '        DO it'])).join('\n'), '`@SHAPE` decorates no block');
  console.log('decorators: lint passed.');
}

// --- the standalone renderer: a decorator's sentence, with the ids of what it names ---
{
  const ctx = { templates: [{ kind: 'template', name: 'a', tags: [], refId: 'tpl-11111111' }] };
  const out = renderTree(['@SHAPE a:', '    DO write it'].join('\n'), ctx);
  has(out, 'For the work below, shape it with the template `a` (tpl-11111111):');
  console.log('decorators: standalone renderer passed.');
}

// --- the compilation: one node per decorator, nested where written; what names nothing fails the build ---
{
  const root = mkdtempSync(join(tmpdir(), 'ap-decorators-'));
  try {
    const lib = join(root, 'library');
    const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, lines.join('\n') + '\n'); return file; };
    for (const name of ['shape-a', 'shape-b']) write(join(lib, 'templates', `${name}.ap`), [`EXPORT TEMPLATE ${name}:`, '    ABOUT  a shape of text', '    SLOTS:', '        text: TEXT  "the text"']);
    const compile = body => {
      const file = write(join(root, 'a.ap'), [
        'IMPORT shape-a, shape-b FROM @main.templates', '',
        'EXPORT AGENT a AS r:', '    ABOUT    writes', '    MANDATE  write well', ...body, '',
        'ROLE r:', '    ABOUT   a writer', '    ALWAYS  write clearly',
      ]);
      return bundleAgentObject({ agentName: 'a', agentFile: file, agentDir: root, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
    };
    const ok = await compile([
      '    @SHAPE shape-a', '    WHEN asked to write:', '        DO  write it',
      '        @SHAPE shape-b:', '            DO  shape it',
    ]);
    has(ok.body, 'For the work below, shape it with the template `shape-a` (tpl-', 'For the work below, shape it with the template `shape-b` (tpl-', 'write it', 'shape it');
    const doc = JSON.parse(ok.structure.asJson());
    const agent = Object.values(doc.blocks).find(b => b.kind === 'agent');
    const outer = agent.body.find(n => n.keyword === '@SHAPE');
    assert.equal(outer.uses.length, 1, 'the blocks it names, as Refs');
    const when = outer.body.find(n => n.type === 'when');
    assert.ok(when, 'the decorated WHEN is the decorator node\'s body');
    assert.ok(when.body.some(n => n.keyword === '@SHAPE' && n.body.some(m => m.text === 'shape it')), 'the opened block nests where it is written');

    await assert.rejects(compile(['    @SHAPE shape-z', '    WHEN asked to write:', '        DO  write it']), /`@SHAPE shape-z`: no imported template is called `shape-z`/);
    console.log('decorators: compilation passed.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
