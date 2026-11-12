// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { escapeRegex } from './text.js';

export type MdBlockAction = 'created' | 'updated' | 'unchanged';

export interface MdBlockOptions {
  filePath: string;
  key: string;
  content: string;
}

export interface MdBlockResult {
  action: MdBlockAction;
  path: string;
}

export function ensureMdBlock(opts: MdBlockOptions): MdBlockResult {
  const { filePath, key, content } = opts;
  const startMarker = `<!-- agent-pack:${key}:start -->`;
  const endMarker = `<!-- agent-pack:${key}:end -->`;
  const block = `${startMarker}\n${content.trim()}\n${endMarker}`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${block}\n`, 'utf-8');
    return { action: 'created', path: filePath };
  }

  const current = readFileSync(filePath, 'utf-8');
  const pattern = new RegExp(`${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}`);

  if (pattern.test(current)) {
    const updated = current.replace(pattern, block);
    if (updated === current) return { action: 'unchanged', path: filePath };
    writeFileSync(filePath, updated, 'utf-8');
    return { action: 'updated', path: filePath };
  }

  const separator = current.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(filePath, `${current + separator + block}\n`, 'utf-8');
  return { action: 'updated', path: filePath };
}

/** Remove a managed block, markers included, when the file has one. Returns whether it did. */
export function removeMdBlock(filePath: string, key: string): boolean {
  if (!existsSync(filePath)) return false;
  const current = readFileSync(filePath, 'utf-8');
  const start = escapeRegex(`<!-- agent-pack:${key}:start -->`);
  const end = escapeRegex(`<!-- agent-pack:${key}:end -->`);
  const pattern = new RegExp(`\\n*${start}[\\s\\S]*?${end}\\n?`);
  if (!pattern.test(current)) return false;
  writeFileSync(filePath, `${current.replace(pattern, '\n').trim()}\n`, 'utf-8');
  return true;
}
