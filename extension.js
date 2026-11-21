import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtCache} from './lib/artCache.js';
import {ShellMediaHider} from './lib/compat.js';
import {clearIfaceInfo} from './lib/mpris.js';
import {PanelButton} from './lib/panelButton.js';
import {PlayerManager} from './lib/playerManager.js';

export default class TunebarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._artCache = new ArtCache();
        this._manager = new PlayerManager(this._settings);
        this._mediaHider = new ShellMediaHider();

        this._settings.connectObject(
            'changed::position', () => this._recreateButton(),
            'changed::index', () => this._recreateButton(),
            'changed::hide-shell-media-notification', () => this._syncMediaHider(),
            this);

        this._createButton();
        this._syncMediaHider();
    }

    disable() {
        this._settings?.disconnectObject(this);

        this._mediaHider?.restore();
        this._mediaHider = null;

        this._button?.destroy();
        this._button = null;

        this._manager?.close();
        this._manager = null;

        this._artCache?.destroy();
        this._artCache = null;

        clearIfaceInfo();

        this._settings = null;
    }

    _createButton() {
        const position = this._settings.get_string('position');
        const index = this._settings.get_int('index');
        this._button = new PanelButton(this._settings, this._manager, this._artCache);
        Main.panel.addToStatusArea(this.uuid, this._button, index, position);
    }

    _recreateButton() {
        this._button?.destroy();
        this._button = null;
        this._createButton();
    }

    _syncMediaHider() {
        if (this._settings.get_boolean('hide-shell-media-notification'))
            this._mediaHider.hide();
        else
            this._mediaHider.restore();
    }
}
