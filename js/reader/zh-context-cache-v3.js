// toc99: one-time migration for contextual Chinese gloss cache.
// toc98 may already contain pinyin chosen before Migaku candidate constraints.
// Remove only that old per-user context cache; layout/Known/Unknown state stays intact.
const MIGRATION_KEY = 'an2_reader_zh_context_cache_schema_v3';

try {
  if (localStorage.getItem(MIGRATION_KEY) !== '1') {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || '';
      if (key.startsWith('an2_reader_zh_context_gloss_v2::')) doomed.push(key);
    }
    doomed.forEach(key => localStorage.removeItem(key));
    localStorage.setItem(MIGRATION_KEY, '1');
    try {
      window.dispatchEvent(new CustomEvent('reader:zh-context-cache-reset', {
        detail: { removed: doomed.length, schema: 3 },
      }));
    } catch {}
  }
} catch {}
