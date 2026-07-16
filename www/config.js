'use strict';
// Config de despliegue (patrón del pingpong). En la web autohospedada ambos
// quedan en null y el cliente usa el mismo origen. En la build nativa
// (Capacitor) no hay "mismo origen": apunta ROSCA_SERVER_URL al WebSocket
// (wss://tudominio/rosca) y ROSCA_SHARE_URL a la URL pública del juego para
// los enlaces de invitación ?sala=XXXX.
window.ROSCA_SERVER_URL = null;
window.ROSCA_SHARE_URL = null;
