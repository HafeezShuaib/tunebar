// The top-panel indicator: art icon, scrolling label and prev/play/next.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Compat from './compat.js';
import {PopupItem, applyArt} from './popup.js';
import {ScrollLabel} from './scrollLabel.js';

const SEPARATOR_RE = /^[\s\-–—·|:•]+|[\s\-–—·|:•]+$/g;

/**
 * Expand {title} {artist} {album} {player}; separators left dangling by
 * empty tokens are trimmed.
 *
 * @param {string} format label-format setting
 * @param {object} player Player
 * @returns {string}
 */
export function formatLabel(format, player) {
    const values = {
        title: player.title || player.displayName,
        artist: player.artist,
        album: player.album,
        player: player.displayName,
    };
    // Split on tokens so separators between an empty token and its neighbour
    // can be dropped.
    const parts = (format || '{title} – {artist}').split(/(\{(?:title|artist|album|player)\})/);
    let out = '';
    let pendingSep = '';
    for (const part of parts) {
        const m = part.match(/^\{(\w+)\}$/);
        if (!m) {
            pendingSep += part;
            continue;
        }
        const value = values[m[1]] ?? '';
        if (!value)
            continue;
        // A pure separator before the first value is dropped; literal text
        // (e.g. "♪ ") is kept verbatim.
        if (out || pendingSep.replace(SEPARATOR_RE, ''))
            out += pendingSep;
        out += value;
        pendingSep = '';
    }
    out += pendingSep.replace(SEPARATOR_RE, '') ? pendingSep : '';
    return out.trim();
}

function panelControl(iconName, accessibleName) {
    return new St.Button({
        style_class: 'tunebar-panel-control',
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName, style_class: 'system-status-icon'}),
    });
}

export const PanelButton = GObject.registerClass({
    GTypeName: 'Tunebar_PanelButton',
}, class TunebarPanelButton extends PanelMenu.Button {
    _init(settings, manager, artCache) {
        super._init(0.5, 'Tunebar', false);
        this.add_style_class_name('tunebar-panel-button');

        this._settings = settings;
        this._manager = manager;
        this._artCache = artCache;
        this._player = undefined; // forces the first _bindPlayer() to run
        this._artToken = 0;
        this._destroyed = false;

        const box = new St.BoxLayout({style_class: 'tunebar-panel-box'});
        this.add_child(box);

        this._labelBox = new St.BoxLayout({
            style_class: 'tunebar-panel-label-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._art = new St.Bin({
            style_class: 'tunebar-panel-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new ScrollLabel();
        this._labelBox.add_child(this._art);
        this._labelBox.add_child(this._label);
        box.add_child(this._labelBox);

        this._controls = new St.BoxLayout({style_class: 'tunebar-panel-controls'});
        this._prevButton = panelControl('media-skip-backward-symbolic', 'Previous');
        this._playButton = panelControl('media-playback-start-symbolic', 'Play');
        this._nextButton = panelControl('media-skip-forward-symbolic', 'Next');
        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton.connect('clicked', () => this._player?.next());
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playButton);
        this._controls.add_child(this._nextButton);
        box.add_child(this._controls);

        // GNOME 50+: the button's own press gesture would swallow clicks on
        // the embedded controls. Disable it and toggle from the label only.
        if (Compat.disablePanelButtonGesture(this))
            Compat.addClickHandler(this._labelBox, () => this.menu.toggle());

        this._popupItem = new PopupItem(manager, artCache, settings);
        this.menu.box.add_child(this._popupItem);
        this.menu.connectObject('open-state-changed',
            (menu, open) => this._popupItem.setOpen(open), this);

        this._settings.connectObject(
            'changed::label-width', () => this._syncLabelSettings(),
            'changed::scroll-label', () => this._syncLabelSettings(),
            'changed::label-format', () => this._updateLabel(),
            'changed::show-art-icon', () => this._syncVisibility(),
            'changed::show-controls', () => this._syncVisibility(),
            this);
        this._manager.connectObject('active-changed', () => this._bindPlayer(), this);

        this.connect('destroy', this._tunebarDestroy.bind(this));

        this._syncLabelSettings();
        this._bindPlayer();
    }

    _syncLabelSettings() {
        this._label.setMaxWidth(this._settings.get_int('label-width'));
        this._label.setScroll(this._settings.get_boolean('scroll-label'));
    }

    _syncVisibility() {
        this.visible = !!this._player;
        this._art.visible = this._settings.get_boolean('show-art-icon');
        this._controls.visible = this._settings.get_boolean('show-controls');
    }

    _bindPlayer() {
        const player = this._manager.activePlayer;
        if (player === this._player)
            return;

        this._player?.disconnectObject(this);
        this._player = player;
        player?.connectObject(
            'metadata-changed', () => this._updateLabel(),
            'art-changed', () => this._loadArt(),
            'status-changed', () => this._updateControls(),
            'capabilities-changed', () => this._updateControls(),
            this);

        if (!player)
            this.menu.close();
        this._syncVisibility();
        this._updateLabel();
        this._updateControls();
        this._loadArt();
    }

    _updateLabel() {
        const p = this._player;
        this._label.text = p ? formatLabel(this._settings.get_string('label-format'), p) : '';
        this.accessible_name = this._label.text || 'Tunebar';
    }

    _updateControls() {
        const p = this._player;
        const playing = p?.status === 'Playing';
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? 'Pause' : 'Play';
        this._setSensitive(this._playButton, !!p && (p.canPlay || p.canPause));
        this._setSensitive(this._prevButton, !!p?.canGoPrevious);
        this._setSensitive(this._nextButton, !!p?.canGoNext);
    }

    _setSensitive(button, sensitive) {
        button.reactive = sensitive;
        button.can_focus = sensitive;
        button.opacity = sensitive ? 255 : 110;
    }

    async _loadArt() {
        const token = ++this._artToken;
        const player = this._player;
        const fallback = player?.app?.get_icon() ??
            new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        const file = player?.artUrl
            ? await this._artCache.lookup(player.artUrl).catch(() => null)
            : null;
        if (this._destroyed || token !== this._artToken)
            return;
        applyArt(this._art, file, fallback, 16);
    }

    _tunebarDestroy() {
        this._destroyed = true;
        this._artToken++;
        this._player?.disconnectObject(this);
        this._player = null;
        this._settings.disconnectObject(this);
        this._manager.disconnectObject(this);
        this.menu?.disconnectObject?.(this);
        this._settings = null;
        this._manager = null;
        this._artCache = null;
    }
});
