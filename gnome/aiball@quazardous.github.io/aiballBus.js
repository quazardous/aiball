/*
 * One connection to the daemon's bus, over the same Unix socket as the probes.
 *
 * The socket is still the trust boundary: the connection names no consumer and
 * carries no token, and the daemon takes a same-user caller on its socket for
 * the human. libsoup reaches the socket through the session's
 * `remote-connectable`, so the WebSocket is Soup's and none of it is ours.
 *
 * Calls answer a Promise; the daemon's refusal rejects it. Subscription events
 * go to `onEvent`. When the connection ends — the daemon stopped, restarted,
 * or cut it — every call waiting rejects and `onClosed` runs once: the
 * indicator connects again on its next read.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {BUS_PATH, classify, request} from './countersState.js';

const DECODER = new TextDecoder('utf-8');
// Soup refuses a frame over 128 kB by default and closes the connection. The
// frames here are a project list and the board's events; this is a guard
// against a runaway, not a size we expect.
const MAX_FRAME = 4 * 1024 * 1024;

export class AiballBus {
    /**
     * Open a connection and wait for the daemon's hello. Rejects when the
     * socket refuses, or when no hello comes within `timeoutMs`.
     */
    static connect(socketPath, {onEvent = () => {}, onClosed = () => {}, timeoutMs = 5000} = {}) {
        return new Promise((resolve, reject) => {
            const session = new Soup.Session({
                remote_connectable: new Gio.UnixSocketAddress({path: socketPath}),
            });
            const message = Soup.Message.new('GET', `ws://localhost${BUS_PATH}`);
            const cancellable = new Gio.Cancellable();
            let settled = false;
            let bus = null;
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                if (!settled) {
                    settled = true;
                    cancellable.cancel();
                    bus?.close();
                    reject(new Error('no answer from the bus'));
                }
                return GLib.SOURCE_REMOVE;
            });
            session.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                let connection;
                try {
                    connection = s.websocket_connect_finish(res);
                } catch (e) {
                    if (!settled) {
                        settled = true;
                        GLib.source_remove(timer);
                        reject(e);
                    }
                    return;
                }
                bus = new AiballBus(connection, {onEvent, onClosed: () => {
                    if (!settled) {
                        settled = true;
                        GLib.source_remove(timer);
                        reject(new Error('the bus closed before its hello'));
                    }
                    onClosed();
                }, onHello: () => {
                    if (settled) return;
                    settled = true;
                    GLib.source_remove(timer);
                    resolve(bus);
                }});
            });
        });
    }

    constructor(connection, {onEvent, onClosed, onHello}) {
        this._connection = connection;
        this._nextId = 1;
        this._waiting = new Map();
        this._closed = false;
        connection.max_incoming_payload_size = MAX_FRAME;
        connection.connect('message', (_c, type, bytes) => {
            if (type !== Soup.WebsocketDataType.TEXT) return;
            const frame = classify(DECODER.decode(bytes.toArray()));
            if (frame.kind === 'hello') {
                onHello();
            } else if (frame.kind === 'event') {
                onEvent(frame.data);
            } else if (frame.kind === 'reply') {
                const w = this._waiting.get(frame.id);
                if (!w) return;
                this._waiting.delete(frame.id);
                if ('error' in frame) w.reject(new Error(frame.error));
                else w.resolve(frame.result);
            }
        });
        connection.connect('closed', () => {
            if (this._closed) return;
            this._closed = true;
            for (const w of this._waiting.values()) w.reject(new Error('the bus closed'));
            this._waiting.clear();
            onClosed();
        });
    }

    /** Whether the connection still stands. */
    get open() {
        return !this._closed && this._connection.get_state() === Soup.WebsocketState.OPEN;
    }

    /** Call `method`; its result, or a rejection with the daemon's refusal. */
    call(method, params = {}) {
        if (!this.open) return Promise.reject(new Error('the bus is closed'));
        return new Promise((resolve, reject) => {
            const id = this._nextId++;
            this._waiting.set(id, {resolve, reject});
            this._connection.send_text(request(id, method, params));
        });
    }

    close() {
        if (this._connection.get_state() === Soup.WebsocketState.OPEN)
            this._connection.close(Soup.WebsocketCloseCode.NORMAL, null);
    }
}
