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
      * v2.1 model, fitted on this machine's own session logs.
      *
      * Ground truth: 175 sessions / 530 completed turns / 3710 probe points,
      * sampled at 10..90% of each turn's WALL-CLOCK duration (not at step
      * boundaries), so the features match what a live pill can observe at an
      * arbitrary instant. "steps" = closed step/end events (the log's
      * definition of a step).
      *
      *   log(remaining_seconds) =
      *       coef[0]
      *       + coef[1] * log(elapsed_seconds + 1)
      *       + coef[2] * log(steps_done + 1)
      *       + coef[3] * log(max(0.3, median_duration_of_closed_steps_this_turn_s))
      *       + coef[4] * log(open_step_elapsed_seconds + 1)
      *
      * v2.1 adds two features over v2:
      *   - median step pace for THIS turn (closed steps only, 0.3 s floor to
      *     match the offline fit) captures how fast the agent is actually
      *     working right now, instead of relying on a global 6.4 s/step avg.
      *   - time already spent in the currently-open step (0 if none) captures
      *     that a step that has been running for a long time is likely a long
      *     step, which the elapsed-time feature alone misses when steps are
      *     uneven.
      *
      * Bands come from residual quantiles (q10/q90 => about 80% coverage).
      * Fitted with 5-fold cross-validation GROUPED BY SESSION (no turn from a
      * test session is used in training). See README.md for the full
      * comparison table.
      *
      * Held-out backtest, same probe protocol (probes at 10..90% wall-clock):
      *   v1.2 (fixed 6.4s/step + step table) : 194% median relative error,
      *        2.94x median bias, 40% interval coverage, 103s median abs error
      *   v2   (elapsed + steps only)         :  81% median relative error,
      *        0.99x median bias,  77% interval coverage,  32s median abs error
      *   v2.1 (elapsed + steps + live pace + open step)
      *                                          :  72% median relative error
      *        (probe-level),  70% per-turn median-of-medians,
      *        84% interval coverage
      *
      * Remaining time is still intrinsically heavy-tailed (turn durations span
      * 0.1s .. 73min). No point predictor can be a reliable countdown, which
      * is why the DEFAULT pill shows deterministic facts instead (see display
      * modes).
      */
    const MODEL = {
      /* v2.1 coefficients, target = log(remaining_seconds), features in the
       * order [1, log(elapsed+1), log(steps+1), log(max(0.3,medStepSec)),
       * log(openStepSec+1)]. */
      coef: [0.671179, 1.16403, -0.483348, -0.301716, -0.037698],
      q10: -1.776758,
      q50: 0.043074,
      q90: 1.685939,
      sampleTurns: 530,
      sampleProbes: 3710,
      /* Empirical total-duration distribution, seconds, at percentilePoints.
       * Refit on the 175-session dataset (Nov 2025). */
      percentilePoints: [0, 0.05, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95, 1],
      durationPercentiles: [0.1, 1.5, 7.2, 18.1, 33.7, 57.9, 91.0, 164.6, 287.1, 448.7, 749.9, 1109.8, 4399.4],
    };

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    /** Calibrated 80% band for remaining seconds.
      *
      * @param {number} elapsedSec  - wall-clock seconds since the turn started
      * @param {number} stepsDone   - number of closed steps in this turn
      * @param {number} medStepSec  - median duration (s) of the closed steps in
      *                               this turn; 0 if fewer than one closed step
      * @param {number} openStepSec - seconds already spent in the currently-open
      *                               step; 0 if no step is open
      */
    function estimateRemaining(elapsedSec, stepsDone, medStepSec, openStepSec) {
      const el = Math.max(0, elapsedSec);
      const k = Math.max(0, Math.floor(stepsDone) || 0);
      const med = Math.max(0.3, medStepSec || 0); // 0.3 s floor matches the offline fit
      const osp = Math.max(0, openStepSec || 0);
      const f = MODEL.coef[0]
        + MODEL.coef[1] * Math.log(el + 1)
        + MODEL.coef[2] * Math.log(k + 1)
        + MODEL.coef[3] * Math.log(med)
        + MODEL.coef[4] * Math.log(osp + 1);
      return {
        low: clamp(Math.exp(f + MODEL.q10), 0.5, 10800),
        mid: clamp(Math.exp(f + MODEL.q50), 0.5, 10800),
        high: clamp(Math.exp(f + MODEL.q90), 1, 10800),
      };
    }


    /** Compact time: 45s → "45s", 95s → "2m", 650s → "11m". */
    function formatCompact(sec) {
      if (sec < 60) return String(Math.max(1, Math.round(sec))) + 's';
      const mins = sec / 60;
      if (mins < 10) return String(Math.round(mins)) + 'm';
      return String(Math.round(mins / 5) * 5) + 'm';
    }

    function formatElapsed(sec, t) {
      if (sec < 60) return t('eta.sec', { n: String(Math.max(1, Math.round(sec))) });
      return t('eta.min', { n: String(Math.round(sec / 60)) });
    }

    const DICTS = {
      en: {
        'eta.soon': 'Almost done',
        'eta.plan': 'Task {done}/{total} · {elapsed} elapsed',
        'eta.facts': '{elapsed} elapsed · step {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n}m',
        'eta.mode.progress': 'facts only',
        'eta.mode.estimate': 'time estimate',
        'eta.tip.toggle': 'Click to switch to {next}'
      },
      zh: {
        'eta.soon': '预计即将完成',
        'eta.plan': '任务 {done}/{total} · 已用时 {elapsed}',
        'eta.facts': '已用时 {elapsed} · 第 {step} 步',
        'eta.sec': '{n} 秒',
        'eta.min': '{n} 分钟',
        'eta.mode.progress': '仅看进度',
        'eta.mode.estimate': '时间预估',
        'eta.tip.toggle': '点击切换为「{next}」'
      },
      ja: {
        'eta.soon': 'まもなく完了',
        'eta.plan': 'タスク {done}/{total} · 経過 {elapsed}',
        'eta.facts': '経過 {elapsed} · ステップ {step}',
        'eta.sec': '{n}秒',
        'eta.min': '{n}分',
        'eta.mode.progress': '進捗のみ',
        'eta.mode.estimate': '残り時間',
        'eta.tip.toggle': 'クリックで「{next}」に切替'
      },
      es: {
        'eta.soon': 'Casi listo',
        'eta.plan': 'Tarea {done}/{total} · {elapsed} transcurridos',
        'eta.facts': '{elapsed} transcurridos · paso {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.mode.progress': 'solo progreso',
        'eta.mode.estimate': 'estimación de tiempo',
        'eta.tip.toggle': 'Haz clic para cambiar a «{next}»'
      },
      fr: {
        'eta.soon': 'Presque terminé',
        'eta.plan': 'Tâche {done}/{total} · {elapsed} écoulées',
        'eta.facts': '{elapsed} écoulées · étape {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.mode.progress': 'progression seule',
        'eta.mode.estimate': 'estimation du temps',
        'eta.tip.toggle': 'Cliquez pour passer à « {next} »'
      },
      de: {
        'eta.soon': 'Fast fertig',
        'eta.plan': 'Aufgabe {done}/{total} · {elapsed} vergangen',
        'eta.facts': '{elapsed} vergangen · Schritt {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} Min.',
        'eta.mode.progress': 'nur Fortschritt',
        'eta.mode.estimate': 'Zeitschätzung',
        'eta.tip.toggle': 'Klicken, um zu „{next}“ zu wechseln'
      },
      ru: {
        'eta.soon': 'Почти готово',
        'eta.plan': 'Задача {done}/{total} · прошло {elapsed}',
        'eta.facts': 'Прошло {elapsed} · шаг {step}',
        'eta.sec': '{n}с',
        'eta.min': '{n} мин',
        'eta.mode.progress': 'только прогресс',
        'eta.mode.estimate': 'оценка времени',
        'eta.tip.toggle': 'Нажмите, чтобы переключить на «{next}»'
      },
      pt: {
        'eta.soon': 'Quase concluído',
        'eta.plan': 'Tarefa {done}/{total} · {elapsed} decorridos',
        'eta.facts': '{elapsed} decorridos · passo {step}',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.mode.progress': 'apenas progresso',
        'eta.mode.estimate': 'estimativa de tempo',
        'eta.tip.toggle': 'Clique para mudar para «{next}»'
      }
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

    /** Read the live step list of a turn from the timeline.
      *
      * Returns { count, durations, openElapsed }:
      *   count      – number of closed steps (step/end equivalent)
      *   durations  – array of per-step wall-clock durations in seconds for the
      *                 closed steps (used to compute the live median pace)
      *   openElapsed– seconds already spent in the currently-open step, or 0
      *
      * `now` is Date.now() in milliseconds.
      */
    function stepTimings(timeline, turn, now) {
      if (!timeline || !timeline.turns || typeof timeline.turns.get !== 'function') {
        return { count: null, durations: null, openElapsed: 0 };
      }
      let record = null;
      try { record = timeline.turns.get(turn); } catch (error) { return { count: null, durations: null, openElapsed: 0 }; }
      const steps = record && record.steps;
      if (!steps) return { count: null, durations: null, openElapsed: 0 };

      const list = Array.isArray(steps)
        ? steps
        : (typeof steps.forEach === 'function' ? Array.from(steps) : null);
      if (!list) return { count: null, durations: null, openElapsed: 0 };

      let count = 0;
      const durations = [];
      let openElapsed = 0;

      for (let i = 0; i < list.length; i += 1) {
        const s = list[i];
        if (!s) continue;
        const closed = s.status === 'closed' || (s.end && typeof s.end.time === 'number');
        if (closed) {
          count += 1;
          if (s.start && s.end && typeof s.start.time === 'number' && typeof s.end.time === 'number') {
            const dur = (s.end.time - s.start.time) / 1000;
            // ignore steps with implausibly long durations (suspended/cancelled)
            if (dur > 0 && dur < 600) durations.push(dur);
          }
        } else if (s.start && typeof s.start.time === 'number') {
          // open step: time since it started
          openElapsed = Math.max(0, (now - s.start.time) / 1000);
        }
      }
      return { count: count, durations: durations, openElapsed: openElapsed };
    }

    /** Median of a numeric array; returns null for an empty array. */
    function median(arr) {
      if (!arr || arr.length === 0) return null;
      const s = arr.slice().sort(function (a, b) { return a - b; });
      const mid = Math.floor(s.length / 2);
      return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
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
        const st = stepTimings(timeline, openTurn.turn, now);
        let stepsDone = st.count;
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
        const medStepSec = median(st.durations);
        const openStepSec = st.openElapsed;
        const plan = planInfo(todos);
        const est = estimateRemaining(elapsedSec, stepsDone, medStepSec, openStepSec);
        const elapsedText = formatElapsed(elapsedSec, t);
        const nextMode = mode === 'progress' ? t('eta.mode.estimate') : t('eta.mode.progress');

        let label;
        let tooltip;
        if (mode === 'progress' && plan) {
          label = t('eta.plan', { done: String(plan.done), total: String(plan.total), elapsed: elapsedText });
          tooltip = t('eta.tip.toggle', { next: nextMode });
        } else if (mode === 'progress') {
          label = t('eta.facts', { elapsed: elapsedText, step: String(stepsDone) });
          tooltip = t('eta.tip.toggle', { next: nextMode });
        } else {
          const lowC = formatCompact(est.low);
          const highC = formatCompact(est.high);
          if (est.mid < 15) {
            label = t('eta.soon');
          } else if (lowC === highC) {
            label = '≈ ' + lowC;
          } else {
            label = '≈ ' + lowC + '–' + highC;
          }
          tooltip = t('eta.tip.toggle', { next: nextMode });
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
