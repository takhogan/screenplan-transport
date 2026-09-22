import {
    BLANK_REQUEST_ID,
    decodeMessage,
    encodeMessage,
    padHostSerial
} from '../dist/index.js';

let idCounter = 0;

/** Deterministic 36-char ids so assertions can name them. */
export function fakeId() {
    idCounter += 1;
    return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

export function resetIds() {
    idCounter = 0;
}

export class FakeWebSocket {
    constructor() {
        this.readyState = 1; // OPEN
        this.sent = [];
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        this.onSend = null;
    }

    send(data) {
        if (this.readyState !== 1) {
            throw new Error('FakeWebSocket: send on a closed socket');
        }
        this.sent.push(data);
        if (this.onSend) {
            this.onSend(data);
        }
    }

    close() {
        this.readyState = 3;
        if (this.onclose) {
            this.onclose({});
        }
    }

    /** Deliver a frame to the client. */
    receive(text) {
        if (this.onmessage) {
            this.onmessage({ data: text });
        }
    }

    /** Every frame the client sent, decoded. */
    decodedSent() {
        return this.sent.map((raw) => {
            const decoded = decodeMessage(raw);
            return { ...decoded, envelope: JSON.parse(decoded.body) };
        });
    }
}

export class FakeDataChannel {
    constructor(label) {
        this.label = label;
        this.readyState = 'connecting';
        this.sent = [];
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
    }

    send(data) {
        if (this.readyState !== 'open') {
            throw new Error('FakeDataChannel: send on a channel that is not open');
        }
        this.sent.push(data);
    }

    close() {
        this.readyState = 'closed';
        if (this.onclose) {
            this.onclose({});
        }
    }

    open() {
        this.readyState = 'open';
        if (this.onopen) {
            this.onopen({});
        }
    }

    receive(text) {
        if (this.onmessage) {
            this.onmessage({ data: text });
        }
    }

    decodedSent() {
        return this.sent.map((raw) => {
            const decoded = decodeMessage(raw);
            return { ...decoded, envelope: JSON.parse(decoded.body) };
        });
    }
}

export class FakePeerConnection {
    constructor() {
        this.iceConnectionState = 'new';
        this.signalingState = 'stable';
        this.localDescription = null;
        this.remoteDescription = null;
        this.addedIceCandidates = [];
        this.channels = [];
        this.closed = false;
        this.onicecandidate = null;
        this.ondatachannel = null;
        this.oniceconnectionstatechange = null;
    }

    createDataChannel(label) {
        const channel = new FakeDataChannel(label);
        this.channels.push(channel);
        return channel;
    }

    async createOffer() {
        return { type: 'offer', sdp: 'fake-offer' };
    }

    async setLocalDescription(description) {
        this.localDescription = description;
    }

    async setRemoteDescription(description) {
        this.remoteDescription = description;
    }

    async addIceCandidate(candidate) {
        if (!this.remoteDescription) {
            throw new Error('FakePeerConnection: addIceCandidate before setRemoteDescription');
        }
        this.addedIceCandidates.push(candidate);
    }

    close() {
        this.closed = true;
        this.signalingState = 'closed';
    }

    /** Drive the host's half: answer, connect, and open the return channel. */
    completeNegotiation() {
        this.iceConnectionState = 'connected';
        if (this.oniceconnectionstatechange) {
            this.oniceconnectionstatechange({});
        }
        for (const channel of this.channels) {
            channel.open();
        }
        const returnChannel = new FakeDataChannel('returnChannel');
        if (this.ondatachannel) {
            this.ondatachannel({ channel: returnChannel });
        }
        returnChannel.open();
        this.returnChannel = returnChannel;
        return returnChannel;
    }

    emitIceCandidate(candidate) {
        if (this.onicecandidate) {
            this.onicecandidate({ candidate });
        }
    }
}

/**
 * Stands in for the relay plus a host: reads what the client sent over the fake
 * websocket and replies with the frames `webRTCService.mjs` would.
 */
export class FakeHost {
    constructor(socket, hostSerial, clientDeviceId) {
        this.socket = socket;
        this.hostSerial = hostSerial;
        this.paddedHostSerial = padHostSerial(hostSerial);
        this.clientDeviceId = clientDeviceId;
        this.connectionId = null;
        this.autoAcceptInitialization = true;
        this.socket.onSend = (raw) => this.handle(raw);
    }

    handle(raw) {
        const { requestId, body } = decodeMessage(raw);
        const envelope = JSON.parse(body);
        if (requestId !== BLANK_REQUEST_ID) {
            return;
        }
        if (envelope.initialization && envelope.initialization.begin) {
            this.connectionId = envelope.connectionId;
            if (this.autoAcceptInitialization) {
                this.sendSetup({ initialization: { successful: true } });
            }
        }
        if (envelope.offer) {
            this.offer = envelope.offer;
            this.sendSetup({ answer: { type: 'answer', sdp: 'fake-answer' } });
        }
    }

    sendSetup(envelope, connectionIdOverride) {
        this.socket.receive(
            encodeMessage(
                {
                    requestId: BLANK_REQUEST_ID,
                    clientDeviceId: this.clientDeviceId,
                    hostSerial: this.paddedHostSerial
                },
                {
                    clientDeviceId: this.clientDeviceId,
                    hostSerial: this.hostSerial,
                    connectionId:
                        connectionIdOverride !== undefined ? connectionIdOverride : this.connectionId,
                    ...envelope
                }
            )
        );
    }

    /** A `communication` reply, over the websocket or a given data channel. */
    respond(requestId, data, channel) {
        const frame = encodeMessage(
            {
                requestId,
                clientDeviceId: this.clientDeviceId,
                hostSerial: this.paddedHostSerial
            },
            {
                clientDeviceId: this.clientDeviceId,
                hostSerial: this.hostSerial,
                communication: { requestId, data }
            }
        );
        if (channel) {
            channel.receive(frame);
        } else {
            this.socket.receive(frame);
        }
    }

    /** The relay's own on-connect acknowledgement. */
    sendSetAuthorization() {
        this.socket.receive(
            encodeMessage(
                {
                    requestId: BLANK_REQUEST_ID,
                    clientDeviceId: this.clientDeviceId,
                    hostSerial: '                    '
                },
                { setAuthorization: {} }
            )
        );
    }
}

export function silentLogger() {
    const calls = { debug: [], info: [], warn: [], error: [] };
    return {
        logger: {
            debug: (...args) => calls.debug.push(args),
            info: (...args) => calls.info.push(args),
            warn: (...args) => calls.warn.push(args),
            error: (...args) => calls.error.push(args)
        },
        calls
    };
}
