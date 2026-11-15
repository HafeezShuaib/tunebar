// Tracks MPRIS players on the session bus and picks the active one.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Mpris from './mpris.js';
import {Player} from './player.js';

export const PlayerManager = GObject.registerClass({
    GTypeName: 'Tunebar_PlayerManager',
    Signals: {
        // The set of valid (ready, not blacklisted) players changed.
        'players-changed': {},
        // The active player changed (may be null).
        'active-changed': {},
    },
}, class TunebarPlayerManager extends GObject.Object {
    constructor(settings) {
        super();

        this._settings = settings;
        this._players = new Map();
        this._active = null;
        this._validKey = '';
        this._dbusProxy = null;
        this._closed = false;
        this._cancellable = new Gio.Cancellable();

        this._settings.connectObject(
            'changed::blacklist', () => this._update(),
            'changed::pinned-player', () => this._update(),
            this);

        this._start().catch(e => {
            if (!Mpris.isCancelled(e))
                console.error(`Tunebar: cannot watch the session bus: ${e.message}`);
        });
    }

    get activePlayer() {
        return this._active;
    }

    /** Ready, non-blacklisted players in discovery order. */
    get players() {
        const blacklist = this._settings.get_strv('blacklist');
        return [...this._players.values()].filter(p =>
            p.ready && !blacklist.some(entry => p.matches(entry)));
    }

    isPinned(player) {
        const pinned = this._settings.get_string('pinned-player');
        return !!player && !!pinned && player.matches(pinned);
    }

    /**
     * Pin a player (or clear the pin with null).
     *
     * @param {Player|null} player player to pin
     */
    pin(player) {
        this._settings.set_string('pinned-player', player?.pinKey ?? '');
    }

    async _start() {
        const proxy = await Mpris.newProxy('org.freedesktop.DBus',
            '/org/freedesktop/DBus', Mpris.DBusIfaceInfo, this._cancellable,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);
        if (this._closed)
            return;
        this._dbusProxy = proxy;

        // Subscribe before listing so no player can slip between the two.
        proxy.connectObject('g-signal', (p, sender, signal, params) => {
            if (signal === 'NameOwnerChanged')
                this._onNameOwnerChanged(...params.deepUnpack());
        }, this);

        const result = await Mpris.call(proxy, 'ListNames', null, this._cancellable);
        if (this._closed)
            return;
        const [names] = result.deepUnpack();
        names.filter(n => n.startsWith(Mpris.MPRIS_PREFIX))
            .sort()
            .forEach(n => this._addPlayer(n));
    }

    _onNameOwnerChanged(name, oldOwner, newOwner) {
        if (!name.startsWith(Mpris.MPRIS_PREFIX))
            return;
        if (oldOwner)
            this._removePlayer(name);
        if (newOwner)
            this._addPlayer(name);
    }

    _addPlayer(busName) {
        if (this._closed || this._players.has(busName))
            return;
        const player = new Player(busName);
        this._players.set(busName, player);
        player.connectObject(
            'ready', () => this._update(),
            'status-changed', () => this._update(),
            this);
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        this._players.delete(busName);
        player.disconnectObject(this);
        player.close();
        this._update();
    }

    _update() {
        if (this._closed)
            return;
        const valid = this.players;

        const key = valid.map(p => p.busName).join('\n');
        const setChanged = key !== this._validKey;
        this._validKey = key;

        // pinned > most recently Playing > current > first valid
        const pinned = this._settings.get_string('pinned-player');
        const playing = valid
            .filter(p => p.status === 'Playing')
            .sort((a, b) => b.lastPlayingTime - a.lastPlayingTime);
        const next =
            (pinned ? valid.find(p => p.matches(pinned)) : null) ??
            playing[0] ??
            (valid.includes(this._active) ? this._active : null) ??
            valid[0] ??
            null;

        if (setChanged)
            this.emit('players-changed');
        if (next !== this._active) {
            this._active = next;
            this.emit('active-changed');
        }
    }

    /** Stop watching the bus and release every player. */
    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        this._dbusProxy?.disconnectObject(this);
        this._dbusProxy = null;
        for (const player of this._players.values()) {
            player.disconnectObject(this);
            player.close();
        }
        this._players.clear();
        this._active = null;
        this._settings = null;
    }
});
