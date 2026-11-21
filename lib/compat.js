// All GNOME Shell version differences live here. Everything is feature
// detected; nothing looks at the shell version number.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// Clutter.ClickGesture exists on GNOME 50+; older shells use plain events.
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
 * Attach a primary-click handler to an actor. On GNOME 50+ this uses a
 * ClickGesture; older shells use a plain press/release pair on the actor.
 * Both are owned by the actor and go away with it.
 *
 * @param {Clutter.Actor} actor target
 * @param {Function} callback called on click
 */
export function addClickHandler(actor, callback) {
    actor.reactive = true;
    if (HAS_CLICK_GESTURE) {
        const gesture = new Clutter.ClickGesture();
        gesture.connect('recognize', () => callback());
        actor.add_action(gesture);
        return;
    }

    let pressed = false;
    actor.connect('button-press-event', (_actor, event) => {
        pressed = event.get_button() === Clutter.BUTTON_PRIMARY;
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('button-release-event', (_actor, event) => {
        const click = pressed && event.get_button() === Clutter.BUTTON_PRIMARY;
        pressed = false;
        if (click)
            callback();
        return click ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    });
    actor.connect('leave-event', () => {
        pressed = false;
        return Clutter.EVENT_PROPAGATE;
    });
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

// GNOME 45-49: PanelMenu.Button toggles its menu in vfunc_event(). GNOME 50+
// uses a ClickGesture and has no JS vfunc_event to chain up to.
export const PANEL_BUTTON_HANDLES_EVENT =
    Object.prototype.hasOwnProperty.call(PanelMenu.Button.prototype, 'vfunc_event');

/**
 * The actor an event was delivered to.
 *
 * @param {Clutter.Event} event event
 * @returns {Clutter.Actor|null}
 */
export function eventActor(event) {
    return global.stage.get_event_actor?.(event) ?? event.get_source?.() ?? null;
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

    // GNOME 48+: MessageView owns an MprisSource and a player->message map.
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

    // GNOME 45-47: a MediaSection inside the calendar message list.
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
