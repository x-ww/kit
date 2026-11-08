#!/usr/bin/env python3
"""Reproduce the v1.2 vs v2 ETA backtest documented in README.md.

Usage:  python3 backtest.py [sessions_dir]
Requires the 'zstd' CLI. Defaults to ~/.dsh/sessions/--Volumes-T7-dsh-- .
Probes are at 10..90% of each turn's WALL-CLOCK duration; evaluation is
5-fold cross-validation grouped by session.
"""
import json, glob, subprocess, statistics, math, os, re, collections, random, sys

ZSTD = 'zstd'
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.expanduser('~/.dsh/sessions/--Volumes-T7-dsh--')
SESSIONS_DIR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('DSH_SESSIONS_DIR', DEFAULT_DIR)
FRACTIONS = [0.10, 0.20, 0.35, 0.50, 0.65, 0.80, 0.90]

# v1.2 constants, read from the previous client.js if available, else inlined below.
V12_PRIOR = None
try:
    old = open(os.path.join(HERE, 'client.js')).read()
    m = re.search(r'const STEP_PRIOR = (\{.*?\});', old, re.S)
    if m:
        V12_PRIOR = eval(m.group(1))
except OSError:
    pass
if V12_PRIOR is None:
    # The shipped v1.2 table (P25/P50/P75 of remaining steps, k=0..60).
    V12_PRIOR = {0:[8.0,19.0,35.0],1:[7.0,18.0,34.0],2:[6.0,17.0,33.0],3:[5.5,17.0,33.0],4:[5.25,19.5,34.5],5:[5.0,19.0,34.5],6:[6.75,19.5,35.5],7:[7.5,19.0,36.0],8:[10.0,19.5,38.5],9:[10.0,20.0,39.0],10:[11.0,20.0,38.75],11:[10.75,19.0,38.25],12:[10.5,18.0,37.5],13:[10.25,17.0,36.75],14:[10.0,17.0,36.5],15:[9.0,16.0,36.0],16:[8.0,15.5,35.75],17:[7.5,15.0,35.5],18:[8.0,16.0,37.0],19:[8.0,17.0,36.0],20:[8.0,16.0,35.0],21:[7.0,16.0,34.5],22:[6.25,16.0,33.75],23:[6.0,16.0,33.0],24:[6.0,17.0,34.25],25:[5.0,17.0,33.75],26:[5.25,18.5,33.0],27:[6.25,20.0,37.25],28:[7.0,20.0,38.5],29:[7.0,19.5,38.75],30:[9.0,20.5,40.5],31:[10.0,21.5,40.5],32:[9.0,22.0,40.0],33:[10.0,22.0,42.5],34:[9.75,21.0,43.25],35:[11.0,20.0,46.5],36:[12.0,19.5,50.5],37:[11.0,19.0,52.0],38:[10.0,18.0,51.0],39:[9.5,19.0,50.5],40:[8.5,18.0,49.5],41:[9.0,18.0,49.0],42:[8.0,17.0,48.0],43:[9.5,16.0,48.0],44:[8.5,15.0,47.0],45:[7.5,14.0,46.0],46:[9.0,20.0,46.0],47:[8.0,19.0,45.0],48:[7.25,20.5,44.0],49:[7.0,21.0,43.0],50:[7.5,21.0,45.75],51:[7.5,21.0,48.5],52:[6.5,20.0,47.5],53:[5.5,19.0,46.5],54:[5.0,21.5,49.25],55:[11.5,34.0,62.0],56:[11.75,33.5,66.0],57:[10.75,32.5,65.0],58:[12.0,32.0,69.0],59:[16.5,33.0,74.0],60:[15.5,32.0,73.0]}

def v12_band(x):
    """The exact v1.2 formula: STEP_PRIOR quantiles * fixed 6.4s, widened 1.3x."""
    k = min(x['k'], 60)
    row = V12_PRIOR.get(k, V12_PRIOR[60])
    p = 6400.0
    low = max(p * 0.6, row[0] * p / 1.3)
    mid = row[1] * p
    high = max(row[2] * p * 1.3, row[1] * p * 1.8)
    return (low / 1000.0, mid / 1000.0, high / 1000.0)

COEF = [0.281552, 1.000945, -0.269862]
Q10, Q50, Q90 = -1.727042, -0.022416, 1.780031

def features(x):
    return [1.0, math.log(x['el'] + 1.0), math.log(x['k'] + 1.0)]

def solve(A, y):
    n = len(A[0])
    N = [[sum(row[j] * row[k] for row in A) for k in range(n)] +
         [sum(A[i][j] * y[i] for i in range(len(y)))] for j in range(n)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(N[r][i]))
        N[i], N[p] = N[p], N[i]
        if abs(N[i][i]) < 1e-12:
            continue
        for r in range(n):
            if r == i:
                continue
            f = N[r][i] / N[i][i]
            for c in range(i, n + 1):
                N[r][c] -= f * N[i][c]
    return [N[i][n] / N[i][i] if abs(N[i][i]) > 1e-12 else 0.0 for i in range(n)]

def fit(rows):
    A = [features(x) for x in rows]
    y = [math.log(max(0.5, x['rem'])) for x in rows]
    b = solve(A, y)
    res = sorted(y[i] - sum(b[j] * A[i][j] for j in range(len(b))) for i in range(len(y)))
    q = lambda p: res[int(p * (len(res) - 1))]
    return b, (q(0.10), q(0.50), q(0.90))

def v2_band(x, b, q):
    f = sum(b[j] * features(x)[j] for j in range(len(b)))
    return tuple(math.exp(f + v) for v in q)

def parse(path):
    try:
        out = subprocess.run([ZSTD, '-dc', '--stdout', path], capture_output=True,
                             text=True, timeout=40).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    turns = {}
    step_ends = collections.defaultdict(list)
    starts = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        typ, d, tm = e.get('type'), e.get('data') or {}, e.get('time')
        if typ == 'turn/start':
            turns[d.get('turn')] = {'start': tm, 'end': None}
        elif typ == 'turn/end':
            key = d.get('turn')
            if key in turns:
                turns[key]['end'] = tm
        elif typ == 'step/start':
            starts[(d.get('turn'), d.get('step'))] = tm
        elif typ == 'step/end':
            key = (d.get('turn'), d.get('step'))
            step_ends[d.get('turn')].append((d.get('step'), tm, starts.get(key)))
    rows = []
    for tid, info in turns.items():
        if info['end'] is None:
            continue
        ends = sorted([x for x in step_ends.get(tid, []) if isinstance(x[0], int)],
                      key=lambda x: x[0])
        if not ends:
            continue
        dur = info['end'] - info['start']
        if dur <= 0 or dur > 3 * 3600 * 1000:
            continue
        for frac in FRACTIONS:
            probe = info['start'] + int(frac * dur)
            closed = [x for x in ends if x[1] <= probe]
            rows.append({
                'sid': os.path.basename(os.path.dirname(path)), 'turn': tid, 'frac': frac,
                'el': (probe - info['start']) / 1000.0, 'k': len(closed),
                'rem': (info['end'] - probe) / 1000.0, 'total': dur / 1000.0,
            })
    return rows

def quantile(vals, q):
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * (len(s) - 1)))]

def report(name, preds, rows):
    rels = [abs(m - x['rem']) / x['rem'] for x, (lo, m, hi) in zip(rows, preds)]
    cov = [1 if lo <= x['rem'] <= hi else 0 for x, (lo, m, hi) in zip(rows, preds)]
    bias = statistics.median([m / x['rem'] for x, (lo, m, hi) in zip(rows, preds)])
    abse = statistics.median([abs(m - x['rem']) for x, (lo, m, hi) in zip(rows, preds)])
    print('%-26s medRel=%5.0f%%  p75Rel=%5.0f%%  bias=%.2fx  coverage=%3.0f%%  medAbs=%3.0fs' % (
        name, 100 * statistics.median(rels), 100 * quantile(rels, 0.75),
        bias, 100 * statistics.mean(cov), abse))

def main():
    files = sorted(glob.glob(os.path.join(SESSIONS_DIR, '*/session.v4.jsonl.zstd')))
    if not files:
        sys.exit('no session logs found under ' + SESSIONS_DIR)
    rows = []
    for f in files:
        rows.extend(parse(f))
    print('sessions=%d turns=%d probes=%d' % (
        len(files), len(set((x['sid'], x['turn']) for x in rows)), len(rows)))
    sids = sorted(set(x['sid'] for x in rows))
    random.Random(7).shuffle(sids)
    fold = {s: i % 5 for i, s in enumerate(sids)}
    heldout = [None] * len(rows)
    for f in range(5):
        tr = [i for i, x in enumerate(rows) if fold[x['sid']] != f]
        te = [i for i, x in enumerate(rows) if fold[x['sid']] == f]
        b, q = fit([rows[i] for i in tr])
        for i in te:
            heldout[i] = v2_band(rows[i], b, q)
    print('--- 5-fold grouped-by-session (held out) ---')
    report('v1.2 fixed 6.4s/step', [v12_band(x) for x in rows], rows)
    report('v2 elapsed + steps', heldout, rows)
    print('--- fitted coefficients (full data) ---')
    b, q = fit(rows)
    print('coef =', [round(v, 6) for v in b])
    print('q10/q50/q90 =', [round(v, 6) for v in q])

if __name__ == '__main__':
    main()
