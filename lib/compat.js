// All GNOME Shell version differences live here. Everything is feature
// detected; nothing looks at the shell version number.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Clutter.ClickGesture replaced Clutter.ClickAction (GNOME 50+).
export const HAS_CLICK_GESTURE = typeof Clutter.ClickGesture === 'function';

// St.BoxLayout gained `orientation` and deprecated `vertical` (GNOME 48+).
export const HAS_BOX_ORIENTATION =
    !!GObject.Object.find_property.call(St.BoxLayout, 'orientation');

// The theme exposes the user's accent colour as -st-accent-color (GNOME 47+).
// Older St logs a warning for it, so CSS using it is scoped under a class
// that is only added when it is supported.
export const HAS_ACCENT_COLOR =
    !!GObject.Object.find_property.call(St.Settings, 'accent-color');
export const ACCENT_STYLE_CLASS = 'tunebar-accent';

/**
 * Construction params for a vertical St.BoxLayout.
 *
 * @param {object} params extra params
 * @returns {object}
 */
export function verticalParams(params = {}) {
    return HAS_BOX_ORIENTATION
        ? {...params, orientation: Clutter.Orientation.VERTICAL}
        : {...params, vertical: true};
}

/**
 * @param {object} params St.BoxLayout params
 * @returns {St.BoxLayout} a vertical box
 */
export function vbox(params = {}) {
    return new St.BoxLayout(verticalParams(params));
}

/**
 * Attach a primary-click handler to an actor. The action is owned by the
 * actor and goes away with it.
 *
 * @param {Clutter.Actor} actor target
 * @param {Function} callback called on click
 * @returns {Clutter.Action}
 */
export function addClickHandler(actor, callback) {
    actor.reactive = true;
    let action;
    if (HAS_CLICK_GESTURE) {
        action = new Clutter.ClickGesture();
        action.connect('recognize', () => callback());
    } else {
        action = new Clutter.ClickAction();
        action.connect('clicked', () => callback());
    }
    actor.add_action(action);
    return action;
}

/**
 * On GNOME 50+ PanelMenu.Button toggles its menu through a ClickGesture that
 * recognizes on press and steals the sequence from child St.Buttons. Turn it
 * off so the embedded controls work; the caller installs its own handler on
 * the label area instead.
 *
 * @param {PanelMenu.Button} button panel button (after setMenu())
 * @returns {boolean} true if a gesture was found and disabled
 */
export function disablePanelButtonGesture(button) {
    const gesture = button._clickGesture;
    if (!gesture || typeof gesture.set_enabled !== 'function')
        return false;
    gesture.set_enabled(false);
    return true;
}

/**
 * Opt-in hiding of the shell's own media player entries in the
 * notification/calendar list. Every private path is guarded, and restore()
 * undoes exactly what hide() did.
 */
export class ShellMediaHider {
    constructor() {
        this._restore = null;
    }

    get active() {
        return this._restore !== null;
    }

    hide() {
        if (this._restore)
            return;
        try {
            this._restore = this._hideMessageView() ?? this._hideMediaSection();
        } catch (e) {
            console.warn(`Tunebar: could not hide shell media controls: ${e}`);
            this._restore = null;
        }
    }

    restore() {
        const restore = this._restore;
        this._restore = null;
        try {
            restore?.();
        } catch (e) {
            console.warn(`Tunebar: could not restore shell media controls: ${e}`);
        }
    }

    // GNOME 49+: MessageView owns an MprisSource and a player->message map.
    _hideMessageView() {
        const view = Main.panel?.statusArea?.dateMenu?._messageList?._messageView;
        const proto = view ? Object.getPrototypeOf(view) : null;
        if (!(view?._playerToMessage instanceof Map) ||
            typeof proto?._addPlayer !== 'function' ||
            typeof proto?._removePlayer !== 'function')
            return null;

        const map = view._playerToMessage;
        view._addPlayer = () => {};
        view._removePlayer = player => {
            if (map.has(player))
                proto._removePlayer.call(view, player);
        };
        for (const player of [...map.keys()])
            proto._removePlayer.call(view, player);

        return () => {
            delete view._addPlayer;
            delete view._removePlayer;
            const players = view._mediaSource?.players ?? [];
            for (const player of players) {
                if (!map.has(player))
                    view._addPlayer(player);
            }
        };
    }

    // GNOME 45-48: a MediaSection inside the calendar message list.
    _hideMediaSection() {
        const section = Main.panel?.statusArea?.dateMenu?._messageList?._mediaSection;
        if (!section)
            return null;

        section._shouldShow = () => false;
        section._sync?.();
        section.visible = false;

        return () => {
            delete section._shouldShow;
            if (typeof section._sync === 'function')
                section._sync();
            else
                section.visible = !section.empty;
        };
    }
}
