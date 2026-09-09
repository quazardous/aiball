/*
 * Minimal HTTP/1.1 over the aiball Unix socket.
 *
 * Why not libsoup: the daemon's local-trust boundary IS the socket. A client
 * on the port needs a bearer token; a same-uid client on the socket does not,
 * because the OS already enforced who may open it. Speaking to the socket is
 * therefore what keeps this extension free of any credential — and libsoup
 * does not make a Unix socket convenient, whereas Gio makes it three calls.
 *
 * The responses we ask for are small JSON documents with `Connection: close`,
 * so "read until EOF, split on the blank line, parse the rest" is the whole
 * protocol we need. No chunked decoding, no keep-alive, no redirects.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const DECODER = new TextDecoder('utf-8');

/** Default socket path, mirroring the daemon's own default. */
export function defaultSocketPath() {
    const home = GLib.getenv('AIBALL_HOME');
    if (home) return GLib.build_filenamev([home, 'sock']);
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'aiball', 'sock']);
}

/**
 * GET `path` and parse the JSON body.
 *
 * Rejects rather than returning a shape on any failure — a daemon that is down
 * is the NORMAL case here, and the caller renders it as a state rather than an
 * error dialog.
 */
export async function getJson(socketPath, path, cancellable = null) {
    const client = new Gio.SocketClient();
    const address = new Gio.UnixSocketAddress({path: socketPath});
    const connection = await client.connect_async(address, cancellable);
    try {
        const request =
            `GET ${path} HTTP/1.1\r\n` +
            'Host: localhost\r\n' +
            'Accept: application/json\r\n' +
            'Connection: close\r\n\r\n';
        await connection.get_output_stream().write_all_async(
            new TextEncoder().encode(request), GLib.PRIORITY_DEFAULT, cancellable);

        const input = connection.get_input_stream();
        const chunks = [];
        let total = 0;
        for (;;) {
            const bytes = await input.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (size === 0) break;
            chunks.push(bytes.get_data());
            total += size;
            // A guard, not a limit we expect to reach: the documents we ask
            // for are a few kB. It exists so a wedged daemon cannot grow the
            // shell's heap without bound.
            if (total > 1024 * 1024) throw new Error('response too large');
        }
        const raw = DECODER.decode(concat(chunks, total));
        const split = raw.indexOf('\r\n\r\n');
        if (split < 0) throw new Error('malformed response (no header terminator)');
        const status = Number(raw.slice(0, raw.indexOf('\r\n')).split(' ')[1]);
        if (status !== 200) throw new Error(`HTTP ${status}`);
        return JSON.parse(raw.slice(split + 4));
    } finally {
        connection.close(null);
    }
}

function concat(chunks, total) {
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}
