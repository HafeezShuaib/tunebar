// Popup content: album art, title/artist, seek bar, transport controls and a
// player switcher.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import * as Compat from './compat.js';

const TICK_MS = 1000;
const SEEK_DEBOUNCE_MS = 150;
const FALLBACK_ICON = 'audio-x-generic-symbolic';

/**
 * @param {number} us microseconds
 * @returns {string} m:ss or h:mm:ss
 */
export function formatTime(us) {
    const total = Math.max(0, Math.floor(us / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Show art as a CSS background (so border-radius clips it), or fall back to
 * an icon child.
 *
 * @param {St.Bin} bin target
 * @param {Gio.File|null} file art file
 * @param {Gio.Icon|null} fallback fallback icon
 * @param {number} iconSize fallback icon size
 */
export function applyArt(bin, file, fallback, iconSize) {
    if (file) {
        bin.set_style(`background-image: url("${file.get_uri()}");`);
        bin.add_style_class_name('has-art');
        bin.child = null;
    } else {
        bin.set_style(null);
        bin.remove_style_class_name('has-art');
        bin.child = new St.Icon({
            gicon: fallback ?? new Gio.ThemedIcon({name: FALLBACK_ICON}),
            icon_size: iconSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }
}

/**
 * Keeps one art bin up to date. A token drops results from superseded
 * requests, so a slow download can't overwrite a newer track's art.
 */
export class ArtView {
    /**
     * @param {St.Bin} bin target
     * @param {ArtCache} artCache art cache
     * @param {number} iconSize fallback icon size
     */
    constructor(bin, artCache, iconSize) {
        this._bin = bin;
        this._artCache = artCache;
        this._iconSize = iconSize;
        this._token = 0;
    }

    /**
     * @param {Player|null} player player whose art to show
     */
    async load(player) {
        const token = ++this._token;
        const fallback = player?.app?.get_icon() ?? null;
        const file = player?.artUrl
            ? await this._artCache?.lookup(player.artUrl).catch(() => null)
            : null;
        if (token !== this._token)
            return;
        applyArt(this._bin, file, fallback, this._iconSize);
    }

    /** Ignore any result still in flight. */
    destroy() {
        this._token++;
        this._artCache = null;
    }
}

// 'icon-button flat' is the shell's own round, transparent button, so
// hover/focus/checked colours come from the active theme (dark, light or
// high contrast).
const BUTTON_BASE_CLASS = 'icon-button flat';

function controlButton(iconName, extraClass = '') {
    return new St.Button({
        style_class: `${BUTTON_BASE_CLASS} tunebar-control-button ${extraClass}`.trim(),
        // Don't let the row stretch the small buttons to the play button's
        // height (GNOME 45-46 fill vertically by default).
        y_align: Clutter.ActorAlign.CENTER,
        can_focus: true,
        child: new St.Icon({icon_name: iconName}),
    });
}

/**
 * Enable or dim a button (also removes it from keyboard focus when dim).
 *
 * @param {St.Button} button button
 * @param {boolean} sensitive whether it can be used
 */
export function setSensitive(button, sensitive) {
    button.reactive = sensitive;
    button.can_focus = sensitive;
    button.opacity = sensitive ? 255 : 100;
}

function setChecked(button, checked) {
    if (checked)
        button.add_style_pseudo_class('checked');
    else
        button.remove_style_pseudo_class('checked');
}

export const PopupItem = GObject.registerClass({
    GTypeName: 'Tunebar_PopupItem',
}, class TunebarPopupItem extends St.BoxLayout {
    _init(manager, artCache, settings) {
        // Plain content added to menu.box (not a PopupBaseMenuItem: a
        // non-activatable item is styled :insensitive and dims everything).
        super._init(Compat.verticalParams({
            style_class: 'tunebar-popup-box',
            x_expand: true,
        }));
        if (Compat.HAS_ACCENT_COLOR)
            this.add_style_class_name(Compat.ACCENT_STYLE_CLASS);

        this._manager = manager;
        this._artCache = artCache;
        this._settings = settings;
        this._player = undefined; // forces the first _bindPlayer() to run
        this._open = false;
        this._dragging = false;
        this._updatingSlider = false;
        this._tickId = 0;
        this._seekId = 0;
        this._destroyed = false;

        this._buildUi();
        this._artView = new ArtView(this._art, artCache, 96);

        this._manager.connectObject(
            'active-changed', () => this._bindPlayer(),
            'players-changed', () => this._rebuildPlayerRow(),
            this);
        this._settings.connectObject(
            'changed::pinned-player', () => this._highlightPlayerRow(), this);

        this.connect('destroy', this._tunebarDestroy.bind(this));
        this._bindPlayer();
        this._rebuildPlayerRow();
    }

    _buildUi() {
        this._art = new St.Bin({
            style_class: 'tunebar-art',
            x_align: Clutter.ActorAlign.CENTER,
        });
        Compat.addClickHandler(this._art, () => this._player?.raise());
        this.add_child(this._art);

        this._title = new St.Label({style_class: 'tunebar-title', x_expand: true});
        this._artist = new St.Label({style_class: 'tunebar-artist', x_expand: true});
        for (const label of [this._title, this._artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.line_alignment = Pango.Alignment.CENTER;
            label.x_align = Clutter.ActorAlign.CENTER;
            this.add_child(label);
        }

        // Seek bar
        this._seekBox = Compat.vbox({style_class: 'tunebar-seek-box', x_expand: true});
        this._slider = new Slider.Slider(0);
        this._slider.x_expand = true;
        this._slider.accessible_name = 'Seek';
        this._slider.connectObject(
            'drag-begin', () => {
                this._dragging = true;
            },
            'drag-end', () => {
                this._dragging = false;
                this._seekToSlider();
            },
            'notify::value', () => this._onSliderValue(),
            this);
        this._seekBox.add_child(this._slider);

        const times = new St.BoxLayout({style_class: 'tunebar-times', x_expand: true});
        this._elapsed = new St.Label({style_class: 'tunebar-time', x_expand: true});
        this._total = new St.Label({style_class: 'tunebar-time'});
        times.add_child(this._elapsed);
        times.add_child(this._total);
        this._seekBox.add_child(times);
        this.add_child(this._seekBox);

        // Transport controls
        const controls = new St.BoxLayout({
            style_class: 'tunebar-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._loopButton = controlButton('media-playlist-repeat-symbolic');
        this._prevButton = controlButton('media-skip-backward-symbolic');
        this._playButton = controlButton('media-playback-start-symbolic',
            'tunebar-play-button');
        this._nextButton = controlButton('media-skip-forward-symbolic');
        this._shuffleButton = controlButton('media-playlist-shuffle-symbolic');

        this._loopButton.connect('clicked', () => this._player?.cycleLoop());
        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton.connect('clicked', () => this._player?.next());
        this._shuffleButton.connect('clicked', () => this._player?.toggleShuffle());

        for (const b of [this._loopButton, this._prevButton, this._playButton,
            this._nextButton, this._shuffleButton])
            controls.add_child(b);
        this.add_child(controls);

        // Player switcher
        this._playerRow = new St.BoxLayout({
            style_class: 'tunebar-player-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._playerRow);
    }

    setOpen(open) {
        this._open = open;
        if (open) {
            this._player?.refreshPosition();
            this._updatePosition();
        }
        this._syncTick();
    }

    _bindPlayer() {
        const player = this._manager.activePlayer;
        if (player === this._player)
            return;

        this._player?.disconnectObject(this);
        this._player = player;
        this._removeSeekSource();

        player?.connectObject(
            'metadata-changed', () => {
                this._updateMetadata();
                this._updatePosition();
            },
            'art-changed', () => this._loadArt(),
            'status-changed', () => {
                this._updateControls();
                this._updatePosition();
                this._syncTick();
            },
            'capabilities-changed', () => {
                this._updateControls();
                this._updatePosition();
            },
            'position-changed', () => this._updatePosition(),
            this);

        this._updateMetadata();
        this._updateControls();
        this._loadArt();
        if (this._open)
            player?.refreshPosition();
        this._updatePosition();
        this._syncTick();
        this._highlightPlayerRow();
    }

    _updateMetadata() {
        const p = this._player;
        this._title.text = p ? p.title || p.displayName : 'No player';
        this._artist.text = p?.artist ?? '';
        this._artist.visible = !!p?.artist;
    }

    _loadArt() {
        this._artView.load(this._player);
    }

    _updateControls() {
        const p = this._player;
        const playing = p?.status === 'Playing';
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? 'Pause' : 'Play';

        setSensitive(this._playButton, !!p && (p.canPlay || p.canPause));
        setSensitive(this._prevButton, !!p?.canGoPrevious);
        setSensitive(this._nextButton, !!p?.canGoNext);

        const hasShuffle = !!p && p.shuffle !== null;
        this._shuffleButton.visible = hasShuffle;
        setSensitive(this._shuffleButton, hasShuffle && p.canControl);
        setChecked(this._shuffleButton, hasShuffle && p.shuffle);

        const hasLoop = !!p && p.loopStatus !== null;
        this._loopButton.visible = hasLoop;
        setSensitive(this._loopButton, hasLoop && p.canControl);
        setChecked(this._loopButton, hasLoop && p.loopStatus !== 'None');
        this._loopButton.child.icon_name = p?.loopStatus === 'Track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
    }

    _updatePosition() {
        const p = this._player;
        const length = p?.length ?? 0;
        this._seekBox.visible = length > 0;
        if (length <= 0) {
            this._syncTick();
            return;
        }
        this._slider.reactive = p.canSeek;
        if (this._dragging)
            return;

        const pos = p.position;
        this._updatingSlider = true;
        this._slider.value = Math.min(1, Math.max(0, pos / length));
        this._updatingSlider = false;
        this._elapsed.text = formatTime(pos);
        this._total.text = formatTime(length);
    }

    _onSliderValue() {
        if (this._updatingSlider || !this._player?.length)
            return;
        this._elapsed.text = formatTime(this._slider.value * this._player.length);
        if (this._dragging)
            return;
        // Scroll wheel / keyboard: debounce into one seek.
        this._removeSeekSource();
        this._seekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_DEBOUNCE_MS, () => {
            this._seekId = 0;
            this._seekToSlider();
            return GLib.SOURCE_REMOVE;
        });
    }

    _seekToSlider() {
        this._removeSeekSource();
        const p = this._player;
        if (p?.length > 0 && p.canSeek)
            p.setPosition(this._slider.value * p.length);
    }

    _removeSeekSource() {
        if (this._seekId) {
            GLib.source_remove(this._seekId);
            this._seekId = 0;
        }
    }

    // A 1 s tick only while the menu is open and the player is playing.
    _syncTick() {
        const want = this._open && !this._destroyed &&
            this._player?.status === 'Playing' && this._player.length > 0;
        if (want && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._updatePosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _rebuildPlayerRow() {
        if (this._destroyed)
            return;
        this._playerRow.destroy_all_children();
        const players = this._manager.players;
        this._playerRow.visible = players.length >= 2;
        if (players.length < 2)
            return;

        for (const player of players) {
            const button = new St.Button({
                style_class: `${BUTTON_BASE_CLASS} tunebar-player-button`,
                can_focus: true,
                accessible_name: player.displayName,
                child: new St.Icon({
                    gicon: player.app?.get_icon() ??
                        new Gio.ThemedIcon({name: FALLBACK_ICON}),
                }),
            });
            button._tunebarPlayer = player;
            // Clicking pins the player; clicking the pinned one unpins.
            button.connect('clicked', () => {
                this._manager.pin(this._manager.isPinned(player) ? null : player);
            });
            this._playerRow.add_child(button);
        }
        this._highlightPlayerRow();
    }

    _highlightPlayerRow() {
        for (const button of this._playerRow.get_children()) {
            const player = button._tunebarPlayer;
            setChecked(button, player === this._player);
            if (this._manager.isPinned(player))
                button.add_style_class_name('pinned');
            else
                button.remove_style_class_name('pinned');
        }
    }

    _tunebarDestroy() {
        this._destroyed = true;
        this._artView.destroy();
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._removeSeekSource();
        this._player?.disconnectObject(this);
        this._player = null;
        this._manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._manager = null;
        this._settings = null;
    }
});
