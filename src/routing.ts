/**
 * The fixed-width routing prefix every message on the relay carries.
 *
 * `script-studio-backend-websocket` routes purely on byte offsets — it never
 * parses the JSON body (see `initializeWebSocketServer`'s `ws.on('message')`).
 * So the prefix layout is a hard contract between three codebases, and the
 * offsets were previously open-coded as `substring(0, 36)` / `substring(36, 72)`
 * / `substring(72, 92)` / `substring(92)` in every one of them.
 *
 *   [0, 36)  requestId        uuid v4, or BLANK_REQUEST_ID for setup traffic
 *   [36, 72) clientDeviceId   uuid v4 identifying the calling client
 *   [72, 92) hostSerial       cert serial, last 20 chars, space-padded left
 *   [92, )   body             JSON
 *
 * Both id fields are exactly 36 characters because a uuid v4 in canonical form
 * is 36 characters. Nothing validates this on the relay — a short id silently
 * shifts every later field — so `encodePrefix` asserts the widths instead.
 */

export const REQUEST_ID_LENGTH = 36;
export const CLIENT_DEVICE_ID_LENGTH = 36;
export const HOST_SERIAL_LENGTH = 20;
export const ROUTING_PREFIX_LENGTH =
    REQUEST_ID_LENGTH + CLIENT_DEVICE_ID_LENGTH + HOST_SERIAL_LENGTH;

const REQUEST_ID_OFFSET = 0;
const CLIENT_DEVICE_ID_OFFSET = REQUEST_ID_LENGTH;
const HOST_SERIAL_OFFSET = CLIENT_DEVICE_ID_OFFSET + CLIENT_DEVICE_ID_LENGTH;

/**
 * Setup traffic (initialization, offer, answer, ice, connectionStatus) carries a
 * blank requestId. Clients use it to tell a connection-setup message apart from
 * a response to one of their requests, so it must never collide with a uuid.
 */
export const BLANK_REQUEST_ID = ' '.repeat(REQUEST_ID_LENGTH);

/**
 * The relay short-circuits a message whose clientDeviceId is all zeroes back to
 * its sender instead of routing it, which is how the host websocket healthcheck
 * measures the round trip.
 */
export const NULL_CLIENT_DEVICE_ID = '0'.repeat(CLIENT_DEVICE_ID_LENGTH);

/** What the relay itself sends in the hostSerial slot (`BLANK_HOST_ID`). */
export const BLANK_HOST_SERIAL = ' '.repeat(HOST_SERIAL_LENGTH);

export interface RoutingPrefix {
    requestId: string;
    clientDeviceId: string;
    hostSerial: string;
}

export interface DecodedMessage extends RoutingPrefix {
    /** The JSON text after the prefix, unparsed. */
    body: string;
}

/**
 * Cert serials are longer than the 20-char slot, so the wire form is the last 20
 * characters. Everything that indexes a connection map by host has to agree on
 * this, hence one implementation.
 *
 * Note this is lossy and not reversible: keep the caller's original serial
 * around for anything user-facing or for comparing against `certSerialNumber`.
 */
export function padHostSerial(hostSerial: string): string {
    return hostSerial.slice(-HOST_SERIAL_LENGTH).padStart(HOST_SERIAL_LENGTH, ' ');
}

export function encodePrefix(prefix: RoutingPrefix): string {
    const requestId = prefix.requestId ?? BLANK_REQUEST_ID;
    if (requestId.length !== REQUEST_ID_LENGTH) {
        throw new Error(
            `routing: requestId must be ${REQUEST_ID_LENGTH} chars, got ${requestId.length} (${requestId})`
        );
    }
    if (prefix.clientDeviceId.length !== CLIENT_DEVICE_ID_LENGTH) {
        throw new Error(
            `routing: clientDeviceId must be ${CLIENT_DEVICE_ID_LENGTH} chars, got ` +
            `${prefix.clientDeviceId.length} (${prefix.clientDeviceId})`
        );
    }
    return requestId + prefix.clientDeviceId + padHostSerial(prefix.hostSerial);
}

/** Prefix + JSON body, ready to hand to `socket.send`. */
export function encodeMessage(prefix: RoutingPrefix, body: unknown): string {
    return encodePrefix(prefix) + JSON.stringify(body);
}

export function decodeMessage(raw: string): DecodedMessage {
    if (raw.length < ROUTING_PREFIX_LENGTH) {
        throw new Error(
            `routing: message shorter than the ${ROUTING_PREFIX_LENGTH}-char routing prefix (${raw.length})`
        );
    }
    return {
        requestId: raw.substring(REQUEST_ID_OFFSET, REQUEST_ID_OFFSET + REQUEST_ID_LENGTH),
        clientDeviceId: raw.substring(
            CLIENT_DEVICE_ID_OFFSET,
            CLIENT_DEVICE_ID_OFFSET + CLIENT_DEVICE_ID_LENGTH
        ),
        hostSerial: raw.substring(HOST_SERIAL_OFFSET, HOST_SERIAL_OFFSET + HOST_SERIAL_LENGTH),
        body: raw.substring(ROUTING_PREFIX_LENGTH)
    };
}

/** True for connection-setup traffic rather than a response to a request. */
export function isSetupMessage(requestId: string): boolean {
    return requestId === BLANK_REQUEST_ID;
}
