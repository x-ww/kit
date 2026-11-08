window.__ModuleLoader__.load({
  id: '@local/eta-estimate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    /* react-dom is a standard browser-table module; degrade gracefully if absent. */
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch (error) { /* no portal: render bubble inline */ }

    const NS = 'eta-estimate';
    const MODE_KEY = 'eta-estimate.mode.v2';

    /**
     * v2 model, fitted on this machine's own session logs.
     *
     * Ground truth: 98 sessions / 251 completed turns / 1757 probe points, sampled
     * at 10..90% of each turn's WALL-CLOCK duration (not at step boundaries), so the
     * features match what a live pill can observe at an arbitrary instant.
     * "steps" = closed step/end events (the log's definition of a step).
     *
     *   log(remaining_seconds) =
     *       coef[0] + coef[1]*log(elapsed_seconds + 1) + coef[2]*log(steps_done + 1)
     *
     * Bands come from residual quantiles (q10/q90 => about 80% coverage). Fitted
     * with 5-fold cross-validation GROUPED BY SESSION (no turn from a test session
     * is used in training). See README.md for the full comparison table.
     *
     * Held-out backtest, same probe protocol:
     *   v1.2 (fixed 6.4s/step + step table) : 194% median relative error,
     *        2.94x median bias, 40% interval coverage, 103s median absolute error
     *   v2   (below)                       :  81% median relative error,
     *        0.99x median bias, 77% interval coverage,  32s median absolute error
     *
     * Remaining time is still intrinsically heavy-tailed (turn durations span
     * 0.3s .. 73min). No point predictor can be a reliable countdown, which is
     * why the DEFAULT pill shows deterministic facts instead (see display modes).
     */
    const MODEL = {
      coef: [0.281552, 1.000945, -0.269862],
      q10: -1.727042,
      q50: -0.022416,
      q90: 1.780031,
      sampleTurns: 251,
      sampleProbes: 1757,
      /* Empirical total-duration distribution, seconds, at percentilePoints. */
      percentilePoints: [0, 0.05, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95, 1],
      durationPercentiles: [0.3, 1.1, 5.3, 21.1, 37.2, 60.6, 90.8, 178.8, 306.3, 422.2, 733.2, 1229.6, 4399.4],
    };

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    /** Calibrated 80% band for remaining seconds, from elapsed seconds + closed steps. */
    function estimateRemaining(elapsedSec, stepsDone) {
      const el = Math.max(0, elapsedSec);
      const k = Math.max(0, Math.floor(stepsDone) || 0);
      const f = MODEL.coef[0]
        + MODEL.coef[1] * Math.log(el + 1)
        + MODEL.coef[2] * Math.log(k + 1);
      return {
        low: clamp(Math.exp(f + MODEL.q10), 0.5, 10800),
        mid: clamp(Math.exp(f + MODEL.q50), 0.5, 10800),
        high: clamp(Math.exp(f + MODEL.q90), 1, 10800),
      };
    }

    /** What fraction of past finished tasks were shorter than this elapsed time. */
    function elapsedPercentile(elapsedSec) {
      const pts = MODEL.percentilePoints;
      const vals = MODEL.durationPercentiles;
      if (elapsedSec <= vals[0]) return 0;
      for (let i = 1; i < vals.length; i += 1) {
        if (elapsedSec <= vals[i]) {
          const frac = (elapsedSec - vals[i - 1]) / Math.max(0.001, vals[i] - vals[i - 1]);
          return clamp(Math.round((pts[i - 1] + frac * (pts[i] - pts[i - 1])) * 100), 0, 99);
        }
      }
      return 99;
    }

    /** Coarse units: a second-accurate number here would be false precision. */
    function formatCoarse(sec, t) {
      if (sec < 30) return t('eta.under1m');
      if (sec < 60) return t('eta.sec', { n: String(Math.max(5, Math.round(sec / 5) * 5)) });
      const mins = sec / 60;
      if (mins < 2) return t('eta.min', { n: '1–2' });
      if (mins < 10) return t('eta.min', { n: String(Math.round(mins)) });
      return t('eta.min', { n: String(Math.round(mins / 5) * 5) });
    }

    function formatElapsed(sec, t) {
      if (sec < 60) return t('eta.sec', { n: String(Math.max(1, Math.round(sec))) });
      return t('eta.min', { n: String(Math.round(sec / 60)) });
    }

    const DICTS = {
      en: {
        'eta.range': '≈ {low}–{high} left',
        'eta.about': '≈ {v} left',
        'eta.soon': 'Almost done',
        'eta.plan': 'Task {done}/{total} · {elapsed} elapsed',
        'eta.facts': '{elapsed} elapsed · step {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n}m',
        'eta.under1m': 'under a minute',
        'eta.mode.progress': 'facts only',
        'eta.mode.estimate': 'time estimate',
        'eta.tip.basis': 'Based on {turns} past tasks, {probes} sample points',
        'eta.tip.coverage': 'About 80% of past tasks fall inside this range',
        'eta.tip.facts': 'Elapsed time and step count are exact, not estimates',
        'eta.tip.plan': 'Task progress is exact, not a prediction',
        'eta.tip.pct': 'Already longer than {pct}% of past tasks',
        'eta.tip.reference': 'Remaining time cannot be predicted precisely — rough guide only',
        'eta.tip.toggle': 'Click to switch to {next}',
      },
      zh: {
        'eta.range': '预计剩余 ≈ {low}–{high}',
        'eta.about': '预计剩余 ≈ {v}',
        'eta.soon': '预计即将完成',
        'eta.plan': '任务 {done}/{total} · 已用时 {elapsed}',
        'eta.facts': '已用时 {elapsed} · 第 {step} 步',
        'eta.sec': '{n} 秒',
        'eta.min': '{n} 分钟',
        'eta.under1m': '不到 1 分钟',
        'eta.mode.progress': '仅看进度',
        'eta.mode.estimate': '时间预估',
        'eta.tip.basis': '基于 {turns} 个历史任务、{probes} 个采样时点回测',
        'eta.tip.coverage': '约 80% 的历史任务剩余时间落在此区间',
        'eta.tip.facts': '已用时与步数是精确值，不含预测',
        'eta.tip.plan': '任务进度是确定值，不含预测',
        'eta.tip.pct': '本次已用时超过 {pct}% 的历史任务',
        'eta.tip.reference': '剩余时间无法精确预测，仅供参考',
        'eta.tip.toggle': '点击切换为「{next}」',
      },
      ja: {
        'eta.range': '残り ≈ {low}–{high}',
        'eta.about': '残り ≈ {v}',
        'eta.soon': 'まもなく完了',
        'eta.plan': 'タスク {done}/{total} · 経過 {elapsed}',
        'eta.facts': '経過 {elapsed} · ステップ {step}',
        'eta.sec': '{n}秒',
        'eta.min': '{n}分',
        'eta.under1m': '1分未満',
        'eta.mode.progress': '進捗のみ',
        'eta.mode.estimate': '残り時間',
        'eta.tip.basis': '過去 {turns} タスク、{probes} 時点で検証',
        'eta.tip.coverage': '約 80% の過去タスクがこの範囲に収まります',
        'eta.tip.facts': '経過時間とステップ数は実測値です',
        'eta.tip.plan': 'タスク進捗は実測値です',
        'eta.tip.pct': '過去タスクの {pct}% より長く経過',
        'eta.tip.reference': '残り時間は正確に予測できません。目安のみ',
        'eta.tip.toggle': 'クリックで「{next}」に切替',
      },
      es: {
        'eta.range': '≈ {low}–{high} restantes',
        'eta.about': '≈ {v} restantes',
        'eta.soon': 'Casi listo',
        'eta.plan': 'Tarea {done}/{total} · {elapsed} transcurridos',
        'eta.facts': '{elapsed} transcurridos · paso {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.under1m': 'menos de un minuto',
        'eta.mode.progress': 'solo progreso',
        'eta.mode.estimate': 'estimación de tiempo',
        'eta.tip.basis': 'Basado en {turns} tareas previas y {probes} puntos',
        'eta.tip.coverage': 'Cerca del 80% de las tareas previas cae en este rango',
        'eta.tip.facts': 'El tiempo transcurrido y los pasos son valores exactos',
        'eta.tip.plan': 'El progreso de la tarea es un valor exacto',
        'eta.tip.pct': 'Ya supera al {pct}% de las tareas previas',
        'eta.tip.reference': 'El tiempo restante no se puede predecir con precisión',
        'eta.tip.toggle': 'Haz clic para cambiar a «{next}»',
      },
      fr: {
        'eta.range': '≈ {low}–{high} restantes',
        'eta.about': '≈ {v} restantes',
        'eta.soon': 'Presque terminé',
        'eta.plan': 'Tâche {done}/{total} · {elapsed} écoulées',
        'eta.facts': '{elapsed} écoulées · étape {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.under1m': 'moins d’une minute',
        'eta.mode.progress': 'progression seule',
        'eta.mode.estimate': 'estimation du temps',
        'eta.tip.basis': 'Basé sur {turns} tâches passées et {probes} points',
        'eta.tip.coverage': 'Environ 80% des tâches passées tombent dans cette plage',
        'eta.tip.facts': 'Le temps écoulé et les étapes sont des valeurs exactes',
        'eta.tip.plan': 'La progression de la tâche est une valeur exacte',
        'eta.tip.pct': 'Déjà plus long que {pct}% des tâches passées',
        'eta.tip.reference': 'Le temps restant ne peut pas être prédit précisément',
        'eta.tip.toggle': 'Cliquez pour passer à « {next} »',
      },
      de: {
        'eta.range': '≈ {low}–{high} verbleibend',
        'eta.about': '≈ {v} verbleibend',
        'eta.soon': 'Fast fertig',
        'eta.plan': 'Aufgabe {done}/{total} · {elapsed} vergangen',
        'eta.facts': '{elapsed} vergangen · Schritt {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} Min.',
        'eta.under1m': 'unter einer Minute',
        'eta.mode.progress': 'nur Fortschritt',
        'eta.mode.estimate': 'Zeitschätzung',
        'eta.tip.basis': 'Basierend auf {turns} früheren Aufgaben, {probes} Messpunkten',
        'eta.tip.coverage': 'Rund 80% der früheren Aufgaben liegen in diesem Bereich',
        'eta.tip.facts': 'Vergangene Zeit und Schritte sind exakte Werte',
        'eta.tip.plan': 'Der Aufgabenfortschritt ist ein exakter Wert',
        'eta.tip.pct': 'Bereits länger als {pct}% der früheren Aufgaben',
        'eta.tip.reference': 'Die Restzeit lässt sich nicht genau vorhersagen',
        'eta.tip.toggle': 'Klicken, um zu „{next}“ zu wechseln',
      },
      ru: {
        'eta.range': '≈ {low}–{high} осталось',
        'eta.about': '≈ {v} осталось',
        'eta.soon': 'Почти готово',
        'eta.plan': 'Задача {done}/{total} · прошло {elapsed}',
        'eta.facts': 'Прошло {elapsed} · шаг {step}',
        'eta.sec': '{n}с',
        'eta.min': '{n} мин',
        'eta.under1m': 'меньше минуты',
        'eta.mode.progress': 'только прогресс',
        'eta.mode.estimate': 'оценка времени',
        'eta.tip.basis': 'По {turns} прошлым задачам и {probes} точкам',
        'eta.tip.coverage': 'Около 80% прошлых задач попадают в этот диапазон',
        'eta.tip.facts': 'Прошедшее время и число шагов — точные значения',
        'eta.tip.plan': 'Прогресс задачи — точное значение',
        'eta.tip.pct': 'Уже дольше {pct}% прошлых задач',
        'eta.tip.reference': 'Оставшееся время нельзя предсказать точно',
        'eta.tip.toggle': 'Нажмите, чтобы переключить на «{next}»',
      },
      pt: {
        'eta.range': '≈ {low}–{high} restantes',
        'eta.about': '≈ {v} restantes',
        'eta.soon': 'Quase concluído',
        'eta.plan': 'Tarefa {done}/{total} · {elapsed} decorridos',
        'eta.facts': '{elapsed} decorridos · passo {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.under1m': 'menos de um minuto',
        'eta.mode.progress': 'apenas progresso',
        'eta.mode.estimate': 'estimativa de tempo',
        'eta.tip.basis': 'Com base em {turns} tarefas anteriores e {probes} pontos',
        'eta.tip.coverage': 'Cerca de 80% das tarefas anteriores caem neste intervalo',
        'eta.tip.facts': 'Tempo decorrido e passos são valores exatos',
        'eta.tip.plan': 'O progresso da tarefa é um valor exato',
        'eta.tip.pct': 'Já mais longo que {pct}% das tarefas anteriores',
        'eta.tip.reference': 'O tempo restante não pode ser previsto com precisão',
        'eta.tip.toggle': 'Clique para mudar para «{next}»',
      },
    };

    function fallbackTranslate() {
      return function (key, vars) {
        const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en';
        const table = DICTS[lang.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'] || DICTS.en;
        let text = (table && table[key]) || DICTS.en[key] || key;
        if (vars) {
          for (const name in vars) {
            if (Object.prototype.hasOwnProperty.call(vars, name)) {
              text = text.split('{' + name + '}').join(String(vars[name]));
            }
          }
        }
        return text;
      };
    }

    /**
     * Copied from the shipped StatsPills.module.css and Tooltip.module.css, with
     * class names renamed under this plugin's prefix. Only DSH theme variables
     * are referenced, so light/dark switching and font-size settings follow the
     * host automatically. The Harness primitives package is deliberately NOT
     * required: it changes without notice and a throwing import would blank the
     * whole slot entry.
     */
    const CSS = [
      '.dshEta_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.dshEta_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dshEta_pill svg{flex:none;width:14px;height:14px}',
      'button.dshEta_pill,.dshEta_pill[role=button]{cursor:pointer}',
      '.dshEta_pill[role=button]:focus-visible{outline:1px solid var(--dsw-alias-interactive-bg-hover);outline-offset:1px}',
      '@media (hover:hover){.dshEta_pill[role=button]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.dshEta_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dshEta_tipBubble{display:inline-flex;align-items:safe center;gap:8px;position:fixed;z-index:1100;width:max-content;box-sizing:border-box;max-width:min(50vw,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;animation:dshEta_tipIn .15s var(--ds-ease-in-out,ease-in-out);transform:translate(-50%,-100%)}',
      '.dshEta_tipLabel{min-width:0}',
      '@keyframes dshEta_tipIn{0%{opacity:0}}',
      '@media(prefers-reduced-motion:reduce){.dshEta_tipBubble{animation:none}}',
    ].join('');

    /** The shipped clock-outline regular icon (16x16, 1px stroke, currentColor). */
    function ClockIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16,
        fill: 'none', strokeWidth: 1,
        'data-icon': 'clock-outline', 'aria-hidden': 'true',
      },
        h('path', {
          d: 'M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z',
          stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8 4.31V8.46L11 10.08',
          stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round',
        })
      );
    }

    /** A small copy of the host Tooltip: hover/focus, side=top, portal to body. */
    function createTooltip() {
      return function Tooltip(props) {
        const label = props.label;
        const children = props.children;
        const state = React.useState(false);
        const open = state[0];
        const setOpen = state[1];
        const rectState = React.useState(null);
        const rect = rectState[0];
        const setRect = rectState[1];
        const timer = React.useRef(null);
        const anchor = React.useRef(null);
        const bubbleId = React.useId ? React.useId() : 'dshEta_tip';

        const clear = function () {
          if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
        };
        const show = function () {
          const el = anchor.current;
          if (el === null) return;
          setRect(el.getBoundingClientRect());
          setOpen(true);
        };
        const schedule = function () {
          clear();
          timer.current = setTimeout(show, 200);
        };
        const dismiss = function () {
          clear();
          setOpen(false);
          setRect(null);
        };

        React.useEffect(function () { return function () { clear(); }; }, []);
        React.useEffect(function () {
          if (!open) return undefined;
          const onKey = function (event) {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
          };
          document.addEventListener('keydown', onKey, true);
          return function () { document.removeEventListener('keydown', onKey, true); };
        }, [open]);

        const bubble = (open && rect !== null)
          ? h('span', {
            id: bubbleId,
            className: 'dshEta_tipBubble',
            'data-side': 'top',
            'data-portal': 'true',
            'data-align': 'center',
            role: 'tooltip',
            style: {
              left: rect.left + rect.width / 2,
              top: Math.max(12, rect.top - 8),
              visibility: 'visible',
            },
          }, h('span', { className: 'dshEta_tipLabel' }, label))
          : null;

        const trigger = React.cloneElement(children, {
          ref: anchor,
          'aria-describedby': open ? bubbleId : undefined,
          onPointerEnter: function (event) {
            if (children.props.onPointerEnter) children.props.onPointerEnter(event);
            if (event.pointerType !== 'touch') schedule();
          },
          onPointerLeave: function (event) {
            if (children.props.onPointerLeave) children.props.onPointerLeave(event);
            clear(); setOpen(false); setRect(null);
          },
          onClick: function (event) {
            if (children.props.onClick) children.props.onClick(event);
            clear(); show();
          },
          onFocus: function (event) {
            if (children.props.onFocus) children.props.onFocus(event);
            schedule();
          },
          onBlur: function (event) {
            if (children.props.onBlur) children.props.onBlur(event);
            clear(); setOpen(false); setRect(null);
          },
        });

        const portal = (bubble !== null && ReactDOM && typeof ReactDOM.createPortal === 'function')
          ? ReactDOM.createPortal(bubble, document.body)
          : bubble;
        return h(React.Fragment, null, trigger, portal);
      };
    }

    /** Count closed steps of a turn from the live timeline (step/end equivalent). */
    function closedSteps(timeline, turn) {
      if (!timeline || !timeline.turns || typeof timeline.turns.get !== 'function') return null;
      let record = null;
      try { record = timeline.turns.get(turn); } catch (error) { return null; }
      const steps = record && record.steps;
      if (!steps) return null;
      let n = 0;
      const visit = function (s) {
        if (!s) return;
        if (s.status === 'closed' || (s.end && typeof s.end.time === 'number')) n += 1;
      };
      try {
        if (Array.isArray(steps)) { for (let i = 0; i < steps.length; i += 1) visit(steps[i]); }
        else if (typeof steps.forEach === 'function') { steps.forEach(function (s) { visit(s); }); }
        else return null;
      } catch (error) { return null; }
      return n;
    }

    /** Deterministic plan progress, when the agent published a todo list. */
    function planInfo(todos) {
      if (!todos) return null;
      if (!Array.isArray(todos)) {
        if (Array.isArray(todos.todos)) todos = todos.todos;
        else if (Array.isArray(todos.items)) todos = todos.items;
        else return null;
      }
      let total = 0;
      let done = 0;
      let active = 0;
      for (let i = 0; i < todos.length; i += 1) {
        const item = todos[i];
        if (!item || item.status === 'deleted') continue;
        total += 1;
        if (item.status === 'completed') done += 1;
        else if (item.status === 'in_progress') active += 1;
      }
      if (total < 2 || done >= total || (done === 0 && active === 0)) return null;
      return { total: total, done: done, active: active };
    }

    function createEtaPill(t, Tooltip) {
      return function EtaPill(props) {
        const running = props.useSession((s) => Boolean(s && s.running));
        const timings = props.useChat((s) => (s && s.legacy ? s.legacy.turnTimings : null));
        const timeline = props.useChat((s) => (s ? s.timeline : null));
        /* FIX: partial lives at s.legacy.partial, NOT s.partial (v1 read the wrong key). */
        const partial = props.useChat((s) => (s && s.legacy ? s.legacy.partial : null));
        const nodes = props.useChat((s) => (s && s.legacy ? s.legacy.nodes : null));
        /* useProjection is a standard composer.dock prop. Always call exactly one
         * function so React hook order stays stable even if the prop is absent. */
        const readProjection = typeof props.useProjection === 'function'
          ? props.useProjection
          : function () { return null; };
        const todos = readProjection('todos');

        const modeState = React.useState(function () {
          try { return window.localStorage.getItem(MODE_KEY) === 'estimate' ? 'estimate' : 'progress'; }
          catch (error) { return 'progress'; }
        });
        const mode = modeState[0];
        const setMode = modeState[1];

        const nowState = React.useState(function () { return Date.now(); });
        const now = nowState[0];
        const setNow = nowState[1];

        React.useEffect(function () {
          if (!running) return undefined;
          setNow(Date.now());
          const timer = setInterval(function () { setNow(Date.now()); }, 1000);
          return function () { clearInterval(timer); };
        }, [running]);

        if (!running) return null;

        let openTurn = null;
        let sampleCount = 0;
        if (timings && typeof timings.forEach === 'function') {
          timings.forEach(function (info, turn) {
            if (!info || typeof info.startTime !== 'number') return;
            if (typeof info.endTime === 'number') sampleCount += 1;
            else openTurn = { turn: turn, startTime: info.startTime };
          });
        }
        if (!openTurn) return null;

        /* Exact count of step/end events so the model's x-axis matches the log. */
        let stepsDone = closedSteps(timeline, openTurn.turn);
        if (stepsDone === null && partial && partial.turn === openTurn.turn && typeof partial.step === 'number') {
          stepsDone = Math.max(0, partial.step - 1);
        }
        if (stepsDone === null && nodes) {
          let finalized = 0;
          try {
            for (const node of nodes) {
              if (node && node.kind === 'assistant' && node.turn === openTurn.turn) finalized += 1;
            }
          } catch (error) { /* ignore */ }
          stepsDone = finalized;
        }
        if (stepsDone === null) stepsDone = 0;

        const elapsedMs = Math.max(0, now - openTurn.startTime);
        const elapsedSec = elapsedMs / 1000;
        const plan = planInfo(todos);
        const est = estimateRemaining(elapsedSec, stepsDone);
        const pct = elapsedPercentile(elapsedSec);
        const elapsedText = formatElapsed(elapsedSec, t);
        const nextMode = mode === 'progress' ? t('eta.mode.estimate') : t('eta.mode.progress');

        let label;
        let tooltip;
        if (mode === 'progress' && plan) {
          label = t('eta.plan', { done: String(plan.done), total: String(plan.total), elapsed: elapsedText });
          tooltip = t('eta.tip.plan')
            + ' · ' + t('eta.tip.pct', { pct: String(pct) })
            + ' · ' + t('eta.tip.basis', { turns: String(MODEL.sampleTurns), probes: String(MODEL.sampleProbes) })
            + ' · ' + t('eta.tip.toggle', { next: nextMode });
        } else if (mode === 'progress') {
          label = t('eta.facts', { elapsed: elapsedText, step: String(stepsDone) });
          tooltip = t('eta.tip.facts')
            + ' · ' + t('eta.tip.pct', { pct: String(pct) })
            + ' · ' + t('eta.tip.basis', { turns: String(MODEL.sampleTurns), probes: String(MODEL.sampleProbes) })
            + ' · ' + t('eta.tip.toggle', { next: nextMode });
        } else {
          const lowText = formatCoarse(est.low, t);
          const highText = formatCoarse(est.high, t);
          if (est.mid < 15) {
            label = t('eta.soon');
          } else if (lowText === highText) {
            label = t('eta.about', { v: lowText });
          } else {
            label = t('eta.range', { low: lowText, high: highText });
          }
          tooltip = t('eta.tip.coverage')
            + ' · ' + t('eta.tip.basis', { turns: String(MODEL.sampleTurns), probes: String(MODEL.sampleProbes) })
            + ' · ' + t('eta.tip.reference')
            + ' · ' + t('eta.tip.facts')
            + ' · ' + t('eta.tip.toggle', { next: nextMode });
        }

        const toggleMode = function () {
          const next = mode === 'progress' ? 'estimate' : 'progress';
          setMode(next);
          try { window.localStorage.setItem(MODE_KEY, next); } catch (error) { /* storage optional */ }
        };

        /* Same DOM shape as the host's PlainPill. */
        return h(
          React.Fragment,
          null,
          h('style', null, CSS),
          h('span', { className: 'dshEta_anchor', 'data-composer-stat': 'eta-estimate' },
            h(Tooltip, { label: tooltip },
              h('span', {
                className: 'dshEta_pill',
                role: 'button',
                tabIndex: 0,
                'aria-label': tooltip,
                onClick: toggleMode,
                onKeyDown: function (event) {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleMode(); }
                },
              },
                h(ClockIcon, null),
                h('span', { className: 'dshEta_label' }, label)
              )
            )
          )
        );
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');
        let t;
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          try {
            ctx.effect(function () { return locale.register(NS, DICTS); }, 'eta-estimate: dictionaries');
          } catch (error) {
            console.error('eta-estimate: dictionary registration failed', error);
          }
          t = locale.bind(NS);
        } else {
          t = fallbackTranslate();
        }

        const Tooltip = createTooltip();
        const Pill = createEtaPill(t, Tooltip);
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'eta-estimate',
            order: 2,
          }, Pill);
        });
      },
    };
  },
});
