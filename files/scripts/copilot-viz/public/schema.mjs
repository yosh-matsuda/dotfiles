export const record = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
export const identified = (x) => record(x) && typeof x.id === 'string';
export const listOf = (list, check) => Array.isArray(list) && list.every(check);

export function validSession(s) {
  return identified(s) && typeof s.epoch === 'string' && record(s.meta)
    && (s.meta.aic == null || Number.isFinite(s.meta.aic)) && (s.meta.cwd == null || typeof s.meta.cwd === 'string')
    && listOf(s.agents, (a) => record(a) && typeof a.key === 'string' && record(a.tokens) && listOf(a.phases, record))
    && listOf(s.calls, identified) && listOf(s.shells, identified)
    && listOf(s.feed, (f) => record(f) && Number.isSafeInteger(f.id) && typeof f.kind === 'string' && typeof f.text === 'string'
      && (f.ts == null || (Number.isFinite(f.ts) && Math.abs(f.ts) <= 8.64e15)))
    && listOf(s.activity, (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite));
}
