// Resolves mpris:artUrl to a local Gio.File, downloading remote art once into
// ~/.cache/tunebar/<sha256(url)>. One Soup.Session for the whole extension.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const MAX_FILES = 50;

export class ArtCache {
    constructor() {
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'tunebar']));
        this._session = new Soup.Session({timeout: 15, max_conns_per_host: 2});
        this._cancellable = new Gio.Cancellable();
        this._inflight = new Map();
    }

    /**
     * @param {string} url mpris:artUrl
     * @returns {Promise<Gio.File|null>}
     */
    lookup(url) {
        if (!url || !this._session)
            return Promise.resolve(null);

        if (url.startsWith('file://') || url.startsWith('/')) {
            const file = url.startsWith('/')
                ? Gio.File.new_for_path(url) : Gio.File.new_for_uri(url);
            return this._exists(file).then(ok => (ok ? file : null));
        }

        if (!/^(https?:|data:image\/)/i.test(url))
            return Promise.resolve(null);

        let promise = this._inflight.get(url);
        if (!promise) {
            promise = this._fetch(url)
                .catch(e => {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`Tunebar: art download failed: ${e.message}`);
                    return null;
                })
                .finally(() => this._inflight.delete(url));
            this._inflight.set(url, promise);
        }
        return promise;
    }

    _exists(file) {
        return new Promise(resolve => {
            file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
                    try {
                        f.query_info_finish(res);
                        resolve(true);
                    } catch {
                        resolve(false);
                    }
                });
        });
    }

    async _fetch(url) {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        const file = this._dir.get_child(hash);
        if (await this._exists(file))
            return file;

        let bytes;
        if (url.startsWith('data:'))
            bytes = this._decodeDataUrl(url);
        else
            bytes = await this._download(url);
        if (!bytes || bytes.get_size() === 0 || !this._session)
            return null;

        try {
            this._dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }

        await new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        this._prune();
        return file;
    }

    _download(url) {
        let message;
        try {
            message = Soup.Message.new('GET', url);
        } catch {
            return Promise.resolve(null);
        }
        if (!message)
            return Promise.resolve(null);

        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_LOW,
                this._cancellable, (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        resolve(message.get_status() === Soup.Status.OK ? bytes : null);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _decodeDataUrl(url) {
        const comma = url.indexOf(',');
        if (comma < 0 || !/;base64$/i.test(url.slice(0, comma)))
            return null;
        try {
            return new GLib.Bytes(GLib.base64_decode(url.slice(comma + 1)));
        } catch {
            return null;
        }
    }

    _prune() {
        try {
            const enumerator = this._dir.enumerate_children(
                'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const entries = [];
            let info;
            while ((info = enumerator.next_file(null)))
                entries.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
            enumerator.close(null);

            if (entries.length <= MAX_FILES)
                return;
            entries.sort((a, b) => a[1] - b[1]);
            for (const [name] of entries.slice(0, entries.length - MAX_FILES))
                this._dir.get_child(name).delete(null);
        } catch (e) {
            console.debug(`Tunebar: cache prune failed: ${e.message}`);
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._session?.abort();
        this._session = null;
        this._inflight.clear();
    }
}
