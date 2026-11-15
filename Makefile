UUID      := tunebar@hafeezshuaib.github.io
ZIP       := $(UUID).shell-extension.zip
SCHEMA    := schemas/org.gnome.shell.extensions.tunebar.gschema.xml
SOURCES   := metadata.json extension.js prefs.js stylesheet.css $(wildcard lib/*.js) $(SCHEMA)

.PHONY: all schemas pack install uninstall enable disable prefs check nested log clean

all: pack

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas --strict schemas/

pack: $(ZIP)

$(ZIP): $(SOURCES) schemas/gschemas.compiled
	gnome-extensions pack --force --extra-source=lib .

install: pack
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Syntax check every module (ESM parse only; shell imports are not resolved).
check:
	@for f in extension.js prefs.js lib/*.js; do \
		node --check --input-type=module < $$f || { echo "syntax error in $$f"; exit 1; }; \
	done; echo "syntax OK"

# Nested GNOME Shell (50+: --devkit; older: --nested --wayland).
nested: install
	dbus-run-session -- gnome-shell --devkit --wayland

log:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
