'use strict';
// Cliente completo de La Rosca: lobby, modos (1P bots / 2P local / online),
// render pixel-retro del tablero, actores por turnos, red, efectos y audio.
// Classic script (sin módulos): los tests de Playwright acceden a los
// let/const de nivel superior con page.evaluate directamente.

// ---------------------------------------------------------------- constantes

// Sistema de coordenadas LÓGICO de 384 px de ancho (herencia del antiguo
// pipeline pixel): toda la geometría (BOARD, nodePX, canvasPos y su
// hit-testing) sigue en unidades LW×LH, pero desde el rediseño "limpio" del
// tablero (jul-2026) ya NO hay offscreen de baja resolución: se dibuja
// directamente en el canvas visible con un transform ×(SCALE·DPR) y el
// suavizado ACTIVADO (tablero anti-aliased; el pixel-art queda para el
// lobby/HUD). La ALTURA es dinámica: 216 en horizontal y hasta 560 en
// vertical, donde la rosca crece para llenar el móvil en retrato.
const LW = 384, SCALE = 3;
let LH = 216;
const CANVAS_W = LW * SCALE;
let CANVAS_H = LH * SCALE;

// ?test=1: temporizadores cortos, bots sin pausa de "pensar" y saltos de
// ficha instantáneos, para que los tests de Playwright no esperen.
const TEST = new URLSearchParams(location.search).has('test');
const HOP_T = TEST ? 0.001 : 0.12; // seg por casilla del salto de ficha

// Cola FIFO que pisa el dado (solo tests): forceDice(4) desde evaluate.
function forceDice(n) { Game._forceDice.push(n); }

// ---------------------------------------------------------------- elementos

const $ = id => document.getElementById(id);
const canvas = $('screen');
// alpha:false — cada frame cubre el canvas entero con el tablero opaco, y un
// contexto sin canal alfa se compone más barato (cuenta en equipos modestos)
const ctx = canvas.getContext('2d', { alpha: false });

const DPR = Math.min(2, window.devicePixelRatio || 1);
// px de dispositivo por unidad lógica: lo usan el transform del ctx y el
// pre-render del tablero. OJO: las sombras del canvas (shadowBlur/offset) NO
// pasan por el transform — van en px de dispositivo, de ahí los `· REZ`.
const REZ = SCALE * DPR;

// Geometría del tablero en px LÓGICOS (LW×LH); la recalcula layout().
// En horizontal la rosca vive a la izquierda y el dado a la derecha; en
// vertical la rosca ocupa el ancho y el dado baja debajo.
let BOARD = { cx: 108, cy: 108, R: 92 };
let DICE_AT = { x: 300, y: 104 };
let layoutDone = false;

// Recalcula la altura interna según la orientación. Cambiar los atributos
// del canvas resetea su contexto, así que el setTransform/imageSmoothing se
// re-aplican aquí (único sitio, como en el pingpong).
function layout() {
  const portrait = window.innerHeight > window.innerWidth * 1.15;
  const target = portrait
    ? Math.max(420, Math.min(560, Math.round(LW * (window.innerHeight - 230) / Math.max(300, window.innerWidth))))
    : 216;
  // ojo: un <canvas> recién creado mide 300×150, no 0 — el "¿ya hicimos el
  // primer layout?" va en un flag explícito, no en boardCv.width
  if (layoutDone && target === LH) return;
  layoutDone = true;
  LH = target;
  CANVAS_H = LH * SCALE;
  canvas.width = Math.round(CANVAS_W * DPR);
  canvas.height = Math.round(CANVAS_H * DPR);
  // el ctx trabaja en unidades lógicas LW×LH con suavizado: es lo que da el
  // tablero nítido (antes: offscreen 384 + escalado ×3 sin suavizar)
  ctx.setTransform(REZ, 0, 0, REZ, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (portrait) {
    BOARD = { cx: 192, cy: 196, R: 170 };
    DICE_AT = { x: 192, y: LH - 72 };
  } else {
    BOARD = { cx: 108, cy: 108, R: 92 };
    DICE_AT = { x: 300, y: 104 };
  }
  spriteCache.clear(); // los tamaños de ficha/destino dependen de la orientación
  buildBoardCanvas();
}

// ---------------------------------------------------------------- estado

let mode = null;            // null | '1p' | 'local' | 'online'
let state = null;           // estado de Game (offline completo, online view)
let actors = {};            // seat -> {poll(g)} humano o bot (y humano online)
let mySeat = 0;
let cosm = [];              // {token, face} por asiento
let ws = null;
let roomCode = null;
let hostSeat = 0;
let started = false;        // online: la partida ha empezado
let rule = 'clasica';       // toggle del lobby: 'clasica' | 'rapida'
let botCount = 1;
let botLevel = null;
let offlineOpts = null;     // para la revancha offline
let nowT = 0;               // reloj del juego en segundos

let myToken = 0, myFace = 0;

// Temporizador de la fase actual (deadline en nowT). Offline solo corre
// para question/result; online el servidor es la autoridad y esto solo
// pinta la cuenta atrás que llega en los snapshots.
let phaseDeadline = 0;
let phaseTotal = 0;
let phaseKey = '';

// Animaciones de tablero (solo visual, el estado manda)
let anim = {
  hop: null,                // {seat, path:[ids], i, t} salto casilla a casilla
  dice: { rolling: 0, value: 1 },
  pulse: 0,
};
let selDest = 0;            // índice del destino enfocado (teclado/mando)
let shownQKey = '';         // qué pregunta/selector está ya en pantalla
let effects = [];
function addEffect(fx) { fx.t = 0; effects.push(fx); }

// ---------------------------------------------------------------- fuente pixel 3×5

const FONT = {
  A: ['010','101','111','101','101'], B: ['110','101','110','101','110'],
  C: ['011','100','100','100','011'], D: ['110','101','101','101','110'],
  E: ['111','100','110','100','111'], F: ['111','100','110','100','100'],
  G: ['011','100','101','101','011'], H: ['101','101','111','101','101'],
  I: ['111','010','010','010','111'], J: ['001','001','001','101','010'],
  K: ['101','110','100','110','101'], L: ['100','100','100','100','111'],
  M: ['101','111','101','101','101'], N: ['110','101','101','101','101'],
  O: ['010','101','101','101','010'], P: ['110','101','110','100','100'],
  Q: ['010','101','101','010','001'], R: ['110','101','110','110','101'],
  S: ['011','100','010','001','110'], T: ['111','010','010','010','010'],
  U: ['101','101','101','101','111'], V: ['101','101','101','101','010'],
  W: ['101','101','111','111','101'], X: ['101','101','010','101','101'],
  Y: ['101','101','010','010','010'], Z: ['111','001','010','100','111'],
  0: ['111','101','101','101','111'], 1: ['010','110','010','010','111'],
  2: ['111','001','111','100','111'], 3: ['111','001','011','001','111'],
  4: ['101','101','111','001','001'], 5: ['111','100','111','001','111'],
  6: ['111','100','111','101','111'], 7: ['111','001','001','010','010'],
  8: ['111','101','111','101','111'], 9: ['111','101','111','001','111'],
  '!': ['010','010','010','000','010'], '¡': ['010','000','010','010','010'],
  '?': ['110','001','010','000','010'],
  '-': ['000','000','111','000','000'], '.': ['000','000','000','000','010'],
  ' ': ['000','000','000','000','000'],
};

function drawPixelText(c, text, x, y, scale, color) {
  c.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) {
      for (let col = 0; col < 3; col++) {
        if (g[r][col] === '1') c.fillRect(cx + col * scale, y + r * scale, scale, scale);
      }
    }
    cx += 4 * scale;
  }
}
function pixelTextWidth(text, scale) { return text.length * 4 * scale - scale; }

// ---------------------------------------------------------------- utilidades de color

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = v => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = ch(n >> 16), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `rgb(${r},${g},${b})`;
}

// ---------------------------------------------------------------- dibujo del tablero

// Fuente del texto suave del canvas (banners, "¡Tira!", el "?" del centro):
// la misma pila que el DOM para que tablero y tarjeta se sientan una cosa.
const UI_FONT = '"Segoe UI", system-ui, sans-serif';

// Mezcla lineal de dos colores hex (t=0 → a, t=1 → b): atenúa los colores de
// categoría hacia el fondo para que 36 casillas no sean un muro saturado.
function mix(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16), b = parseInt(hexB.slice(1), 16);
  const ch = sh => Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function lumOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Deja como path actual un rectángulo redondeado (sin fill/stroke: el caller
// decide). arcTo y no roundRect() por compatibilidad con WebViews viejas.
function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Posición en px (lowres) de un nodo del tablero.
function nodePX(id) {
  const p = Board.nodePos(id);
  return { x: Math.round(BOARD.cx + p.x * BOARD.R), y: Math.round(BOARD.cy + p.y * BOARD.R) };
}

// Icono "¡Otra vez!" suave: flecha circular (arco de ~300° + punta) en
// dorado sobre casilla neutra — se lee como "repetir" de un vistazo.
function drawRerollSymbol(g, cx, cy, size, color) {
  g.save();
  g.translate(cx, cy);
  g.scale(size, size);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 0.15;
  g.lineCap = 'round';
  const r = 0.34, a0 = -Math.PI * 0.55, a1 = Math.PI * 1.15;
  g.beginPath();
  g.arc(0, 0, r, a0, a1);
  g.stroke();
  // punta de flecha tangente al final del arco
  const px = Math.cos(a1) * r, py = Math.sin(a1) * r;
  const tx = -Math.sin(a1), ty = Math.cos(a1);
  g.beginPath();
  g.moveTo(px + tx * 0.3, py + ty * 0.3);
  g.lineTo(px + Math.cos(a1) * 0.18, py + Math.sin(a1) * 0.18);
  g.lineTo(px - Math.cos(a1) * 0.18, py - Math.sin(a1) * 0.18);
  g.closePath();
  g.fill();
  g.restore();
}

// Iconos pixel 9×9 de las 6 categorías — desde el rediseño del tablero solo
// los usa el DOM (catIconEl: chips del HUD, tarjeta, selector, estadísticas),
// que sigue en pixel-art; el TABLERO usa las versiones suaves de
// drawCatSymbol. '#' = tinta, 'x' = detalle oscuro, '.' = nada: globo, reloj
// de arena, matraz, notas musicales, libro abierto y trofeo.
const CAT_ICON = [
  [ // 0 Mundo: globo terráqueo (ecuador + meridianos)
    '..##x##..',
    '.###x###.',
    '#x##x##x#',
    '#x##x##x#',
    'xxxxxxxxx',
    '#x##x##x#',
    '#x##x##x#',
    '.###x###.',
    '..##x##..',
  ],
  [ // 1 Crónica: reloj de arena (con la arena cayendo)
    '#########',
    '.#######.',
    '..#xxx#..',
    '...#x#...',
    '....#....',
    '...#x#...',
    '..##x##..',
    '.#xxxxx#.',
    '#########',
  ],
  [ // 2 Laboratorio: matraz con líquido
    '..#####..',
    '...###...',
    '...###...',
    '...###...',
    '..#####..',
    '.#######.',
    '.#xxxxx#.',
    '#xxxxxxx#',
    '#########',
  ],
  [ // 3 Pantalla: corcheas — la barra va ARRIBA A LA DERECHA de las
    // cabezas (asimetría a propósito: simétrico se leía como una "Π")
    '..#######',
    '..#######',
    '..#.....#',
    '..#.....#',
    '..#.....#',
    '..#.....#',
    '###...###',
    '###...###',
    '###...###',
  ],
  [ // 4 Tinta: libro abierto (lomo oscuro al centro)
    '##.....##',
    '####.####',
    '####x####',
    '####x####',
    '####x####',
    '####x####',
    '####x####',
    '.###x###.',
    '..##x##..',
  ],
  [ // 5 Estadio: trofeo con asas (los huecos de las asas lo separan del
    // reloj de arena de Crónica, que era casi igual sin ellas)
    '#########',
    '#.#####.#',
    '#.#####.#',
    '.#.###.#.',
    '...###...',
    '....#....',
    '....#....',
    '..#####..',
    '.#######.',
  ],
];

// Tinta del icono según la luminancia del color de la categoría: sobre el
// amarillo de Pantalla la tinta blanca no contrasta, así que ahí va oscura.
function catInk(cat) {
  const col = Board.CATS[cat].color;
  const n = parseInt(col.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.7 ? shade(col, 0.32) : '#f6f6ee';
}

// Pinta el icono de la categoría centrado en (cx,cy) con u px por celda.
// Pensado para fondos del COLOR de la categoría (plaza del tablero, píldora
// de la tarjeta, medalla del chip); ink/detail se pueden pisar (medallas
// aún no ganadas del HUD, en gris fantasma).
function drawCatIcon(g, cat, cx, cy, u, ink, detail) {
  const bm = CAT_ICON[cat];
  const x0 = cx - Math.floor(9 * u / 2), y0 = cy - Math.floor(9 * u / 2);
  const inkCol = ink || catInk(cat);
  const detCol = detail || shade(Board.CATS[cat].color, 0.42);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const ch = bm[r][c];
      if (ch === '.') continue;
      g.fillStyle = ch === '#' ? inkCol : detCol;
      g.fillRect(x0 + c * u, y0 + r * u, u, u);
    }
  }
}

// Versión SUAVE de los 6 iconos de categoría (paths/arcos, anti-aliased):
// es la que va en el tablero, en TODAS las casillas — cada una se reconoce
// por símbolo además de por color. Mismos motivos que CAT_ICON para que
// tablero y DOM cuenten lo mismo: globo, reloj de arena, matraz, corcheas,
// libro abierto y trofeo. Dibuja centrado en (cx,cy) ocupando `size` px.
function drawCatSymbol(g, cat, cx, cy, size, ink) {
  const col = ink || catInk(cat);
  g.save();
  g.translate(cx, cy);
  g.scale(size, size);   // coordenadas normalizadas en [-0.5, 0.5]
  g.strokeStyle = col;
  g.fillStyle = col;
  g.lineWidth = 0.11;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (cat) {
    case 0: { // Mundo: globo (círculo + ecuador + meridiano)
      g.beginPath(); g.arc(0, 0, 0.42, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(-0.42, 0); g.lineTo(0.42, 0); g.stroke();
      g.beginPath(); g.ellipse(0, 0, 0.19, 0.42, 0, 0, Math.PI * 2); g.stroke();
      break;
    }
    case 1: { // Crónica: reloj de arena macizo
      g.beginPath();
      g.moveTo(-0.34, -0.46); g.lineTo(0.34, -0.46); g.lineTo(0.34, -0.3);
      g.lineTo(0.07, 0); g.lineTo(0.34, 0.3); g.lineTo(0.34, 0.46);
      g.lineTo(-0.34, 0.46); g.lineTo(-0.34, 0.3); g.lineTo(-0.07, 0);
      g.lineTo(-0.34, -0.3);
      g.closePath(); g.fill();
      break;
    }
    case 2: { // Laboratorio: matraz Erlenmeyer
      g.beginPath();
      g.moveTo(-0.13, -0.48); g.lineTo(0.13, -0.48); g.lineTo(0.13, -0.1);
      g.lineTo(0.38, 0.33);
      g.quadraticCurveTo(0.47, 0.5, 0.27, 0.5);
      g.lineTo(-0.27, 0.5);
      g.quadraticCurveTo(-0.47, 0.5, -0.38, 0.33);
      g.lineTo(-0.13, -0.1);
      g.closePath(); g.fill();
      break;
    }
    case 3: { // Pantalla: corcheas unidas (cabezas + plicas + barra)
      g.beginPath(); g.ellipse(-0.27, 0.33, 0.15, 0.11, -0.35, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(0.29, 0.25, 0.15, 0.11, -0.35, 0, Math.PI * 2); g.fill();
      g.lineWidth = 0.09;
      g.beginPath(); g.moveTo(-0.14, 0.3); g.lineTo(-0.14, -0.32); g.stroke();
      g.beginPath(); g.moveTo(0.42, 0.22); g.lineTo(0.42, -0.4); g.stroke();
      g.lineWidth = 0.17;
      g.beginPath(); g.moveTo(-0.16, -0.32); g.lineTo(0.44, -0.4); g.stroke();
      break;
    }
    case 4: { // Tinta: libro abierto (dos páginas con lomo al centro)
      g.beginPath();
      g.moveTo(-0.04, -0.16);
      g.quadraticCurveTo(-0.26, -0.36, -0.48, -0.27);
      g.lineTo(-0.48, 0.28);
      g.quadraticCurveTo(-0.26, 0.19, -0.04, 0.39);
      g.closePath(); g.fill();
      g.beginPath();
      g.moveTo(0.04, -0.16);
      g.quadraticCurveTo(0.26, -0.36, 0.48, -0.27);
      g.lineTo(0.48, 0.28);
      g.quadraticCurveTo(0.26, 0.19, 0.04, 0.39);
      g.closePath(); g.fill();
      break;
    }
    case 5: { // Estadio: trofeo (copa + asas + pie)
      g.beginPath();
      g.moveTo(-0.29, -0.48); g.lineTo(0.29, -0.48); g.lineTo(0.29, -0.16);
      g.quadraticCurveTo(0.29, 0.14, 0, 0.14);
      g.quadraticCurveTo(-0.29, 0.14, -0.29, -0.16);
      g.closePath(); g.fill();
      g.lineWidth = 0.09;
      g.beginPath(); g.arc(-0.32, -0.28, 0.15, Math.PI * 0.5, Math.PI * 1.5); g.stroke();
      g.beginPath(); g.arc(0.32, -0.28, 0.15, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
      g.fillRect(-0.06, 0.14, 0.12, 0.2);
      g.fillRect(-0.23, 0.34, 0.46, 0.14);
      break;
    }
  }
  g.restore();
}

// El tablero estático se pre-dibuja aquí a RESOLUCIÓN COMPLETA (LW·REZ) y
// draw() solo lo blitea: nunca se regenera por frame (mismo principio que
// los sprites del pingpong). El contexto usa el mismo transform lógico que
// el ctx visible, así que todo se dibuja en unidades LW×LH.
const boardCv = document.createElement('canvas');
function buildBoardCanvas() {
  boardCv.width = Math.round(LW * REZ);
  boardCv.height = Math.round(LH * REZ);
  const g = boardCv.getContext('2d');
  g.setTransform(REZ, 0, 0, REZ, 0, 0);
  g.imageSmoothingEnabled = true;
  const { cx, cy, R } = BOARD;
  const portrait = R >= 140;

  // sombras suaves bajo cada casilla (px de DISPOSITIVO: no pasan por el
  // transform, de ahí el · REZ); se apagan antes de pintar los iconos
  const shadowOn = () => {
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = 2.5 * REZ;
    g.shadowOffsetY = 1.2 * REZ;
  };
  const shadowOff = () => {
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
  };

  // fondo: tapete limpio con viñeta radial (sin motas: menos ruido)
  const bg = g.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 1.7);
  bg.addColorStop(0, '#1a2434');
  bg.addColorStop(1, '#0b101a');
  g.fillStyle = bg;
  g.fillRect(0, 0, LW, LH);

  // pista: anillo + radios tenues que conectan las casillas (sustituye a la
  // "masa" dorada gruesa: la geometría se sigue leyendo con mucho menos peso)
  g.strokeStyle = 'rgba(159,178,197,0.16)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.stroke();
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.lineTo(cx, cy);
    g.stroke();
  }

  // casillas: cuadrado redondeado con el color de la categoría ligeramente
  // atenuado hacia el fondo + su ICONO en tinta contrastada. Los gaps entre
  // casillas los pone el propio fondo (no se tocan entre sí).
  const cell = portrait ? 16 : 12;      // lado de la casilla normal
  const plazaR = portrait ? 12.5 : 9;   // radio de la insignia de plaza
  for (const n of Board.NODES) {
    if (n.kind === 'center') continue;
    const p = nodePX(n.id);
    const h = cell / 2;
    if (n.plaza !== null) {
      // plaza de medalla: INSIGNIA circular — anillo claro, disco del color
      // pleno y el icono grande. La forma redonda la distingue de las
      // casillas normales de la misma categoría de un vistazo.
      const col = Board.CATS[n.cat].color;
      shadowOn();
      g.beginPath();
      g.arc(p.x, p.y, plazaR + 1.8, 0, Math.PI * 2);
      g.fillStyle = '#f2f2ea';
      g.fill();
      shadowOff();
      g.beginPath();
      g.arc(p.x, p.y, plazaR, 0, Math.PI * 2);
      g.fillStyle = col;
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.2)';
      g.lineWidth = 1;
      g.stroke();
      drawCatSymbol(g, n.cat, p.x, p.y, plazaR * 1.25);
    } else if (n.special === 'reroll') {
      // "¡Otra vez!": casilla neutra oscura con la flecha circular dorada
      shadowOn();
      rrect(g, p.x - h, p.y - h, cell, cell, portrait ? 4.5 : 3.5);
      g.fillStyle = '#242f3f';
      g.fill();
      shadowOff();
      g.strokeStyle = 'rgba(240,197,65,0.4)';
      g.lineWidth = 1;
      g.stroke();
      drawRerollSymbol(g, p.x, p.y, cell * 0.68, '#f0c541');
    } else {
      const col = Board.CATS[n.cat].color;
      shadowOn();
      rrect(g, p.x - h, p.y - h, cell, cell, portrait ? 4.5 : 3.5);
      g.fillStyle = mix(col, '#101724', 0.18);
      g.fill();
      shadowOff();
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.lineWidth = 0.8;
      g.stroke();
      drawCatSymbol(g, n.cat, p.x, p.y, cell * 0.72);
    }
  }

  // centro: medallón dorado con la "?" del comodín / pregunta final
  const cR = portrait ? 18 : 13;
  shadowOn();
  g.beginPath();
  g.arc(cx, cy, cR + 1.8, 0, Math.PI * 2);
  g.fillStyle = '#f2f2ea';
  g.fill();
  shadowOff();
  const gold = g.createRadialGradient(cx - cR * 0.3, cy - cR * 0.4, cR * 0.15, cx, cy, cR);
  gold.addColorStop(0, '#f8d968');
  gold.addColorStop(1, '#dfae2d');
  g.beginPath();
  g.arc(cx, cy, cR, 0, Math.PI * 2);
  g.fillStyle = gold;
  g.fill();
  g.font = `800 ${Math.round(cR * 1.3)}px ${UI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#5a4210';
  g.fillText('?', cx, cy + cR * 0.08);
}

// ---------------------------------------------------------------- fichas

// Formas de ficha como bitmaps 7×7 ('#' = relleno): pixel-art puro, se
// escalan con u px por celda.
const SHAPE_PX = {
  round:    ['.#####.','#######','#######','#######','#######','#######','.#####.'],
  diamond:  ['...#...','..###..','.#####.','#######','.#####.','..###..','...#...'],
  star:     ['...#...','..###..','#######','.#####.','..###..','.##.##.','.#...#.'],
  shield:   ['#######','#######','#######','.#####.','.#####.','..###..','...#...'],
  drop:     ['...#...','..##...','..###..','.#####.','#######','#######','.#####.'],
  crown:    ['#..#..#','##.#.##','#######','#######','.#####.','.#####.','.#####.'],
  mushroom: ['..###..','.#####.','#######','#######','..###..','..###..','..###..'],
  ghost:    ['.#####.','#######','#######','#######','#######','#######','#.#.#.#'],
};

function drawTokenShape(g, tokenDef, x, y, u) {
  const bm = SHAPE_PX[tokenDef.shape] || SHAPE_PX.round;
  const draw = (col, dx, dy) => {
    g.fillStyle = col;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        if (bm[r][c] === '#') g.fillRect(x + (c - 3.5) * u + dx, y + (r - 3.5) * u + dy, u, u);
      }
    }
  };
  draw(tokenDef.trim, u, u);          // sombra/contorno desplazado
  draw(tokenDef.fill, 0, 0);
  // sombreado inferior
  g.fillStyle = tokenDef.trim;
  for (let c = 0; c < 7; c++) {
    for (let r = 6; r >= 0; r--) {
      if (bm[r][c] === '#') { g.fillRect(x + (c - 3.5) * u, y + (r - 3.5) * u, u, Math.ceil(u / 2)); break; }
    }
  }
  if (tokenDef.shape === 'ghost') {
    g.fillStyle = tokenDef.trim;
    g.fillRect(x + (2 - 3.5) * u, y + (2 - 3.5) * u, u, u);
    g.fillRect(x + (4 - 3.5) * u, y + (2 - 3.5) * u, u, u);
  }
}

// Silueta SUAVE de cada forma de ficha en espacio normalizado [-0.5, 0.5]
// (deja el path listo; el caller rellena/contornea). Mismas 8 formas que
// SHAPE_PX para que la ficha elegida en el lobby se reconozca en el tablero.
function tokenPath(g, shape) {
  g.beginPath();
  switch (shape) {
    case 'diamond':
      g.moveTo(0, -0.5); g.lineTo(0.5, 0); g.lineTo(0, 0.5); g.lineTo(-0.5, 0);
      break;
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 0.52 : 0.23;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      break;
    }
    case 'shield':
      g.moveTo(-0.44, -0.44); g.lineTo(0.44, -0.44); g.lineTo(0.44, 0.02);
      g.quadraticCurveTo(0.44, 0.32, 0, 0.5);
      g.quadraticCurveTo(-0.44, 0.32, -0.44, 0.02);
      break;
    case 'drop':
      g.moveTo(0, -0.52);
      g.quadraticCurveTo(0.42, -0.06, 0.42, 0.14);
      g.arc(0, 0.14, 0.42, 0, Math.PI);
      g.quadraticCurveTo(-0.42, -0.06, 0, -0.52);
      break;
    case 'crown':
      g.moveTo(-0.45, 0.42); g.lineTo(-0.45, -0.32); g.lineTo(-0.22, -0.06);
      g.lineTo(0, -0.5); g.lineTo(0.22, -0.06); g.lineTo(0.45, -0.32);
      g.lineTo(0.45, 0.42);
      break;
    case 'mushroom':
      g.moveTo(-0.5, 0.02);
      g.arc(0, 0.02, 0.5, Math.PI, Math.PI * 2);
      g.lineTo(0.2, 0.02); g.lineTo(0.2, 0.5); g.lineTo(-0.2, 0.5); g.lineTo(-0.2, 0.02);
      break;
    case 'ghost':
      g.moveTo(-0.45, 0.5); g.lineTo(-0.45, -0.02);
      g.arc(0, -0.02, 0.45, Math.PI, Math.PI * 2);
      g.lineTo(0.45, 0.5); g.lineTo(0.3, 0.36); g.lineTo(0.15, 0.5);
      g.lineTo(0, 0.36); g.lineTo(-0.15, 0.5); g.lineTo(-0.3, 0.36);
      break;
    default: // round
      g.arc(0, 0, 0.48, 0, Math.PI * 2);
  }
  g.closePath();
}

// Ficha del TABLERO: silueta suave con sombra, degradado y contorno claro
// para despegarla de las casillas y la INICIAL del jugador encima. `s` =
// tamaño total en px lógicos. NO se llama por frame: drawTokens la cachea
// como sprite (el halo dorado del jugador activo también es un sprite, ver
// allí). Si añades adornos aquí, entran gratis en la caché.
function drawTokenSmooth(g, def, x, y, s, opts) {
  const o = opts || {};
  g.save();
  g.translate(x, y);
  g.save();
  g.scale(s, s);
  // sombra proyectada (misma silueta desplazada: no depende del shadowBlur)
  g.save();
  g.translate(0.07, 0.11);
  tokenPath(g, def.shape);
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fill();
  g.restore();
  tokenPath(g, def.shape);
  const grad = g.createLinearGradient(0, -0.5, 0, 0.5);
  grad.addColorStop(0, def.fill);
  grad.addColorStop(1, mix(def.fill, def.trim, 0.55));
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 0.09;
  g.lineJoin = 'round';
  g.strokeStyle = '#f6f6ee';
  g.stroke();
  if (def.shape === 'ghost') {
    g.fillStyle = def.trim;
    g.beginPath(); g.arc(-0.15, -0.08, 0.07, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(0.15, -0.08, 0.07, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  if (o.initial) {
    const dark = lumOf(def.fill) > 0.62;
    g.font = `700 ${Math.round(s * 0.52)}px ${UI_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // borde en el tono opuesto: la letra se lee también sobre formas finas
    g.lineWidth = Math.max(1.5, s * 0.14);
    g.lineJoin = 'round';
    g.strokeStyle = dark ? 'rgba(246,246,238,0.85)' : 'rgba(16,21,29,0.75)';
    g.strokeText(o.initial, 0, s * 0.05);
    g.fillStyle = dark ? '#10151d' : '#ffffff';
    g.fillText(o.initial, 0, s * 0.05);
  }
  g.restore();
}

// Cara pixel para avatares (formato CHARACTERS del pingpong).
function drawFace(g, faceDef, size) {
  const s = size / 12;
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x * s, y * s, w * s, h * s); };
  px(2, 3, 8, 8, faceDef.skin);
  g.fillStyle = faceDef.hair;
  if (faceDef.hairStyle === 'spiky') { px(2, 1, 8, 2, faceDef.hair); px(1, 0, 2, 2, faceDef.hair); px(5, 0, 2, 2, faceDef.hair); px(9, 0, 2, 2, faceDef.hair); }
  else if (faceDef.hairStyle === 'bob') { px(1, 1, 10, 3, faceDef.hair); px(1, 4, 2, 5, faceDef.hair); px(9, 4, 2, 5, faceDef.hair); }
  else if (faceDef.hairStyle === 'pony') { px(2, 1, 8, 2, faceDef.hair); px(4, 0, 4, 1, faceDef.hair); px(9, 3, 2, 6, faceDef.hair); }
  else if (faceDef.hairStyle === 'cap') { px(1, 1, 10, 2, shade(faceDef.shirt, 0.8)); px(1, 3, 4, 1, shade(faceDef.shirt, 0.8)); }
  else px(2, 1, 8, 2, faceDef.hair);
  px(4, 6, 1.5, 1.5, '#181820'); px(7, 6, 1.5, 1.5, '#181820');
  px(5, 9, 3, 1, '#181820');
}

// ---------------------------------------------------------------- dado

// Dado suave: rectángulo redondeado con degradado y pips circulares.
// También lo usa el logo del lobby (allí sale pixelado por la baja
// resolución del canvas del logo, y encaja con su estética).
function drawDice(g, x, y, s, val) {
  const h = s / 2, r = s * 0.22;
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.4)';
  rrect(g, x - h + 1.5, y - h + 2.5, s, s, r);
  g.fill();
  const grad = g.createLinearGradient(x, y - h, x, y + h);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#d8d8e2');
  rrect(g, x - h, y - h, s, s, r);
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = '#aab0bd';
  g.lineWidth = 1;
  g.stroke();
  const o = s / 4.2, pr = s * 0.09;
  const pip = (dx, dy) => {
    g.beginPath();
    g.arc(x + dx, y + dy, pr, 0, Math.PI * 2);
    g.fillStyle = '#232a36';
    g.fill();
  };
  if (val % 2 === 1) pip(0, 0);
  if (val >= 2) { pip(-o, -o); pip(o, o); }
  if (val >= 4) { pip(o, -o); pip(-o, o); }
  if (val === 6) { pip(-o, 0); pip(o, 0); }
  g.restore();
}

// ---------------------------------------------------------------- sprites

// Lección del billar: regenerar gradientes/texto y sobre todo shadowBlur en
// CADA frame hunde el rendimiento en equipos modestos (canvas por software).
// Todo lo que draw() pinta encima del tablero se pre-renderiza aquí a
// resolución de dispositivo la primera vez y después es un drawImage por
// frame. layout() vacía la caché (los tamaños dependen de la orientación).
const spriteCache = new Map();
function sprite(key, w, h, paint) {
  let s = spriteCache.get(key);
  if (!s) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w * REZ));
    cv.height = Math.max(1, Math.ceil(h * REZ));
    const g = cv.getContext('2d');
    g.setTransform(REZ, 0, 0, REZ, 0, 0);
    g.translate(w / 2, h / 2);
    paint(g);
    s = { cv, w, h };
    spriteCache.set(key, s);
  }
  return s;
}

// Dibuja un sprite centrado en (x,y), opcionalmente escalado (px lógicos).
function blitSprite(g, s, x, y, scale) {
  const w = s.w * (scale || 1), h = s.h * (scale || 1);
  g.drawImage(s.cv, x - w / 2, y - h / 2, w, h);
}

// ---------------------------------------------------------------- dibujo por frame

function draw(dt) {
  const g = ctx;
  // sin clearRect: el pre-render del tablero es opaco y cubre el canvas
  // entero, así que el blit ya borra el frame anterior (un pase menos).
  // El pre-render está a resolución completa: al blitearlo sobre LW×LH con
  // el transform ×REZ del ctx queda 1:1 con los px de dispositivo (nítido)
  g.drawImage(boardCv, 0, 0, LW, LH);
  anim.pulse += dt * 5;
  if (state) {
    drawDestinations(g);
    drawTokens(g);
  }
  drawDiceArea(g);
  drawEffects(g, dt);
}

function drawDestinations(g) {
  if (!state || state.phase !== 'move' || !state.destinations) return;
  const iAct = Game.actor(state);
  const humanTurn = actors[iAct] && actors[iAct].isHuman;
  const portrait = BOARD.R >= 140;
  state.destinations.forEach((id, i) => {
    const focused = humanTurn && i === selDest;
    const p = nodePX(id);
    const n = Board.NODES[id];
    // marcador pre-renderizado (el glow es shadowBlur: carísimo por frame);
    // solo hay 3 formas × 2 estilos por orientación
    const kind = n.kind === 'center' ? 'c' : n.plaza !== null ? 'p' : 'q';
    let box, r = 0, sq = 0;
    if (kind === 'q') {
      sq = (portrait ? 16 : 12) + 5;
      box = sq + 14;
    } else {
      r = (kind === 'c' ? (portrait ? 18 : 13) : (portrait ? 12.5 : 9)) + 3.5;
      box = r * 2 + 14;
    }
    const spr = sprite(`dest|${kind}|${focused ? 1 : 0}|${portrait ? 1 : 0}`, box, box, dg => {
      dg.strokeStyle = focused ? '#ffffff' : '#f0c541';
      dg.lineWidth = focused ? 2.4 : 1.8;
      dg.shadowColor = focused ? 'rgba(255,255,255,0.8)' : 'rgba(240,197,65,0.8)';
      dg.shadowBlur = 3 * REZ;
      if (kind !== 'q') {
        dg.beginPath();
        dg.arc(0, 0, r, 0, Math.PI * 2);
      } else {
        rrect(dg, -sq / 2, -sq / 2, sq, sq, portrait ? 6 : 5);
      }
      dg.stroke();
    });
    g.save();
    // el enfocado va fijo y blanco; el resto respira en alfa (nada se apaga
    // del todo: los destinos siempre son visibles)
    g.globalAlpha = focused ? 1 : 0.58 + 0.26 * Math.sin(anim.pulse);
    blitSprite(g, spr, p.x, p.y);
    g.restore();
  });
}

// Reparto de fichas que comparten casilla: pequeños offsets fijos (se
// escalan un poco en vertical, donde las casillas son mayores).
const TOKEN_SPREAD = [[0, 0], [-6, -5], [6, -5], [-6, 5], [6, 5], [0, -8]];

function drawTokens(g) {
  if (!state) return;
  const portrait = BOARD.R >= 140;
  const s = portrait ? 17 : 13;           // tamaño de ficha (antes ~12 px)
  const spread = portrait ? 1.5 : 1.1;
  const active = state.phase !== 'gameover' ? state.turn : -1;
  const byNode = {};
  state.players.forEach(pl => {
    if (!pl.alive) return;
    (byNode[pl.node] = byNode[pl.node] || []).push(pl.seat);
  });
  // el jugador activo se dibuja el ÚLTIMO: su halo queda por encima cuando
  // varias fichas comparten casilla
  const order = state.players.filter(pl => pl.alive)
    .sort((a, b) => (a.seat === active ? 1 : 0) - (b.seat === active ? 1 : 0));
  for (const pl of order) {
    let px;
    if (anim.hop && anim.hop.seat === pl.seat) {
      px = hopPos();
    } else {
      const base = nodePX(pl.node);
      const group = byNode[pl.node];
      const idx = group.indexOf(pl.seat);
      const off = group.length > 1 ? TOKEN_SPREAD[idx % TOKEN_SPREAD.length] : [0, 0];
      px = { x: base.x + off[0] * spread, y: base.y + off[1] * spread };
    }
    const tokIdx = (cosm[pl.seat] && cosm[pl.seat].token) || 0;
    const def = Cosmetics.TOKENS[tokIdx];
    const cy = px.y - s * 0.22;
    if (pl.seat === active) {
      // halo dorado pulsante del jugador activo: sprite fijo re-escalado por
      // frame (el grosor del glow varía ~±8% con la escala, imperceptible);
      // regenerar su shadowBlur cada frame era lo más caro de todo el draw()
      const pr0 = s * 0.72 + 1;
      const halo = sprite(`halo|${s}`, (pr0 + 8) * 2, (pr0 + 8) * 2, hg => {
        hg.strokeStyle = 'rgba(240,197,65,0.95)';
        hg.lineWidth = 2;
        hg.shadowColor = 'rgba(240,197,65,0.9)';
        hg.shadowBlur = 4 * REZ;
        hg.beginPath();
        hg.arc(0, 0, pr0, 0, Math.PI * 2);
        hg.stroke();
      });
      blitSprite(g, halo, px.x, cy, (pr0 + Math.sin(anim.pulse) * 1.1) / pr0);
    }
    const initial = (pl.name || '?').trim().charAt(0).toUpperCase() || '?';
    const spr = sprite(`tok|${tokIdx}|${s}|${initial}`, s * 1.6, s * 1.6,
      tg => drawTokenSmooth(tg, def, 0, 0, s, { initial }));
    blitSprite(g, spr, px.x, cy);
    // medallas alrededor de la ficha: puntos de color con aro oscuro (un
    // icono a este tamaño no se lee)
    pl.medals.forEach((won, k) => {
      if (!won) return;
      const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
      const d = s * 0.62 + 1.5;
      const mx = px.x + Math.cos(a) * d;
      const my = cy + Math.sin(a) * d;
      g.beginPath(); g.arc(mx, my, portrait ? 3 : 2.4, 0, Math.PI * 2);
      g.fillStyle = '#0c1118'; g.fill();
      g.beginPath(); g.arc(mx, my, portrait ? 2.2 : 1.7, 0, Math.PI * 2);
      g.fillStyle = Board.CATS[k].color; g.fill();
    });
  }
}

// Posición interpolada del salto de ficha en curso (sin redondear: con el
// render suave el movimiento sub-píxel se ve fluido).
function hopPos() {
  const hp = anim.hop;
  const from = nodePX(hp.path[hp.i]);
  const to = nodePX(hp.path[Math.min(hp.i + 1, hp.path.length - 1)]);
  const t = Math.min(1, hp.t);
  const x = from.x + (to.x - from.x) * t;
  const y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 7;
  return { x, y };
}

function drawDiceArea(g) {
  const { x, y } = DICE_AT;
  const rolling = anim.dice.rolling > 0;
  const val = rolling ? 1 + (Math.floor(nowT * 19) % 6) : anim.dice.value;
  // 6 caras cacheadas (drawDice crea un gradiente: no va por frame); el
  // logo del lobby sí llama a drawDice en vivo — es otro ctx, pequeño
  blitSprite(g, sprite(`dice|${val}`, 34, 34, dg => drawDice(dg, 0, 0, 22, val)), x, y);
  if (state && state.phase === 'roll' && !rolling && !anim.hop) {
    const iAct = Game.actor(state);
    if (actors[iAct] && actors[iAct].isHuman) {
      g.save();
      g.font = `700 9px ${UI_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillStyle = Math.sin(anim.pulse) > 0 ? '#f0c541' : '#9fb2c5';
      g.fillText('¡Tira!', x, y + 15);
      g.restore();
    }
  }
}

function drawEffects(g, dt) {
  for (const fx of effects) fx.t += dt;
  effects = effects.filter(fx => fx.t < (fx.dur || 1));
  for (const fx of effects) {
    if (fx.kind === 'banner') {
      const y = LH * 0.44;
      g.save();
      g.font = `800 16px ${UI_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const w = g.measureText(fx.text).width;
      rrect(g, LW / 2 - w / 2 - 13, y - 13, w + 26, 26, 13);
      g.fillStyle = 'rgba(10,15,22,0.92)';
      g.fill();
      g.fillStyle = fx.color || '#f0c541';
      g.fillText(fx.text, LW / 2, y + 1);
      g.restore();
    } else if (fx.kind === 'confetti') {
      // geometría cacheada la primera vez (si se regenera por frame, parpadea)
      if (!fx.parts) {
        fx.parts = [];
        for (let i = 0; i < 80; i++) {
          fx.parts.push({
            x: Math.random() * LW, y: -10 - Math.random() * LH * 0.5,
            vy: 30 + Math.random() * 50, vx: -12 + Math.random() * 24,
            col: Board.CATS[i % 6].color, s: 2 + (i % 2),
          });
        }
      }
      for (const p of fx.parts) {
        const px = p.x + p.vx * fx.t, py = p.y + p.vy * fx.t + 20 * fx.t * fx.t;
        g.fillStyle = p.col;
        g.fillRect(Math.round(px), Math.round(py), p.s, p.s);
      }
    }
  }
}

// ---------------------------------------------------------------- audio

// WebAudio 100% procedural, sin ficheros (patrón de los hermanos).
let audioCtx = null;
let soundMuted = false;   // silenciar SOLO los efectos (independiente de la música)
function initAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* sin audio */ }
  }
}

function playSound(kind) {
  if (!audioCtx || soundMuted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t0 = audioCtx.currentTime;
  const out = audioCtx.destination;

  const noise = (dur, freq, vol, type) => {
    const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * dur), audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const f = audioCtx.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq;
    const gn = audioCtx.createGain(); gn.gain.value = vol;
    src.connect(f); f.connect(gn); gn.connect(out); src.start(t0);
  };
  const tone = (type, f0, f1, dur, vol, at) => {
    const o = audioCtx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0 + (at || 0));
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + (at || 0) + dur);
    const gn = audioCtx.createGain();
    gn.gain.setValueAtTime(vol, t0 + (at || 0));
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + (at || 0) + dur);
    o.connect(gn); gn.connect(out);
    o.start(t0 + (at || 0)); o.stop(t0 + (at || 0) + dur + 0.02);
  };

  if (kind === 'dice') {
    // traqueteo: tres golpecitos de ruido
    noise(0.05, 1800, 0.3); noise(0.05, 1200, 0.25);
    setTimeout(() => audioCtx && noise(0.05, 1500, 0.2), 90);
  } else if (kind === 'hop') {
    tone('square', 330, 520, 0.06, 0.08);
  } else if (kind === 'good') {
    [523, 659, 784].forEach((f, i) => tone('square', f, 0, 0.11, 0.12, i * 0.09));
  } else if (kind === 'bad') {
    tone('triangle', 330, 0, 0.16, 0.16); tone('triangle', 262, 0, 0.22, 0.16, 0.14);
  } else if (kind === 'medal') {
    [659, 784, 988, 1319].forEach((f, i) => tone('triangle', f, 0, 0.14, 0.16, i * 0.09));
    noise(0.2, 6000, 0.05, 'highpass');
  } else if (kind === 'win') {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone('triangle', f, 0, 0.25, 0.18, i * 0.12));
  } else if (kind === 'lose') {
    [392, 330, 262].forEach((f, i) => tone('triangle', f, 0, 0.28, 0.14, i * 0.15));
  } else if (kind === 'click') {
    tone('square', 700, 0, 0.03, 0.06);
  } else if (kind === 'tick') {
    tone('square', 900, 0, 0.03, 0.05);
  }
}

// ---------------------------------------------------------------- música chiptune

// Secuenciador WebAudio procedural (mismo esquema que el pingpong): melodía
// square, bajo triangle y hi-hat de ruido, 64 pasos en bucle. El botón 🔊
// (o la tecla M) silencia SOLO la música: pone musicGain a 0 y el
// secuenciador sigue — es barato y reanuda sin costuras.
let musicMuted = false;
let musicGain = null;
const music = { timer: null, step: 0, nextT: 0 };
const MUSIC_STEP = 60 / 122 / 2; // corcheas a 122 BPM

// notas MIDI (0 = silencio), 64 pasos = 8 compases. Melodía propia, aire de
// concurso de tele en Do mayor.
const LEAD = [
  72, 0, 76, 0, 79, 76, 79, 81, 84, 0, 79, 0, 76, 0, 72, 0,
  74, 0, 77, 0, 81, 77, 81, 83, 84, 81, 79, 76, 74, 0, 72, 0,
  72, 0, 76, 0, 79, 76, 79, 81, 84, 0, 88, 0, 86, 84, 81, 79,
  77, 79, 81, 0, 76, 79, 84, 0, 83, 81, 79, 77, 76, 74, 72, 0,
];
const BASSLINE = [
  48, 0, 52, 55, 48, 0, 52, 55, 48, 0, 52, 55, 48, 0, 55, 0,
  50, 0, 53, 57, 50, 0, 53, 57, 43, 0, 47, 50, 43, 0, 50, 0,
  48, 0, 52, 55, 48, 0, 52, 55, 45, 0, 48, 52, 45, 0, 52, 0,
  41, 0, 45, 48, 43, 0, 47, 50, 48, 0, 43, 0, 36, 0, 0, 0,
];
const midi2f = n => 440 * Math.pow(2, (n - 69) / 12);

function ensureMusicGain() {
  if (!audioCtx || musicGain) return;
  musicGain = audioCtx.createGain();
  musicGain.gain.value = musicMuted ? 0 : 1;
  musicGain.connect(audioCtx.destination);
}

function musicNote(type, freq, t, dur, vol) {
  const o = audioCtx.createOscillator(); o.type = type; o.frequency.value = freq;
  const gn = audioCtx.createGain();
  gn.gain.setValueAtTime(vol, t);
  gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(gn); gn.connect(musicGain);
  o.start(t); o.stop(t + dur + 0.02);
}

function scheduleMusic() {
  if (!audioCtx) return;
  while (music.nextT < audioCtx.currentTime + 0.35) { // lookahead clásico
    const t = music.nextT, s = music.step;
    if (LEAD[s]) musicNote('square', midi2f(LEAD[s]), t, MUSIC_STEP * 0.9, 0.03);
    if (BASSLINE[s]) musicNote('triangle', midi2f(BASSLINE[s]), t, MUSIC_STEP * 0.95, 0.055);
    if (s % 2 === 1) {
      const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.03), audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const f = audioCtx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
      const gn = audioCtx.createGain(); gn.gain.value = 0.04;
      src.connect(f); f.connect(gn); gn.connect(musicGain); src.start(t);
    }
    music.step = (music.step + 1) % LEAD.length;
    music.nextT += MUSIC_STEP;
  }
}

function startMusic() {
  initAudio();
  if (!audioCtx || music.timer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  ensureMusicGain();
  music.step = 0;
  music.nextT = audioCtx.currentTime + 0.1;
  music.timer = setInterval(scheduleMusic, 150);
}

function stopMusic() {
  if (music.timer) { clearInterval(music.timer); music.timer = null; }
}

function setMusicMuted(m) {
  musicMuted = m;
  if (musicGain) musicGain.gain.value = m ? 0 : 1;
  $('musicBtn').textContent = m ? '🔇' : '🔊';
}
$('musicBtn').addEventListener('click', () => setMusicMuted(!musicMuted));

// Botón de efectos de sonido (SFX), aparte del de música: playSound sale
// antes si soundMuted. Los efectos son de un disparo, así que basta el flag —
// no hace falta un nodo de ganancia como en la música.
function setSoundMuted(m) {
  soundMuted = m;
  $('soundBtn').textContent = m ? '🔕' : '🔔';
}
$('soundBtn').addEventListener('click', () => setSoundMuted(!soundMuted));

// ---------------------------------------------------------------- mandos (Gamepad API)

// Los mandos bluetooth/USB aparecen como gamepads normales. La cruceta o el
// stick mueven el foco (opciones de la tarjeta o destino en el tablero) y A
// (botón 0) confirma / tira el dado. En 2P local el mando 0 es J1 y el 1 J2.
let gamepadSeen = false;
window.addEventListener('gamepadconnected', () => {
  gamepadSeen = true;
  initAudio();
  setStatus('🎮 Mando conectado');
});

function pollGamepad(index) {
  if (!gamepadSeen || !navigator.getGamepads) return null;
  let n = 0;
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    if (n === index) return gp;
    n++;
  }
  return null;
}

// ---------------------------------------------------------------- tarjeta DOM

// La pregunta vive en DOM (no en canvas): el texto español con tildes no
// cabe en la FONT 3×5 y los botones nativos son táctiles y accesibles.
let cardKind = null; // null | 'question' | 'cats'
let cardEnabled = false;
let focusIdx = 0;

function hideCard() {
  $('qCard').classList.add('hidden');
  cardKind = null;
  cardEnabled = false;
}

// Mini-canvas DOM con el icono de una categoría (cabecera de la tarjeta,
// selector de categoría y medallas del chip). u px por celda; con withBg
// pinta una "loseta" del color de la categoría con las esquinas mordidas.
function catIconEl(cat, u, withBg) {
  const cv = document.createElement('canvas');
  const s = (withBg ? 13 : 9) * u;
  cv.width = s; cv.height = s;
  cv.className = 'catIcon';
  const g = cv.getContext('2d');
  if (withBg) {
    g.fillStyle = Board.CATS[cat].color;
    g.fillRect(0, 0, s, s);
    g.clearRect(0, 0, u, u); g.clearRect(s - u, 0, u, u);
    g.clearRect(0, s - u, u, u); g.clearRect(s - u, s - u, u, u);
  }
  drawCatIcon(g, cat, Math.floor(s / 2), Math.floor(s / 2), u);
  return cv;
}

function showQuestion(q) {
  curQ = { cat: q.cat }; // para adjudicar el acierto/fallo por color en las estadísticas
  const actSeat = state.turn;
  const isMe = actors[actSeat] && actors[actSeat].isHuman;
  // píldora de categoría: icono grande + nombre sobre el color
  const catEl = $('qCat');
  catEl.textContent = '';
  catEl.appendChild(catIconEl(q.cat, 2));
  catEl.appendChild(document.createTextNode(Board.CATS[q.cat].name + (q.final ? ' · FINAL' : '')));
  catEl.style.background = Board.CATS[q.cat].color;
  $('qWho').textContent = isMe ? nameOf(actSeat) : 'Responde ' + nameOf(actSeat) + '…';
  $('qText').textContent = q.text;
  const box = $('qOpts');
  box.innerHTML = '';
  q.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.textContent = opt;
    b.disabled = !isMe;
    b.addEventListener('click', () => { if (cardEnabled) uiAction({ t: 'answer', idx: i }); });
    box.appendChild(b);
  });
  focusIdx = -1;
  cardKind = 'question';
  cardEnabled = isMe;
  $('qTimebar').style.visibility = 'visible';
  $('qCard').classList.remove('hidden');
}

// Selector de categoría (centro comodín o pregunta final).
function showCatChooser(final) {
  const actSeat = final ? state.chooser : state.turn;
  const isMe = actors[actSeat] && actors[actSeat].isHuman;
  const forSeat = final ? state.turn : actSeat;
  $('qCat').textContent = final ? 'PREGUNTA FINAL' : 'CENTRO · COMODIN';
  $('qCat').style.background = '#f0c541';
  $('qWho').textContent = isMe ? nameOf(actSeat) : 'Elige ' + nameOf(actSeat) + '…';
  $('qText').textContent = final
    ? `¿De qué categoría será la pregunta final de ${nameOf(forSeat)}?`
    : 'El centro es comodín: elige categoría.';
  const box = $('qOpts');
  box.innerHTML = '';
  Board.CATS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'opt';
    // loseta con el icono + nombre: se elige por símbolo, no solo por color
    b.appendChild(catIconEl(i, 2, true));
    const label = document.createElement('span');
    label.textContent = c.name + ' · ' + c.topic;
    b.appendChild(label);
    b.style.borderColor = c.color;
    b.disabled = !isMe;
    b.addEventListener('click', () => {
      if (cardEnabled) uiAction(final ? { t: 'finalcat', cat: i } : { t: 'wildcat', cat: i });
    });
    box.appendChild(b);
  });
  focusIdx = -1;
  cardKind = 'cats';
  cardEnabled = isMe;
  $('qTimebar').style.visibility = 'visible';
  $('qCard').classList.remove('hidden');
}

// Revela la respuesta (fase result): verde la buena, roja la elegida mala.
function revealAnswer(res) {
  const btns = $('qOpts').children;
  if (cardKind !== 'question' || !btns.length) return;
  cardEnabled = false;
  for (let i = 0; i < btns.length; i++) {
    btns[i].disabled = true;
    btns[i].classList.remove('focused');
    if (i === res.correct) btns[i].classList.add('good');
    else if (i === res.answered) btns[i].classList.add('bad');
  }
  $('qTimebar').style.visibility = 'hidden';
}

function setCardFocus(idx) {
  const btns = $('qOpts').children;
  if (!btns.length) return;
  focusIdx = ((idx % btns.length) + btns.length) % btns.length;
  for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('focused', i === focusIdx);
}

// ---------------------------------------------------------------- HUD DOM

function setStatus(text) { $('status').textContent = text; }
function nameOf(seat) {
  const pl = state && state.players.find(p => p.seat === seat);
  return pl ? pl.name : '—';
}

// Chips de jugadores: avatar, nombre y las 6 medallas. Se reconstruye por
// evento (no por frame).
function updatePlayersBar() {
  const box = $('players');
  box.innerHTML = '';
  if (!state) return;
  for (const pl of state.players) {
    const div = document.createElement('div');
    div.className = 'plq' + (pl.seat === state.turn && state.phase !== 'gameover' ? ' active' : '') + (pl.alive ? '' : ' dead');
    const av = document.createElement('canvas');
    av.width = 22; av.height = 22;
    const g = av.getContext('2d');
    g.imageSmoothingEnabled = false;
    drawFace(g, Cosmetics.FACES[(cosm[pl.seat] && cosm[pl.seat].face) || 0], 22);
    div.appendChild(av);
    const tok = document.createElement('canvas');
    tok.width = 18; tok.height = 18;
    const tg = tok.getContext('2d');
    tg.imageSmoothingEnabled = false;
    drawTokenShape(tg, Cosmetics.TOKENS[(cosm[pl.seat] && cosm[pl.seat].token) || 0], 8, 8, 2);
    div.appendChild(tok);
    const nm = document.createElement('span');
    nm.className = 'qname';
    nm.textContent = pl.name;
    div.appendChild(nm);
    const med = document.createElement('span');
    med.className = 'medals';
    // medallas de 13 px con el icono de su categoría (antes puntos de 9 px
    // solo-color); la no ganada lleva el icono "fantasma" en gris: también
    // se ve QUÉ falta, no solo cuántas
    pl.medals.forEach((won, k) => {
      let mv;
      if (won) {
        mv = catIconEl(k, 1, true);
      } else {
        mv = document.createElement('canvas');
        mv.width = 13; mv.height = 13;
        mv.className = 'catIcon';
        const mg = mv.getContext('2d');
        mg.fillStyle = '#2a3446';
        mg.fillRect(0, 0, 13, 13);
        mg.clearRect(0, 0, 1, 1); mg.clearRect(12, 0, 1, 1);
        mg.clearRect(0, 12, 1, 1); mg.clearRect(12, 12, 1, 1);
        drawCatIcon(mg, k, 6, 6, 1, '#4d5f76', '#222c3b');
      }
      med.appendChild(mv);
    });
    div.appendChild(med);
    box.appendChild(div);
  }
}

function showOver(winner) {
  const win = mode === 'online' ? winner === mySeat : actors[winner] && actors[winner].isHuman;
  $('overText').textContent = `🏆 ¡Gana ${nameOf(winner)}!`;
  $('overMsg').classList.remove('hidden');
  addEffect({ kind: 'confetti', dur: 4 });
  playSound(win ? 'win' : 'lose');
}

function hideOver() { $('overMsg').classList.add('hidden'); }

// ---------------------------------------------------------------- estadísticas

// Se acumulan en el cliente por asiento (offline el estado es local; online
// los eventos 'answered' llegan de TODOS los jugadores, así que valen igual).
// curQ recuerda la categoría de la pregunta mostrada para adjudicar el color:
// el evento 'answered' se procesa ANTES de que syncCardWithState pase a la
// siguiente, así que curQ.cat sigue siendo la pregunta recién respondida.
let matchStats = null;
let curQ = null;

function initStats() {
  matchStats = { startT: nowT, endT: null, bySeat: {} };
  if (state) for (const pl of state.players) matchStats.bySeat[pl.seat] = { c: [0, 0, 0, 0, 0, 0], w: [0, 0, 0, 0, 0, 0] };
}

function recordAnswer(seat, cat, ok) {
  if (!matchStats || cat == null) return;
  const s = matchStats.bySeat[seat] || (matchStats.bySeat[seat] = { c: [0, 0, 0, 0, 0, 0], w: [0, 0, 0, 0, 0, 0] });
  (ok ? s.c : s.w)[cat]++;             // sin responder a tiempo (answered=-1) cuenta como fallo
  if (statsOpen()) renderStats();
}

function statsOpen() { return !$('statsPanel').classList.contains('hidden'); }

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function statsElapsed() {
  if (!matchStats) return 0;
  return (matchStats.endT != null ? matchStats.endT : nowT) - matchStats.startT;
}
// índice del máximo del array (>0), o -1 si todos son 0
function argmax6(arr) {
  let bi = -1, bv = 0;
  for (let i = 0; i < 6; i++) if (arr[i] > bv) { bv = arr[i]; bi = i; }
  return bi;
}

function renderStats() {
  if (!matchStats || !state) return;
  $('statsTime').textContent = '⏱ ' + fmtTime(statsElapsed());
  const body = $('statsBody');
  body.innerHTML = '';
  for (const pl of state.players) {
    const s = matchStats.bySeat[pl.seat] || { c: [0, 0, 0, 0, 0, 0], w: [0, 0, 0, 0, 0, 0] };
    const totC = s.c.reduce((a, b) => a + b, 0), totW = s.w.reduce((a, b) => a + b, 0);
    const row = document.createElement('div');
    row.className = 'statPlayer' + (pl.alive ? '' : ' dead');

    const head = document.createElement('div');
    head.className = 'statHead';
    const av = document.createElement('canvas');
    av.width = 20; av.height = 20; av.className = 'catIcon';
    const g = av.getContext('2d'); g.imageSmoothingEnabled = false;
    drawFace(g, Cosmetics.FACES[(cosm[pl.seat] && cosm[pl.seat].face) || 0], 20);
    head.appendChild(av);
    const nm = document.createElement('span');
    nm.className = 'statName'; nm.textContent = pl.name;
    head.appendChild(nm);
    const tot = document.createElement('span');
    tot.className = 'statTot';
    tot.innerHTML = `<span class="sc">✓ ${totC}</span>  <span class="sw">✗ ${totW}</span>`;
    head.appendChild(tot);
    row.appendChild(head);

    // desglose por color: icono de la categoría + aciertos/fallos
    const cats = document.createElement('div');
    cats.className = 'statCats';
    for (let k = 0; k < 6; k++) {
      const cell = document.createElement('span');
      cell.className = 'statCat';
      cell.appendChild(catIconEl(k, 1, true));
      const t = document.createElement('span');
      t.innerHTML = `<b>${s.c[k]}</b>/<i>${s.w[k]}</i>`;
      cell.appendChild(t);
      cats.appendChild(cell);
    }
    row.appendChild(cats);

    // color más acertado / más fallado
    const best = document.createElement('div');
    best.className = 'statBest';
    const bi = argmax6(s.c), wi = argmax6(s.w);
    best.appendChild(document.createTextNode('Más acertada:'));
    best.appendChild(bi >= 0 ? catIconEl(bi, 1, true) : document.createTextNode(' —'));
    best.appendChild(document.createTextNode('· Más fallada:'));
    best.appendChild(wi >= 0 ? catIconEl(wi, 1, true) : document.createTextNode(' —'));
    row.appendChild(best);

    body.appendChild(row);
  }
}

function toggleStats() {
  const p = $('statsPanel');
  if (p.classList.contains('hidden')) { renderStats(); p.classList.remove('hidden'); }
  else p.classList.add('hidden');
}
$('statsBtn').addEventListener('click', toggleStats);
$('statsClose').addEventListener('click', () => $('statsPanel').classList.add('hidden'));

// ---------------------------------------------------------------- eventos del juego

// Reacciona a los eventos que devuelve Game.apply (offline) o que llegan
// del servidor (online). Function declaration a propósito: los tests la
// envuelven desde evaluate para contar eventos.
function handleEvents(events) {
  for (const e of events) {
    switch (e.t) {
      case 'rolled':
        anim.dice.value = e.dice;
        anim.dice.rolling = TEST ? 0 : 0.7;
        selDest = 0;
        playSound('dice');
        setStatus(`${nameOf(e.seat)} saca un ${e.dice}: elige casilla`);
        break;
      case 'moved':
        if (e.path && e.path.length > 1) {
          anim.hop = { seat: e.seat, path: e.path, i: 0, t: 0 };
          if (TEST) anim.hop = null;
        }
        playSound('hop');
        break;
      case 'reroll':
        addEffect({ kind: 'banner', text: '¡OTRA VEZ!', color: '#f0c541', dur: 1.2 });
        setStatus(`¡${nameOf(e.seat)} vuelve a tirar!`);
        playSound('medal');
        break;
      case 'wildcat':
      case 'finalcat':
        break; // la tarjeta la abre el gate del frame (espera al salto)
      case 'question':
        break; // ídem
      case 'answered':
        revealAnswer(e);
        playSound(e.ok ? 'good' : 'bad');
        setStatus(e.ok
          ? `¡${nameOf(e.seat)} acierta${e.final ? ' la final' : ''}!`
          : (e.answered === -1 ? `${nameOf(e.seat)} no responde a tiempo` : `${nameOf(e.seat)} falla`));
        recordAnswer(e.seat, curQ ? curQ.cat : null, e.ok);
        break;
      case 'medal':
        addEffect({ kind: 'banner', text: 'MEDALLA', color: Board.CATS[e.cat].color, dur: 1.4 });
        playSound('medal');
        updatePlayersBar();
        break;
      case 'turn':
        setStatus(`Turno de ${nameOf(e.seat)}`);
        updatePlayersBar();
        break;
      case 'left':
        addChat(null, `${nameOf(e.seat)} ha dejado la partida.`);
        updatePlayersBar();
        break;
      case 'gameover':
        if (matchStats) matchStats.endT = nowT; // congela el crono de la partida
        hideCard();
        updatePlayersBar();
        showOver(e.winner);
        if (statsOpen()) renderStats();
        break;
    }
  }
}

// ---------------------------------------------------------------- acciones humanas

// Única puerta de la UI: encola la acción en el actor humano al que le toca
// (offline la aplica el bucle; online la envía el bucle por ws).
function uiAction(action) {
  if (!state || state.phase === 'gameover') return;
  const seat = Game.actor(state);
  const actor = actors[seat];
  if (!actor || !actor.isHuman) return;
  actor.queue.push(action);
  playSound('click');
}

// Fuente humana: cola de UI + sondeo del mando DENTRO de poll (el mando no
// es una fuente aparte, se suma a dedo/teclado — patrón del pingpong).
function humanActor(padIndex) {
  return {
    isHuman: true,
    pad: padIndex,
    queue: [],
    prevA: false, prevDx: 0, prevDy: 0,
    poll(g) {
      this.pollPad(g);
      return this.queue.shift() || null;
    },
    pollPad(g) {
      const gp = pollGamepad(this.pad);
      if (!gp) return;
      const bA = !!(gp.buttons[0] && gp.buttons[0].pressed);
      const edgeA = bA && !this.prevA;
      this.prevA = bA;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const dH = (gp.buttons[15] && gp.buttons[15].pressed ? 1 : 0) - (gp.buttons[14] && gp.buttons[14].pressed ? 1 : 0);
      const dV = (gp.buttons[13] && gp.buttons[13].pressed ? 1 : 0) - (gp.buttons[12] && gp.buttons[12].pressed ? 1 : 0);
      const dx = Math.abs(ax) > 0.5 ? Math.sign(ax) : dH;
      const dy = Math.abs(ay) > 0.5 ? Math.sign(ay) : dV;
      const edgeDx = dx !== 0 && this.prevDx === 0;
      const edgeDy = dy !== 0 && this.prevDy === 0;
      this.prevDx = dx; this.prevDy = dy;

      if (cardKind && cardEnabled) {
        if (edgeDy || edgeDx) { setCardFocus((focusIdx < 0 ? 0 : focusIdx) + ((dy || dx) > 0 ? 1 : -1) * (edgeDy || edgeDx ? 1 : 0)); playSound('tick'); }
        if (edgeA && focusIdx >= 0) $('qOpts').children[focusIdx].click();
        return;
      }
      if (!g) return;
      if (g.phase === 'roll' && edgeA) this.queue.push({ t: 'roll' });
      else if (g.phase === 'move' && g.destinations) {
        if (edgeDx || edgeDy) {
          selDest = (selDest + ((dx || dy) > 0 ? 1 : -1) + g.destinations.length) % g.destinations.length;
          playSound('tick');
        }
        if (edgeA) this.queue.push({ t: 'dest', node: g.destinations[selDest] });
      }
    },
  };
}

// ---------------------------------------------------------------- bots (solo offline)

const BOT_LEVELS = {
  facil: { p: 0.45, think: [1.5, 3.5] },
  normal: { p: 0.65, think: [1.2, 3.0] },
  dificil: { p: 0.85, think: [1.0, 2.5] },
};
const BOT_NAMES = ['Botilda', 'Chip', 'Robertino', 'Glitch', 'Neuronio'];

function botActor(level, seat) {
  const cfg = BOT_LEVELS[level] || BOT_LEVELS.normal;
  const strong = Math.floor(Math.random() * 6);
  let weak = Math.floor(Math.random() * 6);
  if (weak === strong) weak = (weak + 3) % 6;
  return {
    isBot: true,
    strong, weak,
    ctxKey: '', readyAt: 0,
    poll(g) {
      // pausa de "pensar" por decisión (una por contexto de fase)
      const key = g.phase + '|' + g.turn + '|' + (g.question ? g.question.text : '') + '|' + (g.dice || '');
      if (key !== this.ctxKey) {
        this.ctxKey = key;
        const [a, b] = cfg.think;
        this.readyAt = nowT + (TEST ? 0.05 : a + Math.random() * (b - a));
        return null;
      }
      if (nowT < this.readyAt || anim.hop) return null;
      switch (g.phase) {
        case 'roll': return { t: 'roll' };
        case 'move': return { t: 'dest', node: this.pickDest(g) };
        case 'wildcat': return { t: 'wildcat', cat: this.strong };
        case 'finalcat': {
          // elige la categoría que más falla el que va a responder
          const target = g.players.find(p => p.seat === g.turn);
          let best = 0;
          target.failsByCat.forEach((f, i) => { if (f > target.failsByCat[best]) best = i; });
          return { t: 'finalcat', cat: best };
        }
        case 'question': {
          // offline el estado es local y completo: el bot "sabe" la correcta
          // y falla a propósito según su nivel
          let p = cfg.p + (g.question.cat === this.strong ? 0.10 : 0) - (g.question.cat === this.weak ? 0.10 : 0);
          if (Math.random() < p) return { t: 'answer', idx: state.question.correct };
          const wrong = [0, 1, 2, 3].filter(i => i !== state.question.correct);
          return { t: 'answer', idx: wrong[Math.floor(Math.random() * 3)] };
        }
      }
      return null;
    },
    pickDest(g) {
      const me = g.players.find(p => p.seat === g.turn);
      const dests = g.destinations;
      const score = id => {
        const n = Board.NODES[id];
        if (n.plaza !== null && !me.medals[n.plaza]) return 5;
        if (n.kind === 'center' && me.medals.filter(Boolean).length >= g.medalsNeeded) return 6;
        if (n.special === 'reroll') return 3;
        if (n.cat === this.strong) return 2;
        if (n.kind === 'center') return 0; // comodín sin medalla: poco útil
        return 1;
      };
      let best = dests[0], bestS = -1;
      for (const d of dests) {
        const s = score(d) + Math.random() * 0.5; // desempate con ruido
        if (s > bestS) { bestS = s; best = d; }
      }
      return best;
    },
  };
}

// ---------------------------------------------------------------- flujo de partida

function showScreen(name) {
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('waitRoom').classList.toggle('hidden', name !== 'wait');
  $('game').classList.toggle('hidden', name !== 'game');
}

function myName() {
  return $('nameInput').value.trim().slice(0, 16) || 'Jugador 1';
}

function startOffline(opts) {
  // opts: {mode:'1p'|'local', rule, bots, level}
  mode = opts.mode;
  offlineOpts = opts;
  botLevel = opts.level || null;
  const players = [];
  actors = {};
  cosm = [];
  if (opts.mode === '1p') {
    players.push({ seat: 0, name: myName() });
    actors[0] = humanActor(0);
    cosm[0] = { token: myToken, face: myFace };
    for (let i = 0; i < opts.bots; i++) {
      players.push({ seat: 1 + i, name: BOT_NAMES[i % BOT_NAMES.length] });
      actors[1 + i] = botActor(opts.level, 1 + i);
      cosm[1 + i] = { token: (myToken + 1 + i) % Cosmetics.TOKENS.length, face: (myFace + 1 + i) % Cosmetics.FACES.length };
    }
  } else {
    // hot-seat: J1 con el mando 0, J2 con el 1
    players.push({ seat: 0, name: myName() });
    players.push({ seat: 1, name: 'Jugador 2' });
    actors[0] = humanActor(0);
    actors[1] = humanActor(1);
    cosm[0] = { token: myToken, face: myFace };
    cosm[1] = { token: (myToken + 1) % Cosmetics.TOKENS.length, face: (myFace + 1) % Cosmetics.FACES.length };
  }
  state = Game.create({ mode: opts.rule, seed: (Date.now() & 0x7fffffff) || 1, players });
  mySeat = 0;
  started = true;
  resetMatchUI();
  setStatus(`Turno de ${nameOf(state.turn)}`);
}

function resetMatchUI() {
  anim = { hop: null, dice: { rolling: 0, value: 1 }, pulse: 0 };
  effects = [];
  selDest = 0;
  shownQKey = '';
  phaseKey = '';
  hideCard();
  hideOver();
  showScreen('game');
  $('chat').classList.toggle('hidden', mode !== 'online');
  $('roomTag').classList.toggle('hidden', mode !== 'online');
  $('controls').textContent = mode === 'local'
    ? 'Cada jugador en su turno: toca el dado para tirar, la casilla destino y la respuesta. Mando 0 = J1, mando 1 = J2.'
    : 'Toca el dado para tirar (o Espacio), la casilla para moverte (o flechas + Enter) y la respuesta (o 1-4).';
  initStats();
  $('statsPanel').classList.add('hidden');
  updatePlayersBar();
  startMusic();
}

function backToMenu() {
  if (ws) { try { ws.close(); } catch { /* ya cerrado */ } ws = null; }
  mode = null;
  state = null;
  actors = {};
  roomCode = null;
  started = false;
  stopMusic();
  hideCard();
  hideOver();
  showScreen('lobby');
}

// Bucle offline: un solo motor para 1P y hot-seat. Aplica las acciones del
// actor al que le toca, los timeouts de pregunta/resultado y el gate que
// abre la tarjeta cuando la ficha termina de saltar.
function stepOffline() {
  if (!state || state.phase === 'gameover') return;

  // gate de tarjetas: se abren cuando no hay salto en curso
  if (!anim.hop) {
    if (state.phase === 'question' && state.question) {
      const key = 'q|' + state.question.text;
      if (shownQKey !== key) { shownQKey = key; showQuestion(state.question); }
    } else if (state.phase === 'wildcat') {
      if (shownQKey !== 'wildcat') { shownQKey = 'wildcat'; showCatChooser(false); }
    } else if (state.phase === 'finalcat') {
      if (shownQKey !== 'finalcat') { shownQKey = 'finalcat'; showCatChooser(true); }
    }
  }

  // temporizadores: pregunta (siempre) y resultado (auto-continue).
  // roll/move sin límite offline: los humanos piensan lo que quieran.
  const key = state.phase + '|' + state.turn + '|' + shownQKey;
  if (key !== phaseKey) {
    phaseKey = key;
    if (state.phase === 'question' && shownQKey.startsWith('q|')) {
      phaseTotal = Game.timeoutFor('question', TEST) / 1000;
      phaseDeadline = nowT + phaseTotal;
    } else if (state.phase === 'result') {
      phaseTotal = Game.timeoutFor('result', TEST) / 1000;
      phaseDeadline = nowT + phaseTotal;
    } else {
      phaseDeadline = 0;
    }
  }
  if (phaseDeadline && nowT >= phaseDeadline) {
    const seat = Game.actor(state);
    const ev = Game.apply(state, seat, { t: state.phase === 'result' ? 'continue' : 'timeout' });
    if (ev) afterApply(ev);
    return;
  }

  // pregunta visible pero aún no abierta: no dejes actuar todavía
  if ((state.phase === 'question' || state.phase === 'wildcat' || state.phase === 'finalcat') && !cardKind) return;

  const seat = Game.actor(state);
  const actor = actors[seat];
  if (!actor) return;
  const action = actor.poll(state);
  if (action) {
    const ev = Game.apply(state, seat, action);
    if (ev) afterApply(ev);
    else if (actor.isHuman) actor.queue.length = 0; // acción ilegal: vacía la cola
  }
}

function afterApply(events) {
  // al salir de la fase question la tarjeta debe cerrarse cuando toque
  handleEvents(events);
  if (state.phase === 'roll') { hideCard(); shownQKey = ''; }
  if (state.phase === 'result') shownQKey = '';
}

// barra de tiempo de la tarjeta
function updateTimebar() {
  if (!cardKind || !phaseDeadline || state.phase !== 'question') return;
  const left = Math.max(0, phaseDeadline - nowT);
  $('qTimefill').style.width = (100 * left / phaseTotal) + '%';
  $('qTimefill').style.background = left < phaseTotal * 0.25 ? '#d84040' : '#f0c541';
}

// ---------------------------------------------------------------- entrada táctil/teclado

function canvasPos(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width * LW, y: (ev.clientY - r.top) / r.height * LH };
}

canvas.addEventListener('pointerdown', ev => {
  initAudio();
  if (!state || state.phase === 'gameover') return;
  const seat = Game.actor(state);
  if (!actors[seat] || !actors[seat].isHuman) return;
  const p = canvasPos(ev);
  if (state.phase === 'roll') {
    uiAction({ t: 'roll' });
  } else if (state.phase === 'move' && state.destinations) {
    // toca una casilla destino (radio de tolerancia generoso para dedos)
    let best = null, bestD = 18;
    state.destinations.forEach((id, i) => {
      const n = nodePX(id);
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== null) {
      selDest = best;
      uiAction({ t: 'dest', node: state.destinations[best] });
    }
  }
});

window.addEventListener('keydown', ev => {
  // no capturar teclas mientras se escribe en un input (chat/nombre)
  if (document.activeElement === $('chatInput') || document.activeElement === $('nameInput')) return;
  if (ev.key === 'm' || ev.key === 'M') { setMusicMuted(!musicMuted); return; }
  if (ev.key === 's' || ev.key === 'S') { setSoundMuted(!soundMuted); return; }
  if (!state || state.phase === 'gameover') return;
  initAudio();
  // tarjeta abierta: flechas + Enter o números 1-6
  if (cardKind && cardEnabled) {
    const n = $('qOpts').children.length;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { setCardFocus(focusIdx < 0 ? 0 : focusIdx + 1); playSound('tick'); }
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { setCardFocus(focusIdx < 0 ? n - 1 : focusIdx - 1); playSound('tick'); }
    else if (ev.key === 'Enter' && focusIdx >= 0) $('qOpts').children[focusIdx].click();
    else if (/^[1-9]$/.test(ev.key) && +ev.key <= n) $('qOpts').children[+ev.key - 1].click();
    return;
  }
  const seat = Game.actor(state);
  if (!actors[seat] || !actors[seat].isHuman) return;
  if (state.phase === 'roll' && (ev.key === ' ' || ev.key === 'Enter')) uiAction({ t: 'roll' });
  else if (state.phase === 'move' && state.destinations) {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { selDest = (selDest + 1) % state.destinations.length; playSound('tick'); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { selDest = (selDest + state.destinations.length - 1) % state.destinations.length; playSound('tick'); }
    else if (ev.key === ' ' || ev.key === 'Enter') uiAction({ t: 'dest', node: state.destinations[selDest] });
  }
});

// ---------------------------------------------------------------- red online

function connect(firstMsg) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = window.ROSCA_SERVER_URL || `${proto}://${location.host}${location.pathname}`;
  ws = new WebSocket(url);
  ws.onopen = () => ws.send(JSON.stringify(firstMsg));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (mode === 'online' || roomCode) {
      setStatus('Conexión perdida. Recarga la página para volver a jugar.');
      $('lobbyError').textContent = 'Conexión perdida.';
    }
    ws = null;
  };
  ws.onerror = () => { $('lobbyError').textContent = 'No se pudo conectar con el servidor.'; };
}

function sendAction(a) {
  if (!ws) return;
  ws.send(JSON.stringify(a));
}

function onMessage(m) {
  switch (m.t) {
    case 'joined': {
      roomCode = m.room;
      mySeat = m.seat;
      $('waitCode').textContent = roomCode;
      $('roomCode').textContent = roomCode;
      // la URL de la barra es el enlace de invitación
      try { history.replaceState(null, '', location.pathname + '?sala=' + roomCode); } catch { /* file:// */ }
      showScreen('wait');
      break;
    }
    case 'lobby': {
      hostSeat = m.hostSeat;
      if (m.rule) rule = m.rule; // la regla la fija el anfitrión
      renderWaitList(m.players);
      // el servidor puede haber cambiado mi ficha si estaba cogida
      const me = m.players.find(p => p.seat === mySeat);
      if (me) { cosm[mySeat] = me.cosm; }
      m.players.forEach(p => { cosm[p.seat] = p.cosm; });
      $('startBtn').classList.toggle('hidden', mySeat !== hostSeat);
      $('waitStatus').textContent = mySeat === hostSeat
        ? (m.players.length >= 2 ? '' : 'Hacen falta al menos 2 jugadores.')
        : `Esperando a que ${(m.players.find(p => p.seat === hostSeat) || { name: 'el anfitrión' }).name} empiece…`;
      $('waitRule').textContent = rule === 'rapida' ? 'Partida rápida · 3 medallas' : 'Partida clásica · 6 medallas';
      if (started) {
        // alguien se fue durante la partida: el estado llega por 'state'
      }
      break;
    }
    case 'start': {
      mode = 'online';
      started = true;
      state = m.g;
      actors = {};
      actors[mySeat] = humanActor(0);
      resetMatchUI();
      setStatus(`Turno de ${nameOf(state.turn)}`);
      addChat(null, 'Comparte el enlace para mirar: ' + shareURL());
      break;
    }
    case 'state': {
      applySnapshot(m);
      break;
    }
    case 'events': {
      // eventos de juego (rolled/moved/answered/…) + snapshot siempre detrás
      if (m.g) state = m.g;
      handleEvents(m.events);
      syncCardWithState();
      if (m.timeLeft != null) syncTimer(m.timeLeft);
      updatePlayersBar();
      break;
    }
    case 'chat':
      addChat(m.from, m.text, m.seat);
      break;
    case 'left': {
      if (!started) break;
      addChat(null, m.msg || 'Un jugador ha salido.');
      break;
    }
    case 'error': {
      $('lobbyError').textContent = m.msg;
      showScreen('lobby');
      // resetear antes de cerrar: si no, el onclose pisa este mensaje con
      // el genérico de "conexión perdida"
      mode = null;
      roomCode = null;
      try { ws && ws.close(); } catch { /* nada */ }
      ws = null;
      break;
    }
  }
}

// Online el servidor es la única autoridad: cada snapshot sustituye el
// estado local sin reconciliación (juego por turnos, no hay predicción).
function applySnapshot(m) {
  state = m.g;
  syncCardWithState();
  if (m.timeLeft != null) syncTimer(m.timeLeft);
  if (m.msg) setStatus(m.msg);
  updatePlayersBar();
}

function syncTimer(msLeft) {
  phaseTotal = Game.timeoutFor(state.phase, false) / 1000;
  phaseDeadline = nowT + msLeft / 1000;
}

// Ajusta la tarjeta al estado del snapshot (online no hay gate de salto:
// el servidor manda y la animación es cosmética).
function syncCardWithState() {
  if (!state) return;
  if (state.phase === 'question' && state.question) {
    const key = 'q|' + state.question.text;
    if (shownQKey !== key) { shownQKey = key; showQuestion(state.question); }
  } else if (state.phase === 'wildcat') {
    if (shownQKey !== 'wildcat') { shownQKey = 'wildcat'; showCatChooser(false); }
  } else if (state.phase === 'finalcat') {
    if (shownQKey !== 'finalcat') { shownQKey = 'finalcat'; showCatChooser(true); }
  } else if (state.phase === 'roll' || state.phase === 'move' || state.phase === 'gameover') {
    if (state.phase !== 'gameover') { hideCard(); shownQKey = ''; }
  }
}

function shareURL() {
  const base = window.ROSCA_SHARE_URL || (location.origin + location.pathname);
  return base + '?sala=' + roomCode;
}

function renderWaitList(players) {
  const box = $('waitList');
  box.innerHTML = '';
  for (const p of players) {
    const div = document.createElement('div');
    div.className = 'waitPlayer';
    const av = document.createElement('canvas');
    av.width = 26; av.height = 26;
    const g = av.getContext('2d');
    g.imageSmoothingEnabled = false;
    drawFace(g, Cosmetics.FACES[p.cosm.face || 0], 26);
    div.appendChild(av);
    const tok = document.createElement('canvas');
    tok.width = 20; tok.height = 20;
    const tg = tok.getContext('2d');
    tg.imageSmoothingEnabled = false;
    drawTokenShape(tg, Cosmetics.TOKENS[p.cosm.token || 0], 9, 9, 2);
    div.appendChild(tok);
    const nm = document.createElement('span');
    nm.className = 'wname';
    nm.textContent = p.name + (p.seat === mySeat ? ' (tú)' : '');
    div.appendChild(nm);
    if (p.seat === hostSeat) {
      const h = document.createElement('span');
      h.className = 'whost';
      h.textContent = 'ANFITRIÓN';
      div.appendChild(h);
    }
    box.appendChild(div);
  }
}

// Bucle online: solo envía las acciones de MI actor humano cuando me toca.
function stepOnline() {
  if (!state || state.phase === 'gameover' || !ws) return;
  syncCardWithState();
  const seat = Game.actor(state);
  if (seat !== mySeat) return;
  const actor = actors[mySeat];
  if (!actor) return;
  const action = actor.poll(state);
  if (action) sendAction(action);
}

// ---------------------------------------------------------------- chat

function addChat(from, text, seat) {
  const log = $('chatLog');
  const div = document.createElement('div');
  if (from === null || from === undefined) {
    div.className = 'sys';
    div.textContent = text;
  } else {
    const b = document.createElement('span');
    b.className = 'from' + (seat === mySeat ? ' me' : '');
    b.textContent = from + ': ';
    div.appendChild(b);
    div.appendChild(document.createTextNode(text));
  }
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !ws) return;
  ws.send(JSON.stringify({ t: 'chat', text }));
  $('chatInput').value = '';
});

// ---------------------------------------------------------------- logo del lobby

const logoCanvas = $('logo');
const logoCtx = logoCanvas.getContext('2d');

function drawLogo(t) {
  const g = logoCtx;
  const W = logoCanvas.width, H = logoCanvas.height;
  g.clearRect(0, 0, W, H);
  const txt = 'LA ROSCA';
  const scale = 4;
  let x = Math.floor((W - pixelTextWidth(txt, scale)) / 2);
  [...txt].forEach((ch, i) => {
    const bob = Math.round(Math.sin(t * 2.5 + i * 0.7) * 2);
    drawPixelText(g, ch, x + 2, 10 + bob + 2, scale, '#0c1118');
    drawPixelText(g, ch, x, 10 + bob, scale, Board.CATS[i % 6].color);
    x += 4 * scale;
  });
  const dx = 16 + (Math.sin(t * 0.9) * 0.5 + 0.5) * (W - 32);
  drawDice(g, Math.round(dx), H - 9, 13, 1 + (Math.floor(t * 3) % 6));
}

// ---------------------------------------------------------------- lobby

function buildPicker(containerId, items, size, drawFn, onSelect) {
  const box = $(containerId);
  items.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.className = 'pick' + (idx === 0 ? ' selected' : '');
    btn.title = item.name;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    drawFn(g, item, size);
    btn.appendChild(c);
    btn.addEventListener('click', () => {
      box.querySelectorAll('.pick').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(idx);
    });
    box.appendChild(btn);
  });
}

buildPicker('tokenPicker', Cosmetics.TOKENS, 36, (g, item, s) => drawTokenShape(g, item, s / 2, s / 2, 4), idx => { myToken = idx; });
buildPicker('facePicker', Cosmetics.FACES, 36, (g, item, s) => drawFace(g, item, s), idx => { myFace = idx; });

$('ruleClasica').addEventListener('click', () => setRule('clasica'));
$('ruleRapida').addEventListener('click', () => setRule('rapida'));
function setRule(r) {
  rule = r;
  $('ruleClasica').classList.toggle('selected', r === 'clasica');
  $('ruleRapida').classList.toggle('selected', r === 'rapida');
}

$('botsMinus').addEventListener('click', () => { botCount = Math.max(1, botCount - 1); $('botsCount').textContent = botCount; });
$('botsPlus').addEventListener('click', () => { botCount = Math.min(5, botCount + 1); $('botsCount').textContent = botCount; });

document.querySelectorAll('[data-level]').forEach(btn => {
  btn.addEventListener('click', () => {
    initAudio();
    startOffline({ mode: '1p', rule, bots: botCount, level: btn.dataset.level });
  });
});
$('localBtn').addEventListener('click', () => {
  initAudio();
  startOffline({ mode: 'local', rule });
});
$('createBtn').addEventListener('click', () => {
  $('lobbyError').textContent = '';
  initAudio();
  mode = 'online';
  connect({ t: 'create', name: myName(), cosm: { token: myToken, face: myFace }, rule });
});
function joinFromInput() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length < 4) { $('lobbyError').textContent = 'El código tiene 4 letras.'; return; }
  $('lobbyError').textContent = '';
  initAudio();
  mode = 'online';
  connect({ t: 'join', room: code, name: myName(), cosm: { token: myToken, face: myFace } });
}
$('joinBtn').addEventListener('click', joinFromInput);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinFromInput(); });

// enlace de invitación ?sala=XXXX
{
  const saved = new URLSearchParams(location.search).get('sala');
  if (saved) $('codeInput').value = saved.toUpperCase();
}

$('startBtn').addEventListener('click', () => {
  sendAction({ t: 'start', mode: rule });
});
$('leaveWaitBtn').addEventListener('click', backToMenu);
$('exitBtn').addEventListener('click', backToMenu);
$('menuBtn').addEventListener('click', backToMenu);
$('rematchBtn').addEventListener('click', () => {
  if (mode === 'online') {
    sendAction({ t: 'rematch' });
    addChat(null, 'Esperando al resto para la revancha…');
  } else {
    hideOver();
    startOffline(offlineOpts);
  }
});

// ---------------------------------------------------------------- bucle

let lastT = 0;
let drawAcc = 0; // tiempo acumulado desde el último draw() real (ver reposo abajo)
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (ts - lastT) / 1000 || 0);
  lastT = ts;
  nowT += dt;
  // Con la pantalla de juego oculta (lobby/sala de espera) no hay nada que
  // pintar en el canvas grande: blitearlo igualmente a cada frame saturaba
  // el hilo principal en equipos modestos (mismo bug que tuvo el billar).
  // Solo sigue viva la animación del logo del lobby (un canvas pequeño).
  if (document.hidden || $('game').classList.contains('hidden')) {
    if (!document.hidden && !$('lobby').classList.contains('hidden')) drawLogo(nowT);
    return;
  }
  if (anim.dice.rolling > 0) anim.dice.rolling -= dt;
  if (anim.hop) {
    anim.hop.t += dt / HOP_T;
    if (anim.hop.t >= 1) {
      anim.hop.t = 0;
      anim.hop.i++;
      playSound('hop');
      if (anim.hop.i >= anim.hop.path.length - 1) anim.hop = null;
    }
  }
  if (mode === '1p' || mode === 'local') stepOffline();
  else if (mode === 'online' && started) stepOnline();
  updateTimebar();
  if (matchStats && statsOpen()) $('statsTime').textContent = '⏱ ' + fmtTime(statsElapsed());
  // En reposo (sin salto, dado ni efectos) lo único que se mueve en el canvas
  // son pulsos senoidales (halo del activo, destinos, "¡Tira!"): redibujar a
  // ~30fps sobra visualmente y el blit a resolución completa es lo caro en
  // equipos flojos. draw() recibe el tiempo acumulado para que los pulsos y
  // efectos avancen a velocidad real aunque se salten frames.
  drawAcc += dt;
  const busy = anim.hop || anim.dice.rolling > 0 || effects.length > 0;
  // 0.03 y no 1/30 exacto: a 60Hz dos frames suman 33.3ms y el redondeo
  // haría caer a veces a 3 frames (20fps); con margen quedan 30fps estables
  if (busy || drawAcc >= 0.03) {
    draw(drawAcc);
    drawAcc = 0;
  }
}

layout();
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', layout);
requestAnimationFrame(frame);
