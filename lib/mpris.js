// D-Bus plumbing: interface XML, proxy creation and promise helpers.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
export const MPRIS_PATH = '/org/mpris/MediaPlayer2';
export const MPRIS_IFACE = 'org.mpris.MediaPlayer2';
export const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
export const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

const DBUS_XML = `<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="old_owner"/>
      <arg type="s" name="new_owner"/>
    </signal>
  </interface>
</node>`;

const MPRIS_XML = `<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const PLAYER_XML = `<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const lookup = (xml, name) =>
    Gio.DBusNodeInfo.new_for_xml(xml).lookup_interface(name);

export const DBusIfaceInfo = lookup(DBUS_XML, 'org.freedesktop.DBus');
export const MprisIfaceInfo = lookup(MPRIS_XML, MPRIS_IFACE);
export const PlayerIfaceInfo = lookup(PLAYER_XML, PLAYER_IFACE);

/**
 * @param {Error} e error
 * @returns {boolean} whether the error is a cancellation
 */
export function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Create and asynchronously initialise a Gio.DBusProxy.
 *
 * @param {string} name bus name
 * @param {string} path object path
 * @param {Gio.DBusInterfaceInfo} info interface info
 * @param {Gio.Cancellable} cancellable cancellable
 * @param {Gio.DBusProxyFlags} flags extra flags
 * @returns {Promise<Gio.DBusProxy>}
 */
export function newProxy(name, path, info, cancellable, flags = 0) {
    const proxy = new Gio.DBusProxy({
        g_connection: Gio.DBus.session,
        g_name: name,
        g_object_path: path,
        g_interface_name: info.name,
        g_interface_info: info,
        g_flags: flags | Gio.DBusProxyFlags.DO_NOT_AUTO_START,
    });
    return new Promise((resolve, reject) => {
        proxy.init_async(GLib.PRIORITY_DEFAULT, cancellable, (p, res) => {
            try {
                p.init_finish(res);
                resolve(p);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Call a method on a proxy. `method` may be fully qualified
 * (e.g. 'org.freedesktop.DBus.Properties.Get').
 *
 * @param {Gio.DBusProxy} proxy proxy
 * @param {string} method method name
 * @param {GLib.Variant|null} params parameters
 * @param {Gio.Cancellable} cancellable cancellable
 * @returns {Promise<GLib.Variant>}
 */
export function call(proxy, method, params, cancellable) {
    return new Promise((resolve, reject) => {
        proxy.call(method, params, Gio.DBusCallFlags.NO_AUTO_START, 5000,
            cancellable, (p, res) => {
                try {
                    resolve(p.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}
