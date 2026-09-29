// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import {
  getCanonicalKeywords,
  aliasToCanonical,
  getIntroByKeyword,
  buildForceLevelRegexSource,
  getFamilyBases,
  getAliasNames,
} from '../dist/src/forceLevelConfig.js';

// --- 1. Derivation: canonical keywords per family ---

{
  const kws = getCanonicalKeywords();

  // MUST family: levels -1, 0, 1, 2 → !MUST, MUST, MUST!, MUST!!
  assert.ok(kws.includes('MUST'),    'MUST canonical keyword present');
  assert.ok(kws.includes('MUST!'),   'MUST! canonical keyword present');
  assert.ok(kws.includes('MUST!!'),  'MUST!! canonical keyword present');
  assert.ok(kws.includes('!MUST'),   '!MUST canonical keyword present');

  // ALWAYS family: levels -1, 0 → !ALWAYS, ALWAYS
  assert.ok(kws.includes('ALWAYS'),  'ALWAYS canonical keyword present');
  assert.ok(kws.includes('!ALWAYS'), '!ALWAYS canonical keyword present');

  // SHOULD family: levels 0, 1 → SHOULD, SHOULD!
  assert.ok(kws.includes('SHOULD'),  'SHOULD canonical keyword present');
  assert.ok(kws.includes('SHOULD!'), 'SHOULD! canonical keyword present');

  // MAY family: level 0 → MAY
  assert.ok(kws.includes('MAY'),     'MAY canonical keyword present');

  // Sorted by length descending: MUST!! (6) before MUST! (5) before MUST (4)
  const mustIdx   = kws.indexOf('MUST');
  const mustBangIdx  = kws.indexOf('MUST!');
  const mustBang2Idx = kws.indexOf('MUST!!');
  const notMustIdx   = kws.indexOf('!MUST');
  assert.ok(mustBang2Idx < mustBangIdx,  'MUST!! before MUST! in sorted order');
  assert.ok(mustBangIdx < mustIdx,       'MUST! before MUST in sorted order');
  // !MUST (5 chars) and MUST! (5 chars) — same length, order is stable but not guaranteed
  // Just verify both are before MUST
  assert.ok(notMustIdx < mustIdx || mustBangIdx < mustIdx, '!MUST and MUST! both before MUST');
}

// --- 2. Alias resolution ---

{
  assert.equal(aliasToCanonical('NON-NEGOTIABLE'), 'MUST!!',  'NON-NEGOTIABLE → MUST!!');
  assert.equal(aliasToCanonical('MUST-NOT'),       '!MUST',   'MUST-NOT → !MUST');
  assert.equal(aliasToCanonical('NEVER'),          '!ALWAYS', 'NEVER → !ALWAYS');

  assert.throws(
    () => aliasToCanonical('UNKNOWN'),
    /unknown alias/,
    'aliasToCanonical throws for unknown alias',
  );
}

// --- 3. Intro lookup ---

{
  assert.equal(getIntroByKeyword('MUST'),   'You must',   'MUST intro');
  assert.ok(
    getIntroByKeyword('MUST!')?.includes('[HARD CONSTRAINT]'),
    'MUST! intro contains [HARD CONSTRAINT]',
  );
  assert.ok(
    getIntroByKeyword('MUST!!')?.includes('[IDENTITY CONSTRAINT]'),
    'MUST!! intro contains [IDENTITY CONSTRAINT]',
  );
  assert.equal(getIntroByKeyword('!MUST'),   'You must not',   '!MUST intro');
  assert.equal(getIntroByKeyword('!ALWAYS'), 'You must never',  '!ALWAYS intro');
  assert.equal(getIntroByKeyword('ALWAYS'),  'You must always', 'ALWAYS intro');
  assert.equal(getIntroByKeyword('SHOULD'),  'You should',      'SHOULD intro');
  assert.ok(
    getIntroByKeyword('SHOULD!')?.includes('strongly recommended'),
    'SHOULD! intro contains "strongly recommended"',
  );
  assert.equal(getIntroByKeyword('MAY'),     'You may',         'MAY intro');

  assert.equal(getIntroByKeyword('UNKNOWN'), null, 'unknown keyword returns null');
  assert.equal(getIntroByKeyword('!MUST!'),  null, 'prefix+suffix combo returns null');
  assert.equal(getIntroByKeyword(''),        null, 'empty string returns null');
}

// --- 4. Regex source ---

{
  const src = buildForceLevelRegexSource();
  assert.ok(typeof src === 'string',   'buildForceLevelRegexSource returns a string');
  assert.ok(src.includes('MUST'),      'regex source contains MUST');
  assert.ok(src.includes('ALWAYS'),    'regex source contains ALWAYS');
  assert.ok(src.includes('SHOULD'),    'regex source contains SHOULD');
  assert.ok(src.includes('MAY'),       'regex source contains MAY');

  // Verify it compiles to a valid regex
  assert.doesNotThrow(() => new RegExp(src), 'buildForceLevelRegexSource produces a valid regex');
}

// --- 5. getFamilyBases ---

{
  const bases = getFamilyBases();
  assert.ok(Array.isArray(bases),        'getFamilyBases returns an array');
  assert.ok(bases.includes('MUST'),      'MUST in family bases');
  assert.ok(bases.includes('ALWAYS'),    'ALWAYS in family bases');
  assert.ok(bases.includes('SHOULD'),    'SHOULD in family bases');
  assert.ok(bases.includes('MAY'),       'MAY in family bases');
  // Aliases are NOT bases
  assert.ok(!bases.includes('NEVER'),         'NEVER is not a family base');
  assert.ok(!bases.includes('MUST-NOT'),      'MUST-NOT is not a family base');
  assert.ok(!bases.includes('NON-NEGOTIABLE'),'NON-NEGOTIABLE is not a family base');
  // CONTEXT is an enum primitive, not a force-level family
  assert.ok(!bases.includes('CONTEXT'), 'CONTEXT is not a force-level family base');
}

// --- 6. getAliasNames — CONTEXT values not leaked as aliases ---

{
  const aliases = getAliasNames();
  assert.ok(!aliases.includes('isolated'), 'isolated not in getAliasNames');
  assert.ok(!aliases.includes('summary'),  'summary not in getAliasNames');
  assert.ok(!aliases.includes('full'),     'full not in getAliasNames');
}

// --- 7. getCanonicalKeywords — CONTEXT not present ---

{
  const kws = getCanonicalKeywords();
  assert.ok(!kws.includes('CONTEXT'),  'CONTEXT not in getCanonicalKeywords');
  assert.ok(!kws.includes('CONTEXT!'), 'CONTEXT! not in getCanonicalKeywords');

  const src = buildForceLevelRegexSource();
  assert.ok(!src.includes('CONTEXT'), 'CONTEXT not in buildForceLevelRegexSource');
}

console.log('forceLevelConfig tests passed.');
