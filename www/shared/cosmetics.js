'use strict';
// Datos puros de cosméticos (UMD, como en los hermanos). Sin dibujo: las
// funciones que convierten esto en píxeles viven en client.js
// (drawTokenShape / drawFace / swatches de los pickers).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cosmetics = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // 8 fichas para que 6 jugadores siempre tengan opción libre. Si al unirte
  // tu ficha está cogida, el servidor asigna la siguiente libre (módulo 8).
  const TOKENS = [
    { name: 'Peón', shape: 'round', fill: '#d84040', trim: '#7a1f1f' },
    { name: 'Rombo', shape: 'diamond', fill: '#3f6fd8', trim: '#1f3a7a' },
    { name: 'Estrella', shape: 'star', fill: '#e8c530', trim: '#8a7318' },
    { name: 'Escudo', shape: 'shield', fill: '#3dbf6e', trim: '#1d6e3c' },
    { name: 'Gota', shape: 'drop', fill: '#2fc1d6', trim: '#17707e' },
    { name: 'Corona', shape: 'crown', fill: '#9b59d0', trim: '#5a2f7e' },
    { name: 'Seta', shape: 'mushroom', fill: '#e07830', trim: '#8a4518' },
    { name: 'Fantasma', shape: 'ghost', fill: '#d8d8e8', trim: '#7a7a90' },
  ];

  // Avatares de cara (mismo formato CHARACTERS que el pingpong).
  const FACES = [
    { name: 'Nico', skin: '#e8b88a', hair: '#3a2a1a', hairStyle: 'flat', shirt: '#d43d3d' },
    { name: 'Mei', skin: '#f0c9a0', hair: '#1a1a22', hairStyle: 'bob', shirt: '#3d7ad4' },
    { name: 'Rocco', skin: '#c98d5e', hair: '#101010', hairStyle: 'spiky', shirt: '#3db554' },
    { name: 'Duna', skin: '#f5d5b5', hair: '#c96a20', hairStyle: 'pony', shirt: '#b04ad4' },
    { name: 'Bruno', skin: '#8a5a3a', hair: '#2a1a10', hairStyle: 'cap', shirt: '#e8a020' },
    { name: 'Zoe', skin: '#e8b88a', hair: '#d4d4e0', hairStyle: 'bob', shirt: '#20b8b0' },
  ];

  return { TOKENS, FACES };
});
