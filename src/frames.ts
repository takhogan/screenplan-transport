/**
 * One frame decoder for both environments, so neither adapter has to carry its
 * own. A relay frame arrives as a string, as a Blob (browser websockets and
 * data channels), or as a Buffer / ArrayBuffer view (`ws` in Node).
 */
export function decodeFrame(data: unknown): string | Promise<string> {
    if (typeof data === 'string') {
        return data;
    }
    // Blob, without needing the DOM lib to name it.
    if (!!data && typeof (data as { text?: unknown }).text === 'function') {
        return (data as { text(): Promise<string> }).text();
    }
    if (!!data && typeof (data as { toString?: unknown }).toString === 'function') {
        return String(data);
    }
    throw new Error(`transport: cannot decode a frame of type ${typeof data}`);
}
