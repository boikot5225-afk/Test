from pathlib import Path

# Apply the base toc107 patch first (including the toc106 build-marker shim).
exec(compile(Path('scripts/patch-toc107-native-zh-segmentation-r2.py').read_text(),
             'scripts/patch-toc107-native-zh-segmentation-r2.py', 'exec'))

p = Path('android/app/src/main/java/space/saintjust/reader/stage1/ChineseResourceBridge.java')
s = p.read_text()
s = s.replace('    private static final double SEGMENT_MISS = -1.0e12;\n',
              '    private static final double SEGMENT_INF = 1.0e12;\n', 1)
s = s.replace(
    '    private static final String NAME_STOP_CHARS = "的了着过们是有在和与及并就也都很又而为被把将从到对起后前中上下来去这那其之";\n',
    '    private static final String NAME_STOP_SECOND = "的了着过们是有在和与及并就也都很而为被把将从到对起后前中上下来去这那其之";\n'
    '    private static final String NAME_STOP_THIRD = "的了着过们是有在和与及并就也都很又而为被把将从到对起后前中上下来去这那其之";\n',
    1)

start = s.index('    private List<String> segmentHanRun(SQLiteDatabase db, String run) {')
end = s.index('    private boolean isHan(char ch) {', start)
replacement = r'''    private List<String> segmentHanRun(SQLiteDatabase db, String run) {
        int n = run.length();
        double[] best = new double[n + 1];
        int[] next = new int[n + 1];
        for (int i = 0; i <= n; i++) {
            best[i] = SEGMENT_INF;
            next[i] = Math.min(n, i + 1);
        }
        best[n] = 0.0;
        next[n] = n;

        for (int i = n - 1; i >= 0; i--) {
            int max = Math.min(SEGMENT_MAX_WORD, n - i);
            for (int len = 1; len <= max; len++) {
                String word = run.substring(i, i + len);
                double cost = dictionarySegmentCost(db, word);
                if (cost >= SEGMENT_INF / 2 && isLikelyThreeCharName(db, run, i, len)) {
                    // A plausible surname + two-character given name should beat
                    // three unrelated characters, but normal dictionary words
                    // still win whenever they exist.
                    cost = 4.5;
                }
                if (cost >= SEGMENT_INF / 2) {
                    if (len == 1) cost = 14.0; // true OOV single-character fallback
                    else continue;
                }
                double total = cost + best[i + len];
                if (total < best[i]) {
                    best[i] = total;
                    next[i] = i + len;
                }
            }
        }

        List<String> out = new ArrayList<>();
        int i = 0;
        while (i < n) {
            int j = next[i];
            if (j <= i || j > n) j = i + 1;
            out.add(run.substring(i, j));
            i = j;
        }
        return out;
    }

    private double dictionarySegmentCost(SQLiteDatabase db, String word) {
        Double cached = segmentationScoreCache.get(word);
        if (cached != null) return cached;
        double cost = SEGMENT_INF;
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT blcu,subtlex,jieba FROM entries WHERE word=? LIMIT 1",
                    new String[]{word});
            if (cursor.moveToFirst()) {
                long rank = Long.MAX_VALUE;
                int coverage = 0;
                for (int index = 0; index < 3; index++) {
                    if (!cursor.isNull(index)) {
                        long value = cursor.getLong(index);
                        if (value > 0) {
                            coverage += 1;
                            if (value < rank) rank = value;
                        }
                    }
                }
                // The 500k dictionary contains useful definitions but also rare
                // phrase fragments. Require frequency evidence for segmentation;
                // definition-only entries remain available in the word panel.
                if (rank != Long.MAX_VALUE) {
                    cost = Math.log(rank + 1.0);
                    if (coverage == 1) cost += 0.75;
                    if (rank > 50_000L) cost += 3.0;
                    if (rank > 150_000L) cost += 3.0;
                }
            }
        } catch (Exception ignored) {
            cost = SEGMENT_INF;
        } finally {
            if (cursor != null) cursor.close();
        }
        segmentationScoreCache.put(word, cost);
        return cost;
    }

    private boolean isLikelyThreeCharName(SQLiteDatabase db, String run, int start, int len) {
        if (len != 3 || start + 3 > run.length()) return false;
        char surname = run.charAt(start);
        if (COMMON_SURNAMES.indexOf(surname) < 0) return false;
        char second = run.charAt(start + 1);
        char third = run.charAt(start + 2);
        // 又 is allowed in the middle (张又侠), while grammatical characters
        // such as 被/的/了 reject false names like 时被终 or 张开了.
        if (NAME_STOP_SECOND.indexOf(second) >= 0 || NAME_STOP_THIRD.indexOf(third) >= 0) return false;
        // Reject a fake name if either two-character half is already a normal
        // frequency-backed word: 纪违法 must become 违纪 + 违法, not a person.
        return dictionarySegmentCost(db, run.substring(start, start + 2)) >= SEGMENT_INF / 2
                && dictionarySegmentCost(db, run.substring(start + 1, start + 3)) >= SEGMENT_INF / 2;
    }

'''
s = s[:start] + replacement + s[end:]
p.write_text(s)
print('toc107 r3 frequency-weighted segmentation applied')
