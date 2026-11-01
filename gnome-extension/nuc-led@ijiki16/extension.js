import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const DEVICE = '/proc/acpi/nuc_led';

// WMI codes for NUC6CAY / NUC7i[x]BN (Intel article 000023426)
const METHOD_GET = 0x01;
const METHOD_SET = 0x02;
const LED_POWER = 0x01;
const LED_RING = 0x02;

const EFFECTS = [
    [0x04, 'Solid'],
    [0x01, 'Blink 1 Hz'],
    [0x05, 'Blink 0.5 Hz'],
    [0x02, 'Blink 0.25 Hz'],
    [0x03, 'Fade 1 Hz'],
    [0x07, 'Fade 0.5 Hz'],
    [0x06, 'Fade 0.25 Hz'],
];

// [code, label, css color for the panel icon]
const RING_COLORS = [
    [0x01, 'Cyan', '#00e5ff'],
    [0x02, 'Pink', '#ff4fb8'],
    [0x03, 'Yellow', '#ffe14f'],
    [0x04, 'Blue', '#4f8bff'],
    [0x05, 'Red', '#ff4f4f'],
    [0x06, 'Green', '#4fff7a'],
    [0x07, 'White', '#ffffff'],
];

const POWER_COLORS = [
    [0x01, 'Blue', '#4f8bff'],
    [0x02, 'Amber', '#ffb04f'],
];

const ERRORS = {
    0xe1: 'function not supported',
    0xe2: 'undefined device (is the LED set to SW control in BIOS?)',
    0xe3: 'embedded controller not responding',
    0xe4: 'invalid parameter',
    0xef: 'unexpected error',
};

function errorText(code) {
    return ERRORS[code] ?? `error 0x${code.toString(16)}`;
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// Run a Gio *_async method and resolve with its *_finish result
function gioAsync(object, method, ...args) {
    return new Promise((resolve, reject) => {
        object[`${method}_async`](...args, (obj, res) => {
            try {
                resolve(obj[`${method}_finish`](res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Write 5 bytes to the driver and return the 4 result bytes
async function wmiCall(bytes, cancellable) {
    const line = `${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}\n`;
    const file = Gio.File.new_for_path(DEVICE);

    const stream = await gioAsync(file, 'append_to',
        Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    await gioAsync(stream, 'write_bytes',
        new GLib.Bytes(new TextEncoder().encode(line)), GLib.PRIORITY_DEFAULT, cancellable);
    await gioAsync(stream, 'close', GLib.PRIORITY_DEFAULT, cancellable);

    const [, contents] = await gioAsync(file, 'load_contents', cancellable);
    cancellable.set_error_if_cancelled();
    return new TextDecoder().decode(contents)
        .replace(/\0/g, '').trim().split(/\s+/).map(h => parseInt(h, 16));
}

class LedSection {
    constructor(indicator, led, title, colors) {
        this._indicator = indicator;
        this._led = led;
        this._colors = colors;
        this._lastColor = colors[0][0];
        this.state = {brightness: 100, effect: 0x04, color: 0x00};
        this._sliderTimeoutId = 0;
        this._updatingSlider = false;

        const menu = indicator.menu;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));

        this._switch = new PopupMenu.PopupSwitchMenuItem('On', false);
        this._switch.connect('toggled', (_item, on) => {
            this.apply({color: on ? this._lastColor : 0x00});
        });
        menu.addMenuItem(this._switch);

        const sliderItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        sliderItem.add_child(new St.Icon({
            icon_name: 'display-brightness-symbolic',
            style_class: 'popup-menu-icon',
        }));
        this._slider = new Slider(1);
        this._slider.x_expand = true;
        this._slider.connect('notify::value', () => this._onSliderChanged());
        sliderItem.add_child(this._slider);
        menu.addMenuItem(sliderItem);

        this._colorMenu = new PopupMenu.PopupSubMenuMenuItem('Color');
        this._colorItems = colors.map(([code, label, css]) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.insert_child_at_index(new St.Icon({
                icon_name: 'media-record-symbolic',
                style_class: 'popup-menu-icon',
                style: `color: ${css};`,
            }), 1);
            item.connect('activate', () => this.apply({color: code}));
            this._colorMenu.menu.addMenuItem(item);
            return [code, item];
        });
        menu.addMenuItem(this._colorMenu);

        this._effectMenu = new PopupMenu.PopupSubMenuMenuItem('Effect');
        this._effectItems = EFFECTS.map(([code, label]) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this.apply({effect: code}));
            this._effectMenu.menu.addMenuItem(item);
            return [code, item];
        });
        menu.addMenuItem(this._effectMenu);
    }

    async refresh() {
        const r = await this._indicator.call([METHOD_GET, this._led, 0, 0, 0]);
        if (r[0] !== 0x00)
            throw new Error(errorText(r[0]));
        this.state = {brightness: r[1], effect: r[2], color: r[3]};
        this._sync();
    }

    async apply(changes) {
        const s = {...this.state, ...changes};
        try {
            const r = await this._indicator.call(
                [METHOD_SET, this._led, s.brightness, s.effect, s.color]);
            const bad = r.slice(0, 3).find(b => b !== 0x00);
            if (bad !== undefined)
                throw new Error(`Setting LED failed: ${errorText(bad)}`);
            this.state = s;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._indicator.showError(e);
        }
        this._sync();
    }

    colorCss() {
        return this._colors.find(([code]) => code === this.state.color)?.[2] ?? null;
    }

    _sync() {
        const {brightness, effect, color} = this.state;
        if (color)
            this._lastColor = color;

        this._switch.setToggleState(color !== 0x00);

        this._updatingSlider = true;
        this._slider.value = Math.min(brightness, 100) / 100;
        this._updatingSlider = false;

        const colorLabel = this._colors.find(([c]) => c === color)?.[1] ?? 'Off';
        this._colorMenu.label.text = `Color: ${colorLabel}`;
        for (const [code, item] of this._colorItems)
            item.setOrnament(code === color ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);

        const effectLabel = EFFECTS.find(([c]) => c === effect)?.[1] ?? 'Unknown';
        this._effectMenu.label.text = `Effect: ${effectLabel}`;
        for (const [code, item] of this._effectItems)
            item.setOrnament(code === effect ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);

        this._indicator.updateIcon();
    }

    // Send the brightness once the slider has stopped moving for 150 ms
    _onSliderChanged() {
        if (this._updatingSlider)
            return;
        if (this._sliderTimeoutId)
            GLib.source_remove(this._sliderTimeoutId);
        this._sliderTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._sliderTimeoutId = 0;
            this.apply({brightness: Math.round(this._slider.value * 100)});
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._sliderTimeoutId)
            GLib.source_remove(this._sliderTimeoutId);
        this._sliderTimeoutId = 0;
    }
}

const NucLedIndicator = GObject.registerClass(
class NucLedIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, 'NUC LED Control');

        this._cancellable = new Gio.Cancellable();
        // The driver has one shared result buffer, so calls must not overlap
        this._queue = Promise.resolve();

        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(
                Gio.File.new_for_path(`${extensionPath}/icons/nuc-ring-symbolic.svg`)),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._errorItem = new PopupMenu.PopupImageMenuItem('', 'dialog-warning-symbolic',
            {reactive: false});
        this._errorItem.label.clutter_text.line_wrap = true;
        this._errorItem.visible = false;
        this.menu.addMenuItem(this._errorItem);

        this._ring = new LedSection(this, LED_RING, 'Ring LED', RING_COLORS);
        this._power = new LedSection(this, LED_POWER, 'Power Button LED', POWER_COLORS);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.refresh();
        });

        this.refresh();
    }

    call(bytes) {
        const result = this._queue.then(() => wmiCall(bytes, this._cancellable));
        this._queue = result.catch(() => {});
        return result;
    }

    async refresh() {
        this._errorItem.visible = false;
        try {
            await this._ring.refresh();
            await this._power.refresh();
        } catch (e) {
            if (!isCancelled(e))
                this.showError(e);
        }
    }

    showError(e) {
        let msg = e.message;
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            msg = 'nuc_led kernel module is not loaded';
        else if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
            msg = `No permission to write ${DEVICE}`;
        this._errorItem.label.text = msg;
        this._errorItem.visible = true;
        console.warn(`NUC LED: ${msg}`);
    }

    updateIcon() {
        const css = this._ring.colorCss();
        this._icon.style = css ? `color: ${css};` : null;
    }

    destroy() {
        // Stops in-flight calls; their handlers return early on CANCELLED
        this._cancellable.cancel();
        this._ring.destroy();
        this._power.destroy();
        super.destroy();
    }
});

export default class NucLedExtension extends Extension {
    enable() {
        this._indicator = new NucLedIndicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
