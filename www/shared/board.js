'use strict';
// Tablero de La Rosca (UMD, como cosmetics en los hermanos): SOLO datos y
// grafo, sin dibujo — lo usan el servidor (require) y el cliente (script).
//
// 61 nodos:
//   0-35   anillo de 36 casillas, en 6 sextantes de 6. La casilla 6k es la
//          "plaza" (casilla de medalla) de la categoría k.
//   36-59  6 radios de 4 casillas: id 36 + k*4 + j, con j=0 pegado a la
//          plaza 6k y j=3 pegado al centro.
//   60     el centro (comodín / pregunta final).
//
// El anillo se puede atravesar por el medio: el centro es un cruce que
// conecta los seis radios entre sí.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Board = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Parejas color-categoría deliberadamente distintas a las del trivial
  // clásico (allí geografía es azul, ciencia verde, historia amarillo…):
  // ningún par coincide, para no pisar su imagen registrada.
  const CATS = [
    { name: 'Mundo', topic: 'Geografía', color: '#3dbf6e' },
    { name: 'Crónica', topic: 'Historia', color: '#9b59d0' },
    { name: 'Laboratorio', topic: 'Ciencia y naturaleza', color: '#2fc1d6' },
    { name: 'Pantalla', topic: 'Cine, TV y música', color: '#e8c530' },
    { name: 'Tinta', topic: 'Arte y literatura', color: '#3f6fd8' },
    { name: 'Estadio', topic: 'Deporte y ocio', color: '#d84040' },
  ];

  const CENTER = 60;
  const NODES = [];

  // Anillo. Patrón del sextante k (posiciones 6k .. 6k+5):
  // [plaza(k), cat(k+2), ¡Otra vez!, cat(k+4), cat(k+1), cat(k+5)]
  // Así cada categoría aparece exactamente 4 veces en casillas normales del
  // anillo además de su plaza, y las 6 casillas "¡Otra vez!" quedan
  // equiespaciadas.
  for (let i = 0; i < 36; i++) {
    const k = Math.floor(i / 6), p = i % 6;
    const catByPos = [k, (k + 2) % 6, null, (k + 4) % 6, (k + 1) % 6, (k + 5) % 6];
    NODES.push({
      id: i,
      kind: 'ring',
      plaza: p === 0 ? k : null,
      cat: catByPos[p],
      special: p === 2 ? 'reroll' : null,
      neighbors: [(i + 1) % 36, (i + 35) % 36],
    });
  }

  // Radios. Categoría (k+1+j)%6: las cuatro del radio son distintas entre sí
  // y ninguna repite la de su plaza.
  for (let k = 0; k < 6; k++) {
    for (let j = 0; j < 4; j++) {
      const id = 36 + k * 4 + j;
      NODES.push({
        id,
        kind: 'spoke',
        plaza: null,
        cat: (k + 1 + j) % 6,
        special: null,
        neighbors: [j === 0 ? 6 * k : id - 1, j === 3 ? CENTER : id + 1],
      });
    }
  }

  // Centro: cruce de los seis radios.
  NODES.push({
    id: CENTER,
    kind: 'center',
    plaza: null,
    cat: null,
    special: null,
    neighbors: [39, 43, 47, 51, 55, 59],
  });

  // Conectar cada plaza con su radio.
  for (let k = 0; k < 6; k++) NODES[6 * k].neighbors.push(36 + 4 * k);

  // Destinos posibles desde `from` con una tirada de `steps`: caminos de
  // longitud EXACTA sin retroceder sobre la arista recién recorrida (sí se
  // puede volver a pasar por un nodo llegando por otro lado). El peor caso
  // (centro, 6 pasos) explora ~6·2^5 caminos: despreciable.
  function destinations(from, steps) {
    const out = new Set();
    (function walk(node, prev, left) {
      if (left === 0) { out.add(node); return; }
      for (const nb of NODES[node].neighbors) {
        if (nb === prev) continue;
        walk(nb, node, left - 1);
      }
    })(from, -1, steps);
    return [...out].sort((a, b) => a - b);
  }

  // Un camino concreto de longitud exacta entre dos nodos (mismas reglas que
  // destinations). Lo usa el cliente para animar el salto casilla a casilla;
  // devuelve [from, ..., to] o null si no existe.
  function pathBetween(from, steps, to) {
    let found = null;
    (function walk(node, prev, left, path) {
      if (found) return;
      if (left === 0) { if (node === to) found = path.slice(); return; }
      for (const nb of NODES[node].neighbors) {
        if (nb === prev) continue;
        path.push(nb);
        walk(nb, node, left - 1, path);
        path.pop();
        if (found) return;
      }
    })(from, -1, steps, [from]);
    return found;
  }

  // Posición normalizada de cada nodo en el círculo unidad (solo para
  // pintar): anillo en r=1, radios decreciendo hacia el centro (0,0).
  // La plaza 0 queda arriba del todo y se avanza en sentido horario.
  function nodePos(id) {
    if (id === CENTER) return { x: 0, y: 0 };
    const n = NODES[id];
    if (n.kind === 'ring') {
      const a = (id / 36) * Math.PI * 2 - Math.PI / 2;
      return { x: Math.cos(a), y: Math.sin(a) };
    }
    const k = Math.floor((id - 36) / 4), j = (id - 36) % 4;
    const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
    const r = [0.78, 0.59, 0.4, 0.21][j];
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  return { CATS, NODES, CENTER, destinations, pathBetween, nodePos };
});
