/**
 * The message bodies that sit behind the routing prefix.
 *
 * These are transcribed from the two implementations that already speak this
 * protocol — `Script-Engine-Controller/src/webRTCService.mjs` (host side) and
 * `script-studio/src/app/services/web-rtc.service.ts` (client side) — and are
 * the reason this package exists: neither side previously had a name for any of
 * them.
 */

export type TransportRequestType = 'json' | 'chunks' | 'html' | 'chunkstream';

export type TransportMethod = 'GET' | 'POST';

/**
 * A request the client tunnels to a host. The host replays it against its own
 * loopback API (`https://localhost:3849` + `path`) and supplies its own
 * `Authorization` header, so `payload` never carries a credential for the
 * remote machine.
 */
export interface TransportRequest {
    requestId: string | null;
    method: TransportMethod;
    requestType: TransportRequestType;
    path: string;
    payload: Record<string, unknown>;
}

/** Client -> host: open a relay-websocket session with this host. */
export interface InitializationRequest {
    begin: true;
}

/** Host -> client: the session is live, WebRTC negotiation may start. */
export interface InitializationResponse {
    successful: boolean;
    message?: string;
}

/**
 * Host -> client: the peer connection died. The client tears its side down and
 * renegotiates. `status` is an `RTCIceConnectionState`.
 */
export interface ConnectionStatusNotice {
    status: string;
}

/**
 * Every envelope carries the same identity fields as the routing prefix. The
 * relay ignores them, but both endpoints validate `connectionId` against them
 * to drop offers and ice candidates from a superseded negotiation.
 */
export interface EnvelopeIdentity {
    clientDeviceId?: string;
    hostSerial?: string;
    connectionId?: string;
}

export interface TransportEnvelope extends EnvelopeIdentity {
    initialization?: InitializationRequest | InitializationResponse;
    offer?: unknown;
    answer?: unknown;
    ice?: unknown;
    connectionStatus?: ConnectionStatusNotice;
    communication?: unknown;
    /** Relay -> client, once, on connect. Carries no payload; acknowledges auth. */
    setAuthorization?: Record<string, never>;
    /** Host <-> relay round-trip probe. Never addressed to a client. */
    wsHealthCheck?: boolean;
    requestId?: string;
}

/** The `communication` body of a host's reply to a `TransportRequest`. */
export interface TransportResponse {
    requestId: string;
    data?: unknown;
    /**
     * Set by a host when the request failed; `data` is then a
     * `TransportErrorBody` whose `message` is a string. Hosts that predate the
     * flag omit it — see `isLegacyJsonErrorBody` for how their failures look.
     */
    error?: boolean;
    /** The HTTP status the host's local API answered with, when there was one. */
    status?: number;
}

/** `requestType: 'chunks'` — a length announcement followed by indexed parts. */
export interface ChunksTotal {
    totalChunks: number;
}

export interface ChunksPart {
    seq: number;
    data: unknown;
}

/** `requestType: 'chunkstream'` — base64 frames off a Node stream, then eof. */
export interface ChunkStreamPart {
    type: 'chunk';
    chunk: string;
}

export interface ChunkStreamEnd {
    type: 'eof';
}

/**
 * How a host reports failure. `handleClientCommunication` catches, unwraps the
 * axios error, and sends `{ message }` in the data slot — for every requestType,
 * including part-way through a chunk stream.
 */
export interface TransportErrorBody {
    message: unknown;
}

export function isErrorBody(data: unknown): data is TransportErrorBody {
    return !!data && typeof data === 'object' && 'message' in data;
}

/**
 * A 'json' failure from a host that predates `TransportResponse.error`. Those
 * hosts wrap the API's error body a second time, `{ message: { message } }`,
 * so the inner value is an object. A bare `{ message }` cannot be told apart
 * from a successful reply (`{ message: 'reset device ...' }` is one), so only
 * the nested shape counts.
 */
export function isLegacyJsonErrorBody(data: unknown): data is TransportErrorBody {
    if (!isErrorBody(data) || Object.keys(data).length !== 1) {
        return false;
    }
    const inner = data.message;
    return !!inner && typeof inner === 'object' && !Array.isArray(inner);
}

/** Pulls a readable string out of whatever a host put in `message`. */
export function describeErrorMessage(message: unknown): string {
    if (typeof message === 'string') {
        return message;
    }
    if (message && typeof message === 'object') {
        const inner = (message as { message?: unknown }).message;
        if (typeof inner === 'string' && inner) {
            return inner;
        }
        if (inner !== undefined && inner !== message) {
            return describeErrorMessage(inner);
        }
        const code = (message as { code?: unknown }).code;
        if (typeof code === 'string' && code) {
            return code;
        }
    }
    try {
        return JSON.stringify(message) ?? String(message);
    } catch {
        return String(message);
    }
}

/**
 * What a request rejects with when the host reports a failure. `status` is the
 * host API's HTTP status, absent when the host predates it or never got one.
 */
export class TransportRequestError extends Error {
    readonly hostSerial: string;
    readonly path: string;
    readonly status?: number;
    /** The `data` the host sent, untouched. */
    readonly body: unknown;

    constructor(hostSerial: string, path: string, body: unknown, status?: number) {
        super(describeErrorMessage(isErrorBody(body) ? body.message : body));
        this.name = 'TransportRequestError';
        this.hostSerial = hostSerial;
        this.path = path;
        this.status = status;
        this.body = body;
    }
}
