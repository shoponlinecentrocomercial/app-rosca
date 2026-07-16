'use strict';
// Máquina de estados de La Rosca (UMD). Lógica PURA y determinista: cero
// DOM, cero WebSocket, cero reloj. La MISMA corre con autoridad total en el
// cliente (1P / hot-seat, requisito offline de la app) y en el servidor
// (online). Toda la aleatoriedad sale de un RNG con semilla guardado en el
// propio estado (rngState), así que una partida queda determinada por
// (seed, acciones) — mismo espíritu que el motor sin Math.random del
// pingpong. Los temporizadores NO viven aquí: el caller (servidor o bucle
// offline) consulta timeoutFor() y aplica {t:'timeout'} cuando toca.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Game = factory(root.Board, root.Questions);
})(typeof self !== 'undefined' ? self : this, function (BoardArg, QuestionsArg) {
  const Board = BoardArg || (typeof require === 'function' ? require('./board.js') : null);
  const Questions = QuestionsArg || (typeof require === 'function' ? require('./questions.js') : null);

  // Ganchos de test (?test=1 en el cliente): cola FIFO que suplanta el RNG
  // solo para el dado. En producción queda vacía.
  const _forceDice = [];

  // mulberry32 sobre g.rngState: rápido, suficiente y serializable.
  function rand(g) {
    g.rngState = (g.rngState + 0x6D2B79F5) | 0;
    let t = g.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const randInt = (g, n) => Math.floor(rand(g) * n);

  function shuffled(g, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(g, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ------------------------------------------------------------- creación

  // players: [{seat, name}] — seat es el identificador autoritativo (en
  // online pueden no ser consecutivos si la sala tiene huecos).
  function create(opts) {
    const g = {
      mode: opts.mode === 'rapida' ? 'rapida' : 'clasica',
      // el override solo lo usan los tests (ROSCA_TEST_MEDALS) para llegar
      // a la pregunta final sin jugar una partida entera
      medalsNeeded: Number.isInteger(opts.medalsNeeded) && opts.medalsNeeded > 0
        ? opts.medalsNeeded
        : (opts.mode === 'rapida' ? 3 : 6),
      rngState: (opts.seed | 0) || 1,
      phase: 'roll',
      turn: 0,           // SEAT del jugador al que le toca (no índice)
      players: opts.players.map(p => ({
        seat: p.seat,
        name: p.name,
        node: Board.CENTER, // todas las fichas salen del centro
        medals: [false, false, false, false, false, false],
        alive: true,
        failsByCat: [0, 0, 0, 0, 0, 0],
        mustLeaveCenter: false,
      })),
      dice: null,
      destinations: null,
      chooser: null,      // seat que elige la categoría de la pregunta final
      question: null,     // {cat, text, options[4], correct, final}
      decks: null,        // 6 mazos de índices barajados (anti-repetición)
      lastResult: null,
      winner: null,
    };
    g.decks = Board.CATS.map((_, c) => shuffled(g, Questions.byCat[c].map((q, i) => i)));
    g.turn = g.players[randInt(g, g.players.length)].seat;
    return g;
  }

  // ------------------------------------------------------------- helpers

  const P = (g, seat) => g.players.find(p => p.seat === seat);
  const alive = g => g.players.filter(p => p.alive);

  function nextAliveSeat(g, seat) {
    const order = g.players.map(p => p.seat);
    let i = order.indexOf(seat);
    for (let n = 0; n < order.length; n++) {
      i = (i + 1) % order.length;
      if (P(g, order[i]).alive) return order[i];
    }
    return seat;
  }

  const medalsComplete = (g, pl) => pl.medals.filter(Boolean).length >= g.medalsNeeded;

  // A quién le toca actuar en la fase actual.
  function actor(g) {
    if (g.phase === 'gameover') return null;
    if (g.phase === 'finalcat') return g.chooser;
    return g.turn;
  }

  // Extrae y sirve una pregunta de la categoría: mazo barajado con pop(),
  // rebarajado si se agota. Las 4 opciones se barajan AQUÍ (en el archivo la
  // correcta siempre es la posición 0, así ni el orden delata nada).
  function serveQuestion(g, cat, final) {
    if (!g.decks[cat].length) {
      g.decks[cat] = shuffled(g, Questions.byCat[cat].map((q, i) => i));
    }
    const raw = Questions.byCat[cat][g.decks[cat].pop()];
    const order = shuffled(g, [0, 1, 2, 3]);
    g.question = {
      cat,
      text: raw[0],
      options: order.map(i => raw[1 + i]),
      correct: order.indexOf(0),
      final,
    };
    g.phase = 'question';
  }

  // ------------------------------------------------------------- apply

  // Única puerta de entrada: valida actor y fase, muta g y devuelve la lista
  // de eventos para la UI/sonido, o null si la acción es ilegal (se ignora
  // en silencio, como las acciones fuera de turno en el billar).
  function apply(g, seat, action) {
    if (!g || !action || typeof action.t !== 'string') return null;
    if (g.phase === 'gameover') return null;

    // 'leave' es especial: vale en cualquier fase y para cualquier asiento
    // (desconexión online). El resto exige ser el actor de la fase.
    if (action.t === 'leave') return doLeave(g, seat);
    if (seat !== actor(g)) return null;

    const events = [];
    const pl = P(g, g.turn);

    switch (g.phase) {
      case 'roll': {
        if (action.t !== 'roll' && action.t !== 'timeout') return null;
        g.dice = _forceDice.length ? _forceDice.shift() : 1 + randInt(g, 6);
        let dests = Board.destinations(pl.node, g.dice);
        // El que falló la pregunta final debe salir del centro y volver a
        // entrar con cuenta exacta. Por la regla de no-retroceso ningún
        // camino vuelve al centro en la misma tirada, pero el filtro deja
        // la garantía explícita.
        if (pl.mustLeaveCenter) dests = dests.filter(d => d !== Board.CENTER);
        g.destinations = dests;
        g.phase = 'move';
        events.push({ t: 'rolled', seat: g.turn, dice: g.dice, destinations: dests });
        return events;
      }

      case 'move': {
        let node;
        if (action.t === 'dest') node = action.node;
        else if (action.t === 'timeout') node = g.destinations[randInt(g, g.destinations.length)];
        else return null;
        if (!g.destinations.includes(node)) return null;
        const path = Board.pathBetween(pl.node, g.dice, node);
        if (pl.node === Board.CENTER) pl.mustLeaveCenter = false;
        pl.node = node;
        g.destinations = null;
        events.push({ t: 'moved', seat: g.turn, node, path });

        const def = Board.NODES[node];
        if (def.kind === 'center') {
          if (medalsComplete(g, pl)) {
            // pregunta final: la categoría la elige el siguiente jugador
            // vivo (contra bots, el bot elige la peor del humano)
            g.chooser = nextAliveSeat(g, g.turn);
            g.phase = 'finalcat';
            events.push({ t: 'finalcat', chooser: g.chooser });
          } else {
            // el centro es comodín: eliges tú la categoría (sin medalla)
            g.phase = 'wildcat';
            events.push({ t: 'wildcat', seat: g.turn });
          }
        } else if (def.special === 'reroll') {
          g.phase = 'roll';
          events.push({ t: 'reroll', seat: g.turn });
        } else {
          serveQuestion(g, def.cat, false);
          events.push({ t: 'question', seat: g.turn, cat: def.cat, final: false });
        }
        return events;
      }

      case 'wildcat': {
        let cat;
        if (action.t === 'wildcat') cat = action.cat;
        else if (action.t === 'timeout') cat = randInt(g, 6);
        else return null;
        if (!(cat >= 0 && cat < 6)) return null;
        serveQuestion(g, cat, false);
        events.push({ t: 'question', seat: g.turn, cat, final: false });
        return events;
      }

      case 'finalcat': {
        let cat;
        if (action.t === 'finalcat') cat = action.cat;
        else if (action.t === 'timeout') cat = randInt(g, 6);
        else return null;
        if (!(cat >= 0 && cat < 6)) return null;
        g.chooser = null;
        serveQuestion(g, cat, true);
        events.push({ t: 'question', seat: g.turn, cat, final: true });
        return events;
      }

      case 'question': {
        let idx;
        if (action.t === 'answer') idx = action.idx;
        else if (action.t === 'timeout') idx = -1; // no responder = fallo
        else return null;
        if (idx !== -1 && !(idx >= 0 && idx < 4)) return null;
        const q = g.question;
        const ok = idx === q.correct;
        let medalCat = null;
        if (ok) {
          const def = Board.NODES[pl.node];
          if (def.plaza !== null && !pl.medals[def.plaza]) {
            pl.medals[def.plaza] = true;
            medalCat = def.plaza;
            events.push({ t: 'medal', seat: g.turn, cat: def.plaza });
          }
          if (q.final) g.winner = g.turn;
        } else {
          pl.failsByCat[q.cat]++;
          if (q.final) pl.mustLeaveCenter = true;
        }
        g.lastResult = { seat: g.turn, ok, correct: q.correct, answered: idx, medalCat, final: q.final, cat: q.cat };
        g.question = null;
        g.phase = 'result';
        events.push({ t: 'answered', seat: g.turn, ok, correct: g.lastResult.correct, answered: idx, medalCat, final: g.lastResult.final });
        return events;
      }

      case 'result': {
        if (action.t !== 'continue' && action.t !== 'timeout') return null;
        g.dice = null;
        if (g.winner !== null) {
          g.phase = 'gameover';
          events.push({ t: 'gameover', winner: g.winner });
        } else if (g.lastResult && g.lastResult.ok) {
          g.phase = 'roll'; // acierta → repite turno, como el clásico
        } else {
          g.turn = nextAliveSeat(g, g.turn);
          g.phase = 'roll';
          events.push({ t: 'turn', seat: g.turn });
        }
        return events;
      }
    }
    return null;
  }

  // Desconexión: el jugador sale de la rotación sin abortar la partida.
  function doLeave(g, seat) {
    const pl = P(g, seat);
    if (!pl || !pl.alive) return null;
    pl.alive = false;
    const events = [{ t: 'left', seat }];
    const rest = alive(g);
    if (rest.length === 1) {
      g.winner = rest[0].seat;
      g.phase = 'gameover';
      events.push({ t: 'gameover', winner: g.winner, byDefault: true });
      return events;
    }
    // si era su turno (o le tocaba elegir la categoría final), avanzar
    if (g.chooser === seat) {
      g.chooser = nextAliveSeat(g, seat);
      events.push({ t: 'finalcat', chooser: g.chooser });
    } else if (g.turn === seat) {
      g.turn = nextAliveSeat(g, seat);
      g.dice = null;
      g.destinations = null;
      g.question = null;
      g.chooser = null;
      g.phase = 'roll';
      events.push({ t: 'turn', seat: g.turn });
    }
    return events;
  }

  // Snapshot público: lo que puede ver cualquier cliente. NUNCA incluye el
  // índice de la respuesta correcta de la pregunta en curso ni los mazos
  // (anti-chuletas online); la correcta se revela en lastResult al resolver.
  function view(g) {
    return {
      mode: g.mode,
      medalsNeeded: g.medalsNeeded,
      phase: g.phase,
      turn: g.turn,
      players: g.players.map(p => ({
        seat: p.seat, name: p.name, node: p.node, medals: p.medals.slice(),
        alive: p.alive, failsByCat: p.failsByCat.slice(), mustLeaveCenter: p.mustLeaveCenter,
      })),
      dice: g.dice,
      destinations: g.destinations ? g.destinations.slice() : null,
      chooser: g.chooser,
      question: g.question
        ? { cat: g.question.cat, text: g.question.text, options: g.question.options.slice(), final: g.question.final }
        : null,
      lastResult: g.lastResult,
      winner: g.winner,
    };
  }

  // Duración de cada fase para el que arma los temporizadores (ms). El
  // bucle offline solo usa 'question' y 'result'; el servidor, todas.
  function timeoutFor(phase, test) {
    const base = { roll: 30000, move: 30000, wildcat: 20000, finalcat: 20000, question: 20000, result: 2500 };
    const quick = { roll: 2000, move: 2000, wildcat: 2000, finalcat: 2000, question: 2000, result: 300 };
    return (test ? quick : base)[phase] || 0;
  }

  return { create, apply, actor, view, timeoutFor, _forceDice };
});
