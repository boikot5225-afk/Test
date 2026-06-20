An II Firebase v24 cachefix

Что исправлено:
- Приложение больше не использует старый localStorage-кэш an2_cache_verbs_v1 / an2_cache_phrases_v1.
- Новый кэш: an2_cache_verbs_firebase_v24 / an2_cache_phrases_firebase_v24.
- Фоновая загрузка глаголов после быстрого входа теперь делает force refresh из Firebase.
- Отключён fallback /verbs -> /Verbs, чтобы случайно не читать старую импортированную Supabase-базу с большой буквы.

В Firebase правильные узлы:
- verbs
- phrases
- nouns
- prepositions

Неправильные старые узлы можно удалить:
- Verbs
- Phrases
- Nouns
- Prepositions

Для ручной очистки кэша в браузере можно открыть DevTools Console и выполнить:
clearAn2DictionaryCache()
