import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];

export default class TunebarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._tunebarSettings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Tunebar',
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        page.add(this._panelGroup(settings));
        page.add(this._labelGroup(settings));
        page.add(this._playersGroup(settings, window));
        page.add(this._blacklistGroup(settings, window));
    }

    _panelGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Panel'});

        const position = new Adw.ComboRow({
            title: 'Position',
            model: Gtk.StringList.new(POSITIONS.map(([, label]) => label)),
        });
        const syncPosition = () => {
            const idx = POSITIONS.findIndex(([v]) => v === settings.get_string('position'));
            position.selected = Math.max(0, idx);
        };
        syncPosition();
        position.connect('notify::selected', () => {
            const value = POSITIONS[position.selected]?.[0];
            if (value && value !== settings.get_string('position'))
                settings.set_string('position', value);
        });
        settings.connect('changed::position', syncPosition);
        group.add(position);

        const index = Adw.SpinRow.new_with_range(0, 50, 1);
        index.title = 'Index';
        index.subtitle = 'Order within the panel box';
        settings.bind('index', index, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(index);

        group.add(this._switch(settings, 'show-art-icon', 'Album art icon',
            'Show album art (or the player icon) next to the label'));
        group.add(this._switch(settings, 'show-controls', 'Playback controls',
            'Show previous / play / next in the panel'));
        group.add(this._switch(settings, 'hide-shell-media-notification',
            'Hide GNOME media controls',
            'Hide the shell’s own player card in the notification list'));
        return group;
    }

    _labelGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Label'});

        const width = Adw.SpinRow.new_with_range(40, 1000, 10);
        width.title = 'Maximum width';
        width.subtitle = 'Pixels';
        settings.bind('label-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(width);

        group.add(this._switch(settings, 'scroll-label', 'Scroll long titles',
            'Otherwise the label is ellipsized'));

        const format = new Adw.EntryRow({title: 'Format ({title} {artist} {album} {player})'});
        settings.bind('label-format', format, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(format);
        return group;
    }

    _playersGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Players',
            description: 'Pin a player from the popup’s player row; click it again to unpin.',
        });
        const row = new Adw.ActionRow({title: 'Pinned player'});
        const clear = new Gtk.Button({
            label: 'Unpin',
            valign: Gtk.Align.CENTER,
        });
        clear.connect('clicked', () => settings.set_string('pinned-player', ''));
        row.add_suffix(clear);
        const sync = () => {
            const pinned = settings.get_string('pinned-player');
            row.subtitle = pinned || 'None (follows the most recently playing player)';
            clear.sensitive = !!pinned;
        };
        sync();
        const id = settings.connect('changed::pinned-player', sync);
        window.connect('close-request', () => {
            settings.disconnect(id);
            return false;
        });
        group.add(row);
        return group;
    }

    _blacklistGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Ignored players',
            description: 'Matched case-insensitively against the bus name suffix ' +
                '(e.g. “firefox”), the Identity (“Mozilla Firefox”) ' +
                'or the DesktopEntry (“org.mozilla.firefox”).',
        });

        const add = new Adw.EntryRow({title: 'Add player', show_apply_button: true});
        add.connect('apply', () => {
            const value = add.text.trim();
            const list = settings.get_strv('blacklist');
            if (value && !list.some(v => v.toLowerCase() === value.toLowerCase()))
                settings.set_strv('blacklist', [...list, value]);
            add.text = '';
        });
        group.add(add);

        let rows = [];
        const rebuild = () => {
            rows.forEach(r => group.remove(r));
            rows = settings.get_strv('blacklist').map(entry => {
                const row = new Adw.ActionRow({title: entry});
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove',
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    settings.set_strv('blacklist',
                        settings.get_strv('blacklist').filter(v => v !== entry));
                });
                row.add_suffix(remove);
                group.add(row);
                return row;
            });
        };
        rebuild();
        const id = settings.connect('changed::blacklist', rebuild);
        window.connect('close-request', () => {
            settings.disconnect(id);
            return false;
        });
        return group;
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
