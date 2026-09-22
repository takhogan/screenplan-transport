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
