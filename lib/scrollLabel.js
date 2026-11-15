// A width-capped label that scrolls as a seamless marquee when the text does
// not fit (or ellipsizes when scrolling is off).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

const SPEED_PX_PER_S = 30;
const START_DELAY_MS = 1500;

export const ScrollLabel = GObject.registerClass({
    GTypeName: 'Tunebar_ScrollLabel',
}, class TunebarScrollLabel extends St.Widget {
    _init(params = {}) {
        super._init({
            style_class: 'tunebar-scroll-label',
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });

        this._text = '';
        this._maxWidth = 200;
        this._scroll = true;
        this._stateKey = '';

        this._box = new St.BoxLayout({style_class: 'tunebar-scroll-box'});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._copy = new St.Label({y_align: Clutter.ActorAlign.CENTER, visible: false});
        for (const label of [this._label, this._copy]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.line_wrap = false;
            this._box.add_child(label);
        }
        this.add_child(this._box);

        this.connect('notify::mapped', () => this._restart());
        this.connect('style-changed', () => this._restart());
        this.connect('destroy', () => this._box.remove_all_transitions());
    }

    get text() {
        return this._text;
    }

    set text(text) {
        text = text ?? '';
        if (text === this._text)
            return;
        this._text = text;
        this._label.text = text;
        this._copy.text = text;
        this.queue_relayout();
        this._restart();
    }

    setMaxWidth(width) {
        this._maxWidth = Math.max(1, width);
        this.queue_relayout();
        this._restart();
    }

    setScroll(scroll) {
        this._scroll = !!scroll;
        this._restart();
    }

    _naturalTextWidth() {
        return this._label.get_preferred_width(-1)[1];
    }

    vfunc_get_preferred_width(_forHeight) {
        const width = Math.min(this._naturalTextWidth(), this._maxWidth);
        return [width, width];
    }

    vfunc_get_preferred_height(_forWidth) {
        return this._box.get_preferred_height(-1);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const availWidth = box.get_width();
        const availHeight = box.get_height();
        const [, boxNat] = this._box.get_preferred_width(-1);
        const [, boxHeight] = this._box.get_preferred_height(-1);

        const child = new Clutter.ActorBox();
        child.x1 = 0;
        child.x2 = this._copy.visible ? boxNat : Math.min(boxNat, availWidth);
        child.y1 = Math.floor((availHeight - boxHeight) / 2);
        child.y2 = child.y1 + boxHeight;
        this._box.allocate(child);
    }

    _restart() {
        const textWidth = this.mapped ? this._naturalTextWidth() : 0;
        const overflow = this.mapped && textWidth > this._maxWidth;
        const animate = overflow && this._scroll && St.Settings.get().enable_animations;

        // style-changed fires on every hover of the panel button; only
        // restart the marquee when something that matters changed.
        const key = `${this._text}|${textWidth}|${this._maxWidth}|${animate}`;
        if (key === this._stateKey)
            return;
        this._stateKey = key;

        this._box.remove_all_transitions();
        this._box.translation_x = 0;
        if (this._copy.visible !== animate) {
            this._copy.visible = animate;
            this.queue_relayout();
        }
        if (!animate)
            return;

        const spacing = this._box.layout_manager.spacing ?? 0;
        const distance = textWidth + spacing;
        this._box.ease({
            translation_x: -distance,
            duration: Math.round(distance * 1000 / SPEED_PX_PER_S),
            delay: START_DELAY_MS,
            mode: Clutter.AnimationMode.LINEAR,
            repeatCount: -1,
        });
    }
});
