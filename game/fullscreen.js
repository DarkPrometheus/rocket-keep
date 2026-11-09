// =============================================================
// fullscreen.js — Pantalla completa en teléfonos.
//
// En móvil la barra del navegador se come buena parte de la pantalla en
// horizontal. Al empezar una partida desde un toque (gesto del usuario) se
// pide pantalla completa y, si el navegador lo permite, se fija la
// orientación horizontal. iPhone (Safari) no tiene esta API para páginas:
// ahí el botón se oculta y el juego se adapta igual con el CSS.
// =============================================================

const root = document.documentElement;

/** ¿El navegador permite pantalla completa? */
export const canFullscreen = () => Boolean(root.requestFullscreen || root.webkitRequestFullscreen);

/** ¿Es un dispositivo táctil (teléfono o tableta)? */
export const isTouchDevice = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

const current = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

export const isFullscreen = () => current() !== null;

/** Entra en pantalla completa y, si se puede, fija la orientación horizontal. */
export async function enterFullscreen() {
  if (!canFullscreen() || isFullscreen()) return;
  try {
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else root.webkitRequestFullscreen();
    await screen.orientation?.lock?.('landscape');
  } catch {
    /* el navegador lo rechazó (sin gesto, o no permite bloquear la orientación) */
  }
}

export async function exitFullscreen() {
  if (!isFullscreen()) return;
  try {
    screen.orientation?.unlock?.();
    if (document.exitFullscreen) await document.exitFullscreen();
    else document.webkitExitFullscreen?.();
  } catch {
    /* nada que hacer */
  }
}

export const toggleFullscreen = () => (isFullscreen() ? exitFullscreen() : enterFullscreen());

/** En teléfonos, al empezar a jugar: pantalla completa automática. */
export function fullscreenForPlay() {
  if (isTouchDevice()) void enterFullscreen();
}

/** Llama a cb(dentro) cada vez que se entra o sale de pantalla completa. */
export function onFullscreenChange(cb) {
  const handler = () => cb(isFullscreen());
  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
}
