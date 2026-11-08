window.__ModuleLoader__.load({
  id: '@local/eta-estimate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'eta-estimate';

    /**
     * Empirical prior measured from 239 completed turns in this user's own
     * session logs: for each number of steps ALREADY completed, the P25/P50/P75
     * of how many steps remained. Backtested on the same data, this step-indexed
     * survival table beat every duration-only model (median error 79% vs 121%
     * for a median-minus-elapsed model, with a much narrower band).
     */
    const STEP_PRIOR = {0:[8.0,19.0,35.0],1:[7.0,18.0,34.0],2:[6.0,17.0,33.0],3:[5.5,17.0,33.0],4:[5.25,19.5,34.5],5:[5.0,19.0,34.5],6:[6.75,19.5,35.5],7:[7.5,19.0,36.0],8:[10.0,19.5,38.5],9:[10.0,20.0,39.0],10:[11.0,20.0,38.75],11:[10.75,19.0,38.25],12:[10.5,18.0,37.5],13:[10.25,17.0,36.75],14:[10.0,17.0,36.5],15:[9.0,16.0,36.0],16:[8.0,15.5,35.75],17:[7.5,15.0,35.5],18:[8.0,16.0,37.0],19:[8.0,17.0,36.0],20:[8.0,16.0,35.0],21:[7.0,16.0,34.5],22:[6.25,16.0,33.75],23:[6.0,16.0,33.0],24:[6.0,17.0,34.25],25:[5.0,17.0,33.75],26:[5.25,18.5,33.0],27:[6.25,20.0,37.25],28:[7.0,20.0,38.5],29:[7.0,19.5,38.75],30:[9.0,20.5,40.5],31:[10.0,21.5,40.5],32:[9.0,22.0,40.0],33:[10.0,22.0,42.5],34:[9.75,21.0,43.25],35:[11.0,20.0,46.5],36:[12.0,19.5,50.5],37:[11.0,19.0,52.0],38:[10.0,18.0,51.0],39:[9.5,19.0,50.5],40:[8.5,18.0,49.5],41:[9.0,18.0,49.0],42:[8.0,17.0,48.0],43:[9.5,16.0,48.0],44:[8.5,15.0,47.0],45:[7.5,14.0,46.0],46:[9.0,20.0,46.0],47:[8.0,19.0,45.0],48:[7.25,20.5,44.0],49:[7.0,21.0,43.0],50:[7.5,21.0,45.75],51:[7.5,21.0,48.5],52:[6.5,20.0,47.5],53:[5.5,19.0,46.5],54:[5.0,21.5,49.25],55:[11.5,34.0,62.0],56:[11.75,33.5,66.0],57:[10.75,32.5,65.0],58:[12.0,32.0,69.0],59:[16.5,33.0,74.0],60:[15.5,32.0,73.0]};
    const MAX_TABLE_STEP = 60;
    /** Median observed step duration (6.4s) across 4,913 measured steps. */
    const STEP_PACE_MS = 6400;
    /** Outward widening that lifts band coverage to roughly two thirds. */
    const WIDEN = 1.3;

    const DICTS = {
      en: {
        'eta.range': '≈ {low}–{high} left',
        'eta.soon': 'Almost done',
        'eta.late': 'May take a while longer',
        'eta.unknown': 'Remaining time hard to estimate',
        'eta.sec': '{n}s',
        'eta.min': '{n}m',
        'eta.under1m': 'under a minute',
        'eta.tip.basis': 'Typical for step {step} of a task, from {turns} past tasks',
        'eta.tip.wide': 'step count beyond past tasks; rougher',
        'eta.tip.reference': 'rough guide only — can be off by several times',
      },
      zh: {
        'eta.range': '预计剩余 ≈ {low}–{high}',
        'eta.soon': '预计即将完成',
        'eta.late': '可能还要一会儿',
        'eta.unknown': '剩余时间难以预估',
        'eta.sec': '{n} 秒',
        'eta.min': '{n} 分钟',
        'eta.under1m': '不到 1 分钟',
        'eta.tip.basis': '同类任务第 {step} 步时的常见耗时，样本 {turns} 个历史任务',
        'eta.tip.wide': '步数已超出历史样本范围，估算更粗略',
        'eta.tip.reference': '仅供参考，实际可能相差数倍',
      },
      ja: {
        'eta.range': '残り ≈ {low}–{high}',
        'eta.soon': 'まもなく完了',
        'eta.late': 'もう少し時間がかかりそうです',
        'eta.unknown': '残り時間は推定困難',
        'eta.sec': '{n}秒',
        'eta.min': '{n}分',
        'eta.under1m': '1分未満',
        'eta.tip.basis': '過去 {turns} タスクの第 {step} ステップ時点の一般的な所要時間',
        'eta.tip.wide': 'ステップ数が過去の範囲を超えているため、より粗い推定です',
        'eta.tip.reference': 'あくまで目安です。数倍ずれることがあります',
      },
      es: {
        'eta.range': '≈ {low}–{high} restantes',
        'eta.soon': 'Casi listo',
        'eta.late': 'Puede tardar algo más',
        'eta.unknown': 'Difícil estimar el tiempo restante',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.under1m': 'menos de un minuto',
        'eta.tip.basis': 'Habitual en el paso {step} de una tarea, según {turns} tareas anteriores',
        'eta.tip.wide': 'más pasos que en las tareas anteriores; estimación más gruesa',
        'eta.tip.reference': 'solo orientativo: puede fallar por varios múltiplos',
      },
      fr: {
        'eta.range': '≈ {low}–{high} restantes',
        'eta.soon': 'Presque terminé',
        'eta.late': 'Cela peut prendre encore un moment',
        'eta.unknown': 'Temps restant difficile à estimer',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.under1m': 'moins d’une minute',
        'eta.tip.basis': 'Habituel à l’étape {step} d’une tâche, d’après {turns} tâches passées',
        'eta.tip.wide': 'plus d’étapes que dans les tâches passées ; estimation plus grossière',
        'eta.tip.reference': 'simple repère : l’écart peut être de plusieurs fois',
      },
      de: {
        'eta.range': '≈ {low}–{high} verbleibend',
        'eta.soon': 'Fast fertig',
        'eta.late': 'Kann noch etwas dauern',
        'eta.unknown': 'Restzeit schwer schätzbar',
        'eta.sec': '{n}s',
        'eta.min': '{n} Min.',
        'eta.under1m': 'unter einer Minute',
        'eta.tip.basis': 'Üblich bei Schritt {step} einer Aufgabe, aus {turns} früheren Aufgaben',
        'eta.tip.wide': 'mehr Schritte als in früheren Aufgaben; gröbere Schätzung',
        'eta.tip.reference': 'nur ein Anhaltspunkt – Abweichung um ein Mehrfaches möglich',
      },
      ru: {
        'eta.range': '≈ {low}–{high} осталось',
        'eta.soon': 'Почти готово',
        'eta.late': 'Может занять ещё время',
        'eta.unknown': 'Оставшееся время трудно оценить',
        'eta.sec': '{n}с',
        'eta.min': '{n} мин',
        'eta.under1m': 'меньше минуты',
        'eta.tip.basis': 'Обычно на шаге {step} задачи, по {turns} прошлым задачам',
        'eta.tip.wide': 'шагов больше, чем в прошлых задачах; оценка грубее',
        'eta.tip.reference': 'лишь ориентир: расхождение может быть кратно',
      },
      pt: {
        'eta.range': '≈ {low}–{high} restantes',
        'eta.soon': 'Quase concluído',
        'eta.late': 'Pode demorar mais um pouco',
        'eta.unknown': 'Difícil estimar o tempo restante',
        'eta.sec': '{n}s',
        'eta.min': '{n} min',
        'eta.under1m': 'menos de um minuto',
        'eta.tip.basis': 'Habitual no passo {step} de uma tarefa, com base em {turns} tarefas anteriores',
        'eta.tip.wide': 'mais passos que nas tarefas anteriores; estimativa mais grosseira',
        'eta.tip.reference': 'apenas referência: pode variar várias vezes',
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

    const CSS = [
      '.dshEta_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.dshEta_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-secondary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dshEta_pill svg{flex:none;width:14px;height:14px}',
      '.dshEta_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
    ].join('');

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    /** Rounded to coarse units: a second-accurate number here would be false precision. */
    function formatCoarse(ms, t) {
      const secs = ms / 1000;
      if (secs < 30) return t('eta.under1m');
      if (secs < 60) return t('eta.sec', { n: String(Math.max(5, Math.round(secs / 5) * 5)) });
      const mins = secs / 60;
      if (mins < 2) return t('eta.min', { n: '1–2' });
      if (mins < 10) return t('eta.min', { n: String(Math.round(mins)) });
      return t('eta.min', { n: String(Math.round(mins / 5) * 5) });
    }

    /** Steps remaining quantiles for a given completed-step count. */
    function remainingSteps(k) {
      const key = clamp(k, 0, MAX_TABLE_STEP);
      const row = STEP_PRIOR[key];
      if (key < MAX_TABLE_STEP || k <= MAX_TABLE_STEP) {
        return { row: row, beyond: false };
      }
      const d = k - MAX_TABLE_STEP;
      return { row: [d * 0.5, d * 0.8, d * 1.8], beyond: true };
    }

    function createEtaPill(t) {
      return function EtaPill(props) {
        const running = props.useSession((s) => Boolean(s && s.running));
        const timings = props.useChat((s) => (s && s.legacy ? s.legacy.turnTimings : null));
        const nodes = props.useChat((s) => (s && s.legacy ? s.legacy.nodes : null));
        const partial = props.useChat((s) => (s ? s.partial : null));

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

        /* Steps completed in the running turn: the streaming step index is the
         * live signal; finalized assistant nodes of that turn are a floor. */
        let stepsDone = 0;
        if (partial && partial.turn === openTurn.turn && typeof partial.step === 'number') {
          stepsDone = Math.max(0, partial.step - 1);
        }
        if (nodes) {
          let finalized = 0;
          try {
            for (const node of nodes) {
              if (node && node.kind === 'assistant' && node.turn === openTurn.turn) finalized += 1;
            }
          } catch (error) {
            console.error('eta-estimate: node scan failed', error);
          }
          stepsDone = Math.max(stepsDone, finalized);
        }

        const elapsed = Math.max(0, now - openTurn.startTime);
        const info = remainingSteps(stepsDone);

        const remLow = info.row[0] * STEP_PACE_MS;
        const remMid = info.row[1] * STEP_PACE_MS;
        const remHigh = info.row[2] * STEP_PACE_MS;

        const low = Math.max(STEP_PACE_MS * 0.6, remLow / WIDEN);
        const high = Math.max(remHigh * WIDEN, remMid * 1.8);

        let label;
        if (remMid < 20000) {
          label = t('eta.soon');
        } else if (info.beyond && sampleCount === 0) {
          label = t('eta.unknown');
        } else if (elapsed > remHigh * 2.5 && elapsed > 180000) {
          label = t('eta.late');
        } else {
          label = t('eta.range', {
            low: formatCoarse(low, t),
            high: formatCoarse(high, t),
          });
        }

        const basis = t('eta.tip.basis', { step: String(stepsDone), turns: String(sampleCount) });
        const tooltip = basis
          + (info.beyond ? ' · ' + t('eta.tip.wide') : '')
          + ' · ' + t('eta.tip.reference');

        return h(
          React.Fragment,
          null,
          h('style', null, CSS),
          h(
            'span',
            { className: 'dshEta_anchor', 'data-composer-stat': 'eta-estimate', title: tooltip },
            h(
              'span',
              { className: 'dshEta_pill' },
              h(
                'svg',
                {
                  viewBox: '0 0 16 16', width: 14, height: 14,
                  fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
                  strokeLinecap: 'round', strokeLinejoin: 'round',
                  'aria-hidden': 'true',
                  style: { color: 'var(--dsw-alias-brand-primary)' },
                },
                h('path', { d: 'M4.5 2h7M4.5 14h7' }),
                h('path', { d: 'M5.5 2.6v2.1c0 1.3.7 2.5 1.8 3.1L8 8.2l.7-.4c1.1-.6 1.8-1.8 1.8-3.1V2.6' }),
                h('path', { d: 'M5.5 13.4v-2.1c0-1.3.7-2.5 1.8-3.1l.7-.4.7.4c1.1.6 1.8 1.8 1.8 3.1v2.1' }),
                h('path', { d: 'M6.7 11.2h2.6' })
              ),
              h('span', { className: 'dshEta_label' }, label)
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

        const Pill = createEtaPill(t);
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
