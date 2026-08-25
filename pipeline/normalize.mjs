/**
 * Drop build-output registrations from records that also carry source ones.
 *
 * A package holding both `src/` and `lib/` reports every registration twice —
 * once per plane. The scan stored each hit's path, so the duplicate is
 * removable after the fact without re-cloning. Packages shipping only `lib/`
 * keep it: there it IS the source of record.
 */
const BUILD = /^(lib|dist|build|out)\//

/** One record with its build-plane duplicates removed. */
export function normalizeRecord(rec) {
  const contributions = rec.contributions ?? []
  const hasSource = contributions.some(c => /^src\//.test(c.source ?? ''))
  if (!hasSource) return rec
  const kept = contributions.filter(c => !BUILD.test(c.source ?? ''))
  return { ...rec, contributions: kept, duplicatesDropped: contributions.length - kept.length }
}
