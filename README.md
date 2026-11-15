# Tunebar

A GNOME Shell extension (GNOME 45–51) that shows the current MPRIS track in the
top panel.

- Panel: album-art icon, `{title} – {artist}` label (scrolls when it does not
  fit), previous / play-pause / next.
- Popup (click the label): album art (click to raise the player), title,
  artist, seek bar with elapsed/total time, loop / previous / play / next /
  shuffle, and a row of app icons to switch players when two or more are
  running.

UUID: `tunebar@hafeezshuaib.github.io`

## Install

```sh
make install          # compiles schemas, packs the zip, gnome-extensions install --force
make enable           # or: gnome-extensions enable tunebar@hafeezshuaib.github.io
```

On Wayland the shell only picks up new or changed extension code after you log
out and back in. To test without logging out, run a nested shell (GNOME 50+
needs the `mutter-devkit` package):

```sh
dbus-run-session -- gnome-shell --devkit --wayland
```

On GNOME 45–48 use `gnome-shell --nested --wayland` instead. To watch for
errors:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

The extension logs with a `Tunebar:` prefix.

Other targets: `make pack`, `make schemas`, `make check` (syntax check via
node), `make prefs`, `make uninstall`, `make clean`.

## Settings

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `position` | `left`/`center`/`right` | `center` | Panel box |
| `index` | int | `0` | Order inside the box |
| `label-width` | int (px) | `220` | Maximum label width |
| `scroll-label` | bool | `true` | Scroll long labels instead of ellipsizing them |
| `label-format` | string | `{title} – {artist}` | Tokens: `{title}` `{artist}` `{album}` `{player}` |
| `show-art-icon` | bool | `true` | Art (or app icon) in the panel |
| `show-controls` | bool | `true` | Prev/play/next in the panel |
| `hide-shell-media-notification` | bool | `false` | Hide GNOME's own media card in the notification list |
| `blacklist` | string list | `[]` | Players to ignore |
| `pinned-player` | string | `''` | Always prefer this player while it runs |

Blacklist and pin entries are matched case-insensitively against the bus-name
suffix (`firefox` matches `org.mpris.MediaPlayer2.firefox.instance_1_23`),
the player's `Identity` (`Mozilla Firefox`) and its `DesktopEntry`
(`firefox`).

To pin a player, click its icon in the popup's player row. Click it again to
unpin, or use the preferences window. The pinned player has an underline.

When a separator in `label-format` would end up next to an empty token, it is
dropped. With no artist, `{title} – {artist}` shows just the title.

## How it chooses the player

The active player is, in order:

1. the pinned player, if it is running;
2. otherwise the player that most recently started playing;
3. otherwise the player that is already shown, if it is still around;
4. otherwise the first player found.

## Design notes

- **Players are GObjects** (`Tunebar_Player`) with real signals:
  `ready`, `metadata-changed`, `art-changed`, `status-changed`,
  `capabilities-changed`, `position-changed`. Every connection uses
  `connectObject` and is released with `disconnectObject`. Widgets clean up
  in `destroy` handlers and never override `destroy()`. `disable()` closes
  every proxy and removes every GLib source.
- **D-Bus**: `Gio.DBusProxy` built from `Gio.DBusNodeInfo` XML. The bus is
  watched with `NameOwnerChanged`, subscribed before `ListNames`. Metadata
  updates are debounced by 100 ms. Each player gets a single `GetAll`
  refetch 1 s after it appears, and there is no polling loop.
- **Bad metadata is tolerated**. Without a valid `mpris:trackid`, seeking
  uses relative `Seek()`. Without `mpris:length`, the seek bar is hidden.
  Without `Shuffle` or `LoopStatus`, those buttons are hidden. Controls
  follow the `Can*` flags. A single-string `xesam:artist` is accepted.
- **Seek bar**: the position is extrapolated locally. A 1 s GLib timeout runs
  only while the popup is open and the player is playing. The position is
  re-read on `Seeked`, on a `Rate` or status change, and when the menu opens.
  The bar uses no Clutter transitions and no slider marks.
- **Art**: one shared `Soup.Session`, aborted on disable. Remote and `data:`
  art is cached at `~/.cache/tunebar/<sha256(url)>`, capped at 50 files.
  Stale results are dropped using a request token. Art is reloaded only when
  `artUrl` changes, and corners are rounded with CSS.
- **Version differences** are all in `lib/compat.js` and use feature
  detection: `Clutter.ClickGesture` vs `ClickAction`; the panel button's own
  `_clickGesture` is disabled on 50+ so the embedded buttons get clicks; and
  `St.BoxLayout` `orientation` (48+) vs `vertical`.
- **Hiding GNOME's media card** is opt-in. It patches only instance
  properties on private objects, every path is guarded, and the change is
  undone on disable or when the setting is turned off. On 49+ it hooks
  `MessageView`; on 45–48 it hooks `MediaSection`.
- GType names are namespaced `Tunebar_*`.

## Layout

```
metadata.json  extension.js  prefs.js  stylesheet.css  Makefile
schemas/org.gnome.shell.extensions.tunebar.gschema.xml
lib/compat.js         version differences + shell media hider
lib/mpris.js          D-Bus XML, proxy/call helpers
lib/player.js         Tunebar_Player
lib/playerManager.js  bus watching, blacklist, active-player choice
lib/artCache.js       Soup download + on-disk cache
lib/scrollLabel.js    marquee label
lib/panelButton.js    panel indicator
lib/popup.js          popup content
```
