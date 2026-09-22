/**
 * The platform primitives `ClientTransport` needs injected.
 *
 * This package compiles without `lib: ["dom"]` because it has to run in the
 * Electron main process as well as the browser, where the three things that
 * differ are the websocket (`ws` vs the global), the peer connection
 * (`@koush/wrtc` vs the global) and how a received frame decodes (Buffer vs
 * Blob). Everything else about the protocol is identical, so those three are
 * the whole adapter surface — plus auth, which lives inside `openWebSocket`.
 *
 * The interfaces are structural on purpose: the real `WebSocket` and
 * `RTCPeerConnection` from either environment satisfy them as-is. That is also
 * why the event-handler *properties* take `any` — TypeScript checks property
 * parameters contravariantly, so declaring `onmessage` as taking `{ data }`
 * would reject the browser's own `WebSocket` and force a cast at every call
 * site. The handlers in `clientConnection.ts` annotate their own parameters, so
 * the `any` stops at this boundary. Methods stay precisely typed: method
 * parameters are bivariant and satisfy both platforms as written.
 */

/** `WebSocket.OPEN` in both the browser and `ws`. */
export const WEBSOCKET_OPEN = 1;

export interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    // `any` on the event parameters is deliberate: see the note above.
    onopen: ((event: any) => void) | null;
    onclose: ((event: any) => void) | null;
    onerror: ((event: any) => void) | null;
    onmessage: ((event: any) => void) | null;
}

export interface RTCDataChannelLike {
    /** 'open' on a real data channel; the numeric websocket states never appear here. */
    readyState: string;
    label: string;
    send(data: string): void;
    close(): void;
    onopen: ((event: any) => void) | null;
    onclose: ((event: any) => void) | null;
    onerror: ((event: any) => void) | null;
    onmessage: ((event: any) => void) | null;
}

export interface RTCPeerConnectionLike {
    iceConnectionState: string;
    signalingState: string;
    localDescription: unknown;
    createDataChannel(label: string): RTCDataChannelLike;
    createOffer(): Promise<unknown>;
    setLocalDescription(description: unknown): Promise<void>;
    setRemoteDescription(description: unknown): Promise<void>;
    addIceCandidate(candidate: unknown): Promise<void>;
    close(): void;
    onicecandidate: ((event: any) => void) | null;
    ondatachannel: ((event: any) => void) | null;
    oniceconnectionstatechange: ((event: any) => void) | null;
}

export interface TransportLogger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export const noopLogger: TransportLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
};

export interface TransportPlatform {
    /**
     * Open the client websocket to the relay. The adapter owns the URL and the
     * credential: script-studio rides on the `google_access_token` cookie, the
     * controller sends `Authorization: Bearer <google access token>`. Either
     * way `script-studio-client-device-id` must be in the query string and
     * `script-studio-host-id` must NOT be a header, or the relay files the
     * connection under `hosts` and no reply ever routes back.
     *
     * May be async so the adapter can refresh a token first. Called again on
     * every reconnect, so a token is never reused past its lifetime.
     */
    openWebSocket(clientDeviceId: string): WebSocketLike | Promise<WebSocketLike>;

    /**
     * Normalize a received frame to text. Defaults to `decodeFrame`, which
     * already handles string, Blob and Buffer; override only for an exotic
     * socket.
     */
    decodeMessageData?(data: unknown): string | Promise<string>;

    createPeerConnection(): RTCPeerConnectionLike;

    /** uuid v4 in canonical 36-char form — the routing prefix depends on the width. */
    generateId(): string;

    /**
     * `wrtc` wants its own `RTCSessionDescription` / `RTCIceCandidate` wrappers
     * where the browser accepts a plain init object. Default is identity.
     */
    toSessionDescription?(init: unknown): unknown;
    toIceCandidate?(init: unknown): unknown;

    logger?: TransportLogger;
}
