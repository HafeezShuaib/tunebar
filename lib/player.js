// One MPRIS player. A GObject with real signals; consumers use
// connectObject()/disconnectObject().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Mpris from './mpris.js';

const METADATA_DEBOUNCE_MS = 100;
const REFETCH_DELAY_MS = 1000;

const LOOP_CYCLE = {None: 'Playlist', Playlist: 'Track', Track: 'None'};

const asString = v => (typeof v === 'string' ? v : '');

function asStringArray(v) {
    if (Array.isArray(v))
        return v.filter(s => typeof s === 'string' && s.length > 0);
    if (typeof v === 'string' && v.length > 0)
        return [v];
    return [];
}

function asNumber(v) {
    const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function titleFromUrl(url) {
    if (!url)
        return '';
    try {
        const name = GLib.path_get_basename(GLib.Uri.unescape_string(url, null) ?? url);
        return name.replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch {
        return '';
    }
}

/**
 * Whether a string is something SetPosition() will accept.
 *
 * @param {string} id track id
 * @returns {boolean}
 */
function isValidTrackId(id) {
    return typeof id === 'string' && id.length > 0 &&
        id !== Mpris.NO_TRACK && GLib.Variant.is_object_path(id);
}

export const Player = GObject.registerClass({
    GTypeName: 'Tunebar_Player',
    Signals: {
        // Proxies are up and Identity/DesktopEntry are known.
        'ready': {},
        // Track, title, artist, album, length or trackid changed.
        'metadata-changed': {},
        // artUrl changed (only emitted on an actual change).
        'art-changed': {},
        // PlaybackStatus changed.
        'status-changed': {},
        // Can* flags, Shuffle or LoopStatus changed.
        'capabilities-changed': {},
        // Seeked, Rate change or a fresh Position read.
        'position-changed': {},
    },
}, class TunebarPlayer extends GObject.Object {
    constructor(busName) {
        super();

        this.busName = busName;
        this.busSuffix = busName.slice(Mpris.MPRIS_PREFIX.length);
        this.identity = '';
        this.desktopEntry = '';
        this.app = null;
        this.ready = false;
        this.lastPlayingTime = 0;

        this.title = '';
        this.artists = [];
        this.album = '';
        this.artUrl = '';
        this.trackId = '';
        this.length = 0;

        this.status = 'Stopped';
        this.rate = 1;
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.canPlay = false;
        this.canPause = false;
        this.canSeek = false;
        this.canControl = false;
        this.canRaise = false;
        this.shuffle = null;
        this.loopStatus = null;

        this._position = 0;
        this._positionTime = GLib.get_monotonic_time();

        this._rootProxy = null;
        this._playerProxy = null;
        this._metadataTimeoutId = 0;
        this._refetchTimeoutId = 0;
        this._closed = false;
        this._cancellable = new Gio.Cancellable();

        this._start().catch(e => {
            if (!Mpris.isCancelled(e))
                console.warn(`Tunebar: failed to set up ${busName}: ${e.message}`);
        });
    }

    get artist() {
        return this.artists.join(', ');
    }

    get displayName() {
        return this.identity || this.app?.get_name() || this.busSuffix;
    }

    /** Key stored in the pinned-player setting for this player. */
    get pinKey() {
        return this.desktopEntry || this.identity || this.busSuffix;
    }

    /** Current position in µs, extrapolated while playing. */
    get position() {
        let pos = this._position;
        if (this.status === 'Playing') {
            const elapsed = GLib.get_monotonic_time() - this._positionTime;
            pos += elapsed * (this.rate > 0 ? this.rate : 1);
        }
        pos = Math.max(0, pos);
        return this.length > 0 ? Math.min(pos, this.length) : pos;
    }

    /**
     * Case-insensitive match against bus-name suffix, Identity and
     * DesktopEntry. "firefox" matches "firefox.instance_1_23".
     *
     * @param {string} pattern blacklist / pin entry
     * @returns {boolean}
     */
    matches(pattern) {
        const p = pattern?.trim().toLowerCase();
        if (!p)
            return false;
        const suffix = this.busSuffix.toLowerCase();
        return suffix === p || suffix.startsWith(`${p}.`) ||
            this.busName.toLowerCase() === p ||
            this.identity.toLowerCase() === p ||
            this.desktopEntry.toLowerCase() === p;
    }

    async _start() {
        const [root, player] = await Promise.all([
            Mpris.newProxy(this.busName, Mpris.MPRIS_PATH,
                Mpris.getMprisIfaceInfo(), this._cancellable),
            Mpris.newProxy(this.busName, Mpris.MPRIS_PATH,
                Mpris.getPlayerIfaceInfo(), this._cancellable,
                Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES),
        ]);
        if (this._closed)
            return;

        this._rootProxy = root;
        this._playerProxy = player;

        root.connectObject('g-properties-changed',
            () => this._readRoot(), this);
        player.connectObject(
            'g-properties-changed', this._onPropertiesChanged.bind(this),
            'g-signal', this._onSignal.bind(this),
            this);

        this._readRoot();
        this._readPlayer();
        this._parseMetadata(false);
        if (this.status === 'Playing')
            this.lastPlayingTime = GLib.get_monotonic_time();

        this.ready = true;
        this.emit('ready');
        this.refreshPosition();

        // Some players publish incomplete state right after they appear on
        // the bus. Refetch everything once, a second later. No polling.
        this._refetchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            REFETCH_DELAY_MS, () => {
                this._refetchTimeoutId = 0;
                this._refetchAll();
                return GLib.SOURCE_REMOVE;
            });
    }

    _get(proxy, name) {
        try {
            return proxy?.get_cached_property(name)?.recursiveUnpack();
        } catch {
            return undefined;
        }
    }

    _readRoot() {
        const proxy = this._rootProxy;
        this.identity = asString(this._get(proxy, 'Identity'));
        this.canRaise = !!this._get(proxy, 'CanRaise');
        const entry = asString(this._get(proxy, 'DesktopEntry'));
        if (entry !== this.desktopEntry || !this.app) {
            this.desktopEntry = entry;
            this.app = this._lookupApp();
        }
    }

    _lookupApp() {
        const appSystem = Shell.AppSystem.get_default();
        const candidates = [this.desktopEntry, this.busSuffix.split('.instance')[0]]
            .filter(Boolean);
        for (const id of candidates) {
            const app = appSystem.lookup_app(`${id}.desktop`) ??
                appSystem.lookup_startup_wmclass(id) ??
                appSystem.lookup_desktop_wmclass(id);
            if (app)
                return app;
        }
        return null;
    }

    _readPlayer() {
        const proxy = this._playerProxy;
        const status = asString(this._get(proxy, 'PlaybackStatus'));
        this.status = ['Playing', 'Paused', 'Stopped'].includes(status) ? status : 'Stopped';

        const rate = Number(this._get(proxy, 'Rate'));
        this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;

        this.canGoNext = !!this._get(proxy, 'CanGoNext');
        this.canGoPrevious = !!this._get(proxy, 'CanGoPrevious');
        this.canPlay = !!this._get(proxy, 'CanPlay');
        this.canPause = !!this._get(proxy, 'CanPause');
        this.canSeek = !!this._get(proxy, 'CanSeek');
        // CanControl is optional in practice; treat missing as true.
        this.canControl = this._get(proxy, 'CanControl') ?? true;

        const shuffle = this._get(proxy, 'Shuffle');
        this.shuffle = typeof shuffle === 'boolean' ? shuffle : null;
        const loop = this._get(proxy, 'LoopStatus');
        this.loopStatus = loop in LOOP_CYCLE ? loop : null;
    }

    _onPropertiesChanged(proxy, changed, invalidated) {
        const names = new Set([
            ...Object.keys(changed?.deepUnpack() ?? {}),
            ...(invalidated ?? []),
        ]);
        if (names.size === 0)
            return;

        if (names.has('Metadata'))
            this._scheduleMetadata();

        const oldStatus = this.status;
        const oldRate = this.rate;
        // Anchor the extrapolated position before status/rate change.
        const pos = this.position;
        this._readPlayer();

        if (this.status !== oldStatus) {
            this._setPosition(pos);
            if (this.status === 'Playing')
                this.lastPlayingTime = GLib.get_monotonic_time();
            this.emit('status-changed');
            this.refreshPosition();
        }
        if (this.rate !== oldRate) {
            this._setPosition(pos);
            this.emit('position-changed');
            this.refreshPosition();
        }
        if ([...names].some(n => n.startsWith('Can') || n === 'Shuffle' || n === 'LoopStatus'))
            this.emit('capabilities-changed');
    }

    _onSignal(proxy, sender, signalName, params) {
        if (signalName !== 'Seeked')
            return;
        const [pos] = params.deepUnpack();
        this._setPosition(Number(pos));
        this.emit('position-changed');
    }

    _scheduleMetadata() {
        if (this._metadataTimeoutId)
            return;
        this._metadataTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            METADATA_DEBOUNCE_MS, () => {
                this._metadataTimeoutId = 0;
                this._parseMetadata(true);
                return GLib.SOURCE_REMOVE;
            });
    }

    _parseMetadata(notify) {
        const md = this._get(this._playerProxy, 'Metadata') ?? {};

        const old = {
            title: this.title,
            artist: this.artist,
            album: this.album,
            trackId: this.trackId,
            length: this.length,
            artUrl: this.artUrl,
        };

        this.trackId = asString(md['mpris:trackid']);
        this.title = asString(md['xesam:title']) || titleFromUrl(asString(md['xesam:url']));
        this.artists = asStringArray(md['xesam:artist']);
        this.album = asString(md['xesam:album']);
        this.length = asNumber(md['mpris:length']);
        this.artUrl = asString(md['mpris:artUrl']);

        if (!notify)
            return;

        const trackChanged = old.trackId !== this.trackId || old.title !== this.title;
        if (trackChanged || old.artist !== this.artist ||
            old.album !== this.album || old.length !== this.length) {
            if (trackChanged)
                this.refreshPosition();
            this.emit('metadata-changed');
        }
        if (old.artUrl !== this.artUrl)
            this.emit('art-changed');
    }

    async _refetchAll() {
        const proxy = this._playerProxy;
        if (!proxy || this._closed)
            return;
        try {
            const result = await Mpris.call(proxy,
                'org.freedesktop.DBus.Properties.GetAll',
                new GLib.Variant('(s)', [Mpris.PLAYER_IFACE]), this._cancellable);
            if (this._closed)
                return;
            const [props] = result.deepUnpack();
            for (const [name, value] of Object.entries(props))
                proxy.set_cached_property(name, value);
        } catch (e) {
            if (!Mpris.isCancelled(e))
                console.debug(`Tunebar: GetAll failed for ${this.busName}: ${e.message}`);
            return;
        }

        const oldStatus = this.status;
        this._readPlayer();
        this._parseMetadata(true);
        if (this.status !== oldStatus)
            this.emit('status-changed');
        this.emit('capabilities-changed');
        this.refreshPosition();
    }

    _setPosition(us) {
        this._position = Number.isFinite(us) ? Math.max(0, us) : 0;
        this._positionTime = GLib.get_monotonic_time();
    }

    /** Re-read Position over D-Bus (it is never signalled by players). */
    async refreshPosition() {
        const proxy = this._playerProxy;
        if (!proxy || this._closed)
            return;
        try {
            const result = await Mpris.call(proxy,
                'org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [Mpris.PLAYER_IFACE, 'Position']),
                this._cancellable);
            if (this._closed)
                return;
            const [value] = result.deepUnpack();
            this._setPosition(Number(value.deepUnpack()));
            this.emit('position-changed');
        } catch (e) {
            if (!Mpris.isCancelled(e))
                console.debug(`Tunebar: Position unavailable for ${this.busName}`);
        }
    }

    _call(method, params = null) {
        if (!this._playerProxy || this._closed)
            return Promise.resolve(null);
        return Mpris.call(this._playerProxy, method, params, this._cancellable)
            .catch(e => {
                if (!Mpris.isCancelled(e))
                    console.warn(`Tunebar: ${method} on ${this.busName} failed: ${e.message}`);
                return null;
            });
    }

    _setProperty(name, variant) {
        return this._call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [Mpris.PLAYER_IFACE, name, variant]));
    }

    playPause() {
        if (this.canPlay || this.canPause)
            this._call('PlayPause');
    }

    next() {
        if (this.canGoNext)
            this._call('Next');
    }

    previous() {
        if (this.canGoPrevious)
            this._call('Previous');
    }

    /**
     * Seek to an absolute position. Uses SetPosition when the track has a
     * usable trackid, otherwise a relative Seek.
     *
     * @param {number} us target position in µs
     */
    async setPosition(us) {
        if (!this.canSeek || !this._playerProxy)
            return;
        let target = Math.max(0, Math.round(us));
        if (this.length > 0)
            target = Math.min(target, this.length);

        const delta = Math.round(target - this.position);
        const trackId = this.trackId;
        this._setPosition(target);
        this.emit('position-changed');

        if (isValidTrackId(trackId)) {
            try {
                await Mpris.call(this._playerProxy, 'SetPosition',
                    new GLib.Variant('(ox)', [trackId, target]), this._cancellable);
                return;
            } catch (e) {
                if (Mpris.isCancelled(e))
                    return;
            }
        }
        await this._call('Seek', new GLib.Variant('(x)', [delta]));
    }

    toggleShuffle() {
        if (this.shuffle === null || !this.canControl)
            return;
        this._setProperty('Shuffle', new GLib.Variant('b', !this.shuffle));
    }

    cycleLoop() {
        if (this.loopStatus === null || !this.canControl)
            return;
        this._setProperty('LoopStatus',
            new GLib.Variant('s', LOOP_CYCLE[this.loopStatus]));
    }

    raise() {
        if (this.app)
            this.app.activate();
        else if (this.canRaise && this._rootProxy)
            Mpris.call(this._rootProxy, 'Raise', null, this._cancellable).catch(() => {});
    }

    /** Release all D-Bus connections and GLib sources. */
    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._cancellable.cancel();

        if (this._metadataTimeoutId) {
            GLib.source_remove(this._metadataTimeoutId);
            this._metadataTimeoutId = 0;
        }
        if (this._refetchTimeoutId) {
            GLib.source_remove(this._refetchTimeoutId);
            this._refetchTimeoutId = 0;
        }

        this._rootProxy?.disconnectObject(this);
        this._playerProxy?.disconnectObject(this);
        this._rootProxy = null;
        this._playerProxy = null;
        this.app = null;
    }
});
