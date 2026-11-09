// =============================================================
// ui.js — Interfaz en DOM: menú, HUD, tienda, fin de partida y avisos.
//
// No conoce reglas ni red. Recibe un "modelo de vista" ya calculado
// (render(view)) y avisa de lo que pulsa el jugador mediante handlers.
// Así se puede rediseñar la interfaz sin tocar la lógica ni el canvas.
//
// Handlers (setHandlers):
//   onStartBot(difficulty)  onCreateRoom()  onJoinRoom(code)
//   onPickWeapon(id)  onFire()  onBuy(id)  onReady()  onRematch()  onLeave()
//   onLobbyCancel()  onShare()  onCopyLink()
// En línea: showLobby(view) / hideLobby() y setNetStatus(texto | null).
// =============================================================

import { MinigameUI } from './minigames-ui.js';
import { drawQR } from './qr.js';
import { canFullscreen, onFullscreenChange, toggleFullscreen } from './fullscreen.js';

const NAME_KEY = 'rocket-keep.name';

const UPGRADE_ICONS = { rockets: '🚀', hp: '❤️', damage: '💥', repair: '🔧' };

const REASONS = {
  ko: 'Castillo derribado',
  rounds: 'Más vida al terminar las rondas',
  draw: 'Misma vida tras la muerte súbita',
};

/** Escapa texto que viene de fuera (por ejemplo, nombres de jugadores). */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class GameUI {
  #el;
  #h = {};
  #difficulty = 'normal';

  constructor(doc = document, { audio } = {}) {
    const $ = (id) => doc.getElementById(id);
    this.#el = {
      menu: $('menu'),
      hud: $('hud'),
      meName: $('meName'),
      meCoins: $('meCoins'),
      meWeapon: $('meWeapon'),
      oppName: $('oppName'),
      oppWeapon: $('oppWeapon'),
      loadout: $('loadout'),
      round: $('round'),
      banner: $('banner'),
      toasts: $('toasts'),
      shop: $('shop'),
      over: $('over'),
      controls: $('controls'),
      fire: $('fire'),
      hint: $('hint'),
      leave: $('leave'),
      lobby: $('lobby'),
      netStatus: $('netStatus'),
      playerName: $('playerName'),
      joinForm: $('joinForm'),
      joinCode: $('joinCode'),
    };
    try {
      this.#el.playerName.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      /* sin almacenamiento: se queda vacío */
    }
    /** Panel de los minijuegos de inicio de ronda (lo maneja el controller). */
    this.minigame = new MinigameUI($('minigame'), { audio });
    this.#bindStatic();
    // Pantalla completa (solo si el navegador la permite; iPhone no).
    const fs = $('fullscreen');
    if (canFullscreen()) {
      fs.hidden = false;
      const sync = (on) => {
        fs.textContent = on ? '⤡ Salir' : '⛶ Pantalla completa';
        fs.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Pantalla completa');
      };
      fs.addEventListener('click', () => void toggleFullscreen());
      onFullscreenChange(sync);
      sync(false);
    }
    if (audio) {
      const mute = $('audioMute'), volume = $('audioVolume'), level = $('audioLevel');
      audio.subscribe(({ muted, volume: value, available }) => {
        mute.disabled = volume.disabled = !available;
        mute.textContent = !available ? 'Sonido no disponible' : muted ? '🔇 Silenciado' : '🔊 Sonido';
        mute.setAttribute('aria-pressed', String(muted));
        mute.setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar sonido');
        volume.value = String(Math.round(value * 100));
        level.textContent = `${volume.value} %`;
        volume.setAttribute('aria-valuetext', level.textContent);
      });
      mute.addEventListener('click', () => {
        audio.setMuted(!audio.settings.muted);
        void audio.unlock().then(() => audio.play('click'));
      });
      volume.addEventListener('input', () => {
        audio.setVolume(Number(volume.value) / 100);
        void audio.unlock();
      });
      volume.addEventListener('change', () => audio.play('click'));
      // Captura antes de que los handlers reemplacen el botón/panel del DOM.
      doc.getElementById('app').addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (!button || button.disabled || button.closest('.sound-controls') ||
          button.matches('#fire, [data-buy], [data-go], [data-pad], [data-tap]')) return;
        audio.play('click');
      }, true);
    }
  }

  setHandlers(h) {
    this.#h = h;
  }

  // ---------- menú ----------

  showMenu() {
    this.#el.menu.hidden = false;
    this.#el.hud.hidden = true;
    this.#el.controls.hidden = true;
    this.#el.shop.hidden = true;
    this.#el.over.hidden = true;
    this.#el.loadout.hidden = true;
    this.#el.banner.hidden = true;
    this.minigame.close();
    this.hideLobby();
    this.setNetStatus(null);
  }

  /** Nombre que escribió el jugador (se recuerda en este navegador). */
  get playerName() {
    const name = this.#el.playerName.value.trim().slice(0, 16);
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* no pasa nada */
    }
    return name || 'Jugador';
  }

  // ---------- en línea ----------

  /**
   * Panel de sala. view.mode:
   *   'creating'                       abriendo la sala
   *   'host'  { code, url, canShare }  esperando al amigo (con enlace y QR)
   *   'joining' { code }               conectando como invitado
   *   'error' { title, message }       algo falló o la partida terminó
   */
  showLobby(view) {
    const el = this.#el.lobby;
    this.#el.menu.hidden = true;
    el.hidden = false;
    if (view.mode === 'creating') {
      el.innerHTML = `<h2>Creando sala…</h2><p class="waiting">Conectando con el servidor de señalización</p>
        <button data-cancel>Cancelar</button>`;
    } else if (view.mode === 'host') {
      el.innerHTML = `<h2>Tu sala</h2>
        <div class="room-code" aria-label="Código de sala">${esc(view.code)}</div>
        <p class="opp">Comparte el enlace (o el código) con tu amigo: entra directo a la partida.</p>
        <canvas class="qr" aria-label="Código QR del enlace"></canvas>
        <input class="text-input link" readonly value="${esc(view.url)}" aria-label="Enlace de invitación">
        <div class="mg-row">
          ${view.canShare ? '<button class="primary" data-share>Compartir</button>' : ''}
          <button data-copy>Copiar enlace</button>
        </div>
        <p class="waiting"><span class="pulse"></span> Esperando a tu amigo…</p>
        <p class="warn">⚠️ No cierres ni recargues esta pestaña: tu navegador es el servidor de la partida.</p>
        <button data-cancel>Cancelar</button>`;
      try {
        drawQR(el.querySelector('.qr'), view.url, { scale: 4 });
      } catch {
        el.querySelector('.qr').remove();
      }
    } else if (view.mode === 'joining') {
      el.innerHTML = `<h2>Sala ${esc(view.code)}</h2><p class="waiting"><span class="pulse"></span> Conectando…</p>
        <button data-cancel>Cancelar</button>`;
    } else {
      el.innerHTML = `<h2>${esc(view.title ?? 'Sin conexión')}</h2><p class="opp">${esc(view.message)}</p>
        <button class="primary" data-cancel>Volver al menú</button>`;
    }
  }

  hideLobby() {
    this.#el.lobby.hidden = true;
    this.#el.lobby.innerHTML = '';
  }

  /** Aviso fijo de conexión durante la partida (null lo oculta). */
  setNetStatus(text) {
    this.#el.netStatus.hidden = !text;
    this.#el.netStatus.textContent = text ?? '';
  }

  hideMenu() {
    this.#el.menu.hidden = true;
    this.#el.hud.hidden = false;
    this.#el.controls.hidden = false;
  }

  #bindStatic() {
    const m = this.#el.menu;
    m.addEventListener('click', (e) => {
      const diff = e.target.closest('[data-diff]');
      if (diff) {
        this.#difficulty = diff.dataset.diff;
        m.querySelectorAll('[data-diff]').forEach((b) => b.classList.toggle('active', b === diff));
        return;
      }
      if (e.target.closest('#playBot')) this.#h.onStartBot?.(this.#difficulty);
      if (e.target.closest('#createRoom')) this.#h.onCreateRoom?.();
    });
    this.#el.joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.#h.onJoinRoom?.(this.#el.joinCode.value);
    });
    this.#el.joinCode.addEventListener('input', () => {
      this.#el.joinCode.value = this.#el.joinCode.value.toUpperCase().replace(/[^A-Z]/g, '');
    });
    this.#el.lobby.addEventListener('click', (e) => {
      if (e.target.closest('[data-cancel]')) this.#h.onLobbyCancel?.();
      if (e.target.closest('[data-share]')) this.#h.onShare?.();
      if (e.target.closest('[data-copy]')) this.#h.onCopyLink?.();
      const link = e.target.closest('input.link');
      if (link) link.select();
    });
    this.#el.fire.addEventListener('click', () => this.#h.onFire?.());
    this.#el.leave.addEventListener('click', () => {
      if (confirm('¿Abandonar la partida y volver al menú?')) this.#h.onLeave?.();
    });
    this.#el.shop.addEventListener('click', (e) => {
      const buy = e.target.closest('[data-buy]');
      if (buy && !buy.disabled) this.#h.onBuy?.(buy.dataset.buy);
      if (e.target.closest('[data-ready]')) this.#h.onReady?.();
    });
    this.#el.loadout.addEventListener('click', (e) => {
      const w = e.target.closest('[data-weapon]');
      if (w && !w.disabled) this.#h.onPickWeapon?.(w.dataset.weapon);
    });
    this.#el.over.addEventListener('click', (e) => {
      if (e.target.closest('[data-rematch]')) this.#h.onRematch?.();
      if (e.target.closest('[data-menu]')) this.#h.onLeave?.();
    });
  }

  // ---------- avisos ----------

  /** Aviso breve en el centro de la pantalla. */
  toast(text, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.#el.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 1600);
    setTimeout(() => t.remove(), 2100);
  }

  // ---------- render del modelo de vista ----------

  /**
   * @param {object} v  modelo de vista (ver Controller#view)
   */
  render(v) {
    const el = this.#el;
    if (!v) return;
    // HUD
    el.meName.textContent = v.names[0];
    el.oppName.textContent = v.names[1];
    el.meCoins.textContent = `🪙 ${v.coins}`;
    // Arma y perks de cada jugador (los perks solo como iconos, con su nombre al pasar el ratón).
    const tag = (w, perks = []) => (w ? `${w.icon} ${w.label}` : '') + (perks.length ? ` · ${perks.map((p) => p.icon).join('')}` : '');
    el.meWeapon.textContent = tag(v.weapons[0], v.perks?.[0]);
    el.oppWeapon.textContent = tag(v.weapons[1], v.perks?.[1]);
    el.meWeapon.title = (v.perks?.[0] ?? []).map((p) => p.label).join(', ');
    el.oppWeapon.title = (v.perks?.[1] ?? []).map((p) => p.label).join(', ');
    el.round.textContent = v.round ? (v.maxRounds > 0 ? `Ronda ${v.round}/${v.maxRounds}` : `Ronda ${v.round}`) : '';
    el.round.style.visibility = v.round ? 'visible' : 'hidden'; // conserva su hueco en la rejilla del HUD
    el.round.classList.toggle('sudden', v.suddenDeath);
    if (v.suddenDeath) el.round.textContent = `Muerte súbita · ${v.round}`;

    // Turno
    el.banner.hidden = !v.turn;
    const BANNERS = {
      me: 'Tu turno',
      opp: 'Turno del rival',
    };
    if (v.turn) {
      el.banner.textContent = BANNERS[v.turn];
      el.banner.className = `banner ${v.turn}`;
    }
    el.fire.disabled = !v.canFire;
    if (v.canFire) el.hint.textContent = 'Arrastra desde tu castillo: dirección = ángulo, distancia = potencia. Suelta para disparar.';
    else el.hint.textContent = v.turn === 'opp' ? 'El rival está apuntando…' : '';

    this.#renderLoadout(v.loadout);
    this.#renderShop(v.shop);
    this.#renderOver(v.over);
  }

  #renderLoadout(lo) {
    const el = this.#el.loadout;
    el.hidden = !lo;
    if (!lo) return;
    let html = '<h2>Elige tu arma</h2><p class="opp">La usarás toda la partida. El rival no verá tu elección hasta que ambos elijan.</p><div class="offers">';
    for (const w of lo.options) {
      const chosen = lo.myPick === w.id;
      html += `<button class="offer weapon ${chosen ? 'chosen' : ''}" data-weapon="${w.id}" ${lo.myPick ? 'disabled' : ''}>
          <span class="icon">${w.icon}</span>
          <span class="body"><b>${esc(w.label)}</b><small>${esc(w.desc)}</small><span class="stats">${esc(w.stats)}</span></span>
          ${chosen ? '<span class="cost">✔</span>' : ''}
        </button>`;
    }
    html += '</div>';
    if (lo.myPick) html += `<p class="waiting">${lo.oppPicked ? 'Revelando armas…' : 'Esperando a que el rival elija…'}</p>`;
    else html += `<p class="opp">${lo.oppPicked ? 'El rival ya eligió.' : 'El rival está eligiendo…'}</p>`;
    el.innerHTML = html;
  }

  #renderShop(shop) {
    const el = this.#el.shop;
    el.hidden = !shop;
    if (!shop) return;
    const s = shop.summary;
    let html = `<h2>Entre rondas</h2>
      <div class="summary">
        <div><span>Daño causado</span><b>${s.dealt}</b></div>
        <div><span>Daño recibido</span><b>${s.received}</b></div>
        <div><span>Monedas ganadas</span><b>+${s.earned}</b></div>
      </div>
      <div class="coins">🪙 ${shop.coins} monedas</div>`;
    if (shop.ready) {
      html += `<p class="waiting">Esperando al rival…</p>`;
    } else {
      const card = (o) => {
        const pips = o.kind === 'perk'
          ? ''
          : `<span class="pips">${Array.from({ length: o.maxLevel }, (_, i) => `<i class="${i < o.level ? 'on' : ''}"></i>`).join('')}</span>`;
        const price = o.kind === 'perk' && o.owned ? '✔ Tuyo' : o.cost === null ? 'MÁX' : `🪙 ${o.cost}`;
        return `<button class="offer ${o.owned ? 'owned' : ''}" data-buy="${o.id}" ${o.affordable ? '' : 'disabled'}>
            <span class="icon">${o.icon ?? UPGRADE_ICONS[o.id] ?? '⭐'}</span>
            <span class="body"><b>${esc(o.label)}</b><small>${esc(o.effect)}</small>${pips}</span>
            <span class="cost">${price}</span>
          </button>`;
      };
      html += '<h3>Mejoras</h3><div class="offers">' + shop.offers.filter((o) => o.kind !== 'perk').map(card).join('') + '</div>';
      html += '<h3>Perks <small>(una sola compra)</small></h3><div class="offers">' + shop.offers.filter((o) => o.kind === 'perk').map(card).join('') + '</div>';
      html += `<button class="primary" data-ready>Listo</button>`;
      html += `<p class="opp">${shop.oppReady ? 'El rival ya está listo' : 'El rival está comprando…'}</p>`;
    }
    el.innerHTML = html;
  }

  #renderOver(over) {
    const el = this.#el.over;
    el.hidden = !over;
    if (!over) return;
    const title = { win: '¡Victoria!', lose: 'Derrota', draw: 'Empate' }[over.result];
    let rematchLabel = 'Revancha';
    if (over.rematchMe) rematchLabel = 'Esperando al rival…';
    else if (over.rematchOpp) rematchLabel = 'Aceptar revancha';
    el.className = `panel over ${over.result}`;
    el.innerHTML = `<h2>${title}</h2>
      <p class="reason">${REASONS[over.reason] ?? ''}</p>
      <div class="summary">
        <div><span>Tu daño total</span><b>${over.myDamage}</b></div>
        <div><span>Daño del rival</span><b>${over.oppDamage}</b></div>
        <div><span>Rondas</span><b>${over.rounds}</b></div>
      </div>
      <button class="primary" data-rematch ${over.rematchMe ? 'disabled' : ''}>${rematchLabel}</button>
      <button data-menu>Menú principal</button>`;
  }
}
