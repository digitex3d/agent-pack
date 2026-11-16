// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/** Numbers as the chat screen shows them, tersely: tokens (`12.4k`), durations (`3s`, `1:05`), a cost (`USD 0.12` as `$0.12`). */

const THOUSAND = 1000;
const MILLION = 1_000_000;
const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;
const PAD = 2;
const CENTS = 2;
const DOLLAR = '$';

/** A count of tokens: as it is under a thousand, else in k or M, one decimal (`12.4k`, `1.2M`). */
export function tokens(count: number): string {
  if (count < THOUSAND) return String(count);
  const [scaled, unit] = count < MILLION ? [count / THOUSAND, 'k'] : [count / MILLION, 'M'];
  return scaled.toFixed(1).replace(/\.0(?=$)/, '') + unit;
}

/** A clock of whole seconds: `M:SS`, or `H:MM:SS` past an hour. */
export function clockOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND_MS));
  const two = (value: number) => String(value).padStart(PAD, '0');
  const minutes = two(seconds % MINUTE_S);
  if (seconds < HOUR_S) return [Math.floor(seconds / MINUTE_S), minutes].join(':');
  return [Math.floor(seconds / HOUR_S), two(Math.floor((seconds % HOUR_S) / MINUTE_S)), minutes].join(':');
}

/** A duration, tersely: whole seconds under a minute (`3s`), else a clock (`1:05`). */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / SECOND_MS));
  return seconds < MINUTE_S ? `${seconds}s` : clockOf(ms);
}

/** A participant's name with the model it runs on, in parentheses — the name alone when it reports none. */
export function withModel(name: string, model: string | undefined): string {
  return model ? `${name} (${model})` : name;
}

/** A cost: dollars with cents, any other currency after the amount. */
export function cost(amount: number, currency = 'USD'): string {
  return currency === 'USD' ? DOLLAR + amount.toFixed(CENTS) : [amount.toFixed(CENTS), currency].join(' ');
}
