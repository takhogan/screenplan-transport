import {
    BLANK_REQUEST_ID,
    decodeMessage,
    encodeMessage,
    isSetupMessage,
    padHostSerial
} from './routing';
import {
    isErrorBody,
    isLegacyJsonErrorBody,
    TransportEnvelope,
    TransportRequest,
    TransportRequestError,
    TransportResponse
} from './protocol';
import {
    noopLogger,
    RTCDataChannelLike,
    RTCPeerConnectionLike,
    TransportLogger,
    TransportPlatform,
    WEBSOCKET_OPEN,
    WebSocketLike
} from './platform';
import { Emitter } from './emitter';
import { decodeFrame } from './frames';

/** Lifecycle of one leg (relay websocket or peer connection) to one host. */
export type ChannelState = 'pending' | 'initializing' | 'completed';

export type TransportKind = 'websocket' | 'webrtc';

/**
 * Status strings are the ones script-studio's dashboard already renders, kept
 * verbatim so the UI needs no changes: 'initiating', 'connected',
 * 'answer received', 'connection completed', 'connection failed'.
 */
export interface StatusEvent {
    /** The caller's original host serial, NOT the 20-char padded wire form. */
    hostSerial: string;
    transport: TransportKind;
    status: string;
}

export interface ClientTransportEvents extends Record<string, unknown> {
    status: StatusEvent;
}

export interface ClientTransportOptions {
    platform: TransportPlatform;
    /**
     * Identifies this client to the relay for the life of the process. Must be
     * 36 characters. A controller acting as a client generates one per run, the
     * same as the browser client does.
     */
    clientDeviceId: string;
    iceServers?: unknown[];
    /**
     * Reject a request that goes unanswered this long. 0 (the default) waits
     * forever, which is script-studio's behaviour — a UI with a spinner and a
     * user who can retry. Anything driving this from an agent or a CLI should
     * set a real bound.
     */
    requestTimeoutMs?: number;
    /**
     * Give up waiting for a connection after this long. 0 (the default) retries
     * with exponential backoff forever, again matching script-studio.
     */
    connectTimeoutMs?: number;
    /**
     * How long the host waits for our offer before dropping its peer
     * connection is 5 minutes; this is our side of that deadline.
     */
    webRTCNegotiationTimeoutMs?: number;
}

interface PendingRequest {
    request: TransportRequest;
    hostSerial: string;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    settled: boolean;
    chunks: unknown[];
    chunksReceived: number;
    totalChunks?: number;
    timeout?: ReturnType<typeof setTimeout>;
}

interface HostConnection {
    /** As the caller supplied it — what status events and errors report. */
    hostSerial: string;
    /** The 20-char wire form, and the key of `hostConnections`. */
    paddedHostSerial: string;
    connectionId: string | null;
    websocketState: ChannelState;
    webRTCState: ChannelState;
    pc: RTCPeerConnectionLike | null;
    requestChannel: RTCDataChannelLike | null;
    returnChannel: RTCDataChannelLike | null;
    answerReceived: boolean;
    /**
     * Candidates the host sends before its answer arrives. `addIceCandidate`
     * before `setRemoteDescription` throws, so they queue here and flush once
     * the answer is applied.
     */
    pendingIceCandidates: unknown[];
    negotiationTimeout?: ReturnType<typeof setTimeout>;
}

const DEFAULT_ICE_SERVERS: unknown[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * The client half of the ScreenPlan relay protocol.
 *
 * One websocket to the relay carries setup traffic and requests for every host;
 * each host additionally gets a peer connection negotiated over that websocket.
 * Requests take whichever transport is ready at send time, so the first request
 * to a host goes over the relay immediately rather than waiting out the several
 * seconds ICE can take, and later ones switch to WebRTC once its data channel
 * opens. This is script-studio's existing behaviour, generalized so the
 * controller can be a client too.
 *
 * Every method is safe to call before `start()` resolves.
 */
export class ClientTransport {
    readonly clientDeviceId: string;

    private readonly platform: TransportPlatform;
    private readonly logger: TransportLogger;
    private readonly iceServers: unknown[];
    private readonly requestTimeoutMs: number;
    private readonly connectTimeoutMs: number;
    private readonly webRTCNegotiationTimeoutMs: number;

    private ws: WebSocketLike | null = null;
    private deviceWebsocketState: ChannelState = 'pending';
    private reconnecting = false;
    private closed = false;

    private readonly hostConnections = new Map<string, HostConnection>();
    /** requestId -> in-flight request. Flat, because requestIds are globally unique. */
    private readonly pendingRequests = new Map<string, PendingRequest>();
    private readonly emitter = new Emitter<ClientTransportEvents>();

    constructor(options: ClientTransportOptions) {
        this.platform = options.platform;
        this.logger = options.platform.logger ?? noopLogger;
        this.clientDeviceId = options.clientDeviceId;
        this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 0;
        this.webRTCNegotiationTimeoutMs = options.webRTCNegotiationTimeoutMs ?? 300000;
    }

    on<K extends keyof ClientTransportEvents>(
        event: K,
        listener: (payload: ClientTransportEvents[K]) => void
    ): () => void {
        return this.emitter.on(event, listener);
    }

    /** Opens the relay websocket. Resolves once it is open. */
    async start(): Promise<void> {
        this.closed = false;
        await this.openDeviceWebsocket();
    }

    getHostState(hostSerial: string): { websocket: ChannelState; webRTC: ChannelState } {
        const connection = this.hostConnections.get(padHostSerial(hostSerial));
        return {
            websocket: connection?.websocketState ?? 'pending',
            webRTC: connection?.webRTCState ?? 'pending'
        };
    }

    // ---------------------------------------------------------------- requests

    /**
     * Tunnels one request to `hostSerial` and resolves with the host's payload:
     * the `data` field for 'json' and 'html', the assembled part array for
     * 'chunks' and 'chunkstream'. A failure the host reports rejects with a
     * `TransportRequestError` (older hosts' 'chunks' and 'chunkstream' errors
     * still reject with the bare message).
     *
     * With `awaitCreation` false and no connection yet, this rejects rather than
     * waiting — the polling callers in script-studio rely on that to skip a tick
     * instead of queueing work against a host that is still coming up.
     */
    async doRequest(
        hostSerial: string,
        request: TransportRequest,
        awaitCreation = false
    ): Promise<unknown> {
        const connection = await this.ensureConnection(hostSerial, awaitCreation);
        if (!connection) {
            throw new Error(`ClientTransport: host connection ${hostSerial} uninitialized`);
        }

        const requestId = this.platform.generateId();
        request.requestId = requestId;

        const channel = this.selectChannel(connection);
        if (!channel) {
            throw new Error(`ClientTransport: no channel available for host ${hostSerial}`);
        }

        return new Promise<unknown>((resolve, reject) => {
            const pending: PendingRequest = {
                request,
                hostSerial: connection.hostSerial,
                resolve,
                reject,
                settled: false,
                chunks: [],
                chunksReceived: 0
            };
            if (this.requestTimeoutMs > 0) {
                pending.timeout = setTimeout(() => {
                    this.settle(requestId, pending, () =>
                        reject(
                            new Error(
                                `ClientTransport: request ${requestId} to ${connection.hostSerial} ` +
                                `(${request.method} ${request.path}) timed out after ${this.requestTimeoutMs}ms`
                            )
                        )
                    );
                }, this.requestTimeoutMs);
            }
            this.pendingRequests.set(requestId, pending);

            const message = encodeMessage(
                {
                    requestId,
                    clientDeviceId: this.clientDeviceId,
                    hostSerial: connection.paddedHostSerial
                },
                {
                    hostSerial: connection.hostSerial,
                    clientDeviceId: this.clientDeviceId,
                    communication: request
                }
            );

            this.logger.debug(
                `ClientTransport: sending ${requestId} to ${connection.hostSerial} ` +
                `over ${channel.kind}: ${request.method} ${request.path}`
            );
            try {
                channel.send(message);
            } catch (error) {
                this.settle(requestId, pending, () => reject(error));
            }
        });
    }

    private selectChannel(
        connection: HostConnection
    ): { kind: TransportKind; send: (message: string) => void } | null {
        if (this.webRTCReady(connection)) {
            const channel = connection.requestChannel!;
            return { kind: 'webrtc', send: (message) => channel.send(message) };
        }
        if (this.websocketReady(connection)) {
            const ws = this.ws!;
            return { kind: 'websocket', send: (message) => ws.send(message) };
        }
        return null;
    }

    private websocketReady(connection: HostConnection): boolean {
        return (
            connection.websocketState === 'completed' &&
            !!this.ws &&
            this.ws.readyState === WEBSOCKET_OPEN
        );
    }

    private webRTCReady(connection: HostConnection): boolean {
        return (
            connection.webRTCState === 'completed' &&
            !!connection.pc &&
            (connection.pc.iceConnectionState === 'connected' ||
                connection.pc.iceConnectionState === 'completed') &&
            !!connection.requestChannel &&
            connection.requestChannel.readyState === 'open'
        );
    }

    // ------------------------------------------------------------- connections

    private getOrCreateConnection(hostSerial: string): HostConnection {
        const paddedHostSerial = padHostSerial(hostSerial);
        let connection = this.hostConnections.get(paddedHostSerial);
        if (!connection) {
            connection = {
                hostSerial,
                paddedHostSerial,
                connectionId: null,
                websocketState: 'pending',
                webRTCState: 'pending',
                pc: null,
                requestChannel: null,
                returnChannel: null,
                answerReceived: false,
                pendingIceCandidates: []
            };
            this.hostConnections.set(paddedHostSerial, connection);
        }
        return connection;
    }

    private async ensureConnection(
        hostSerial: string,
        awaitCreation: boolean
    ): Promise<HostConnection | null> {
        const connection = this.getOrCreateConnection(hostSerial);

        // Steady state, and deliberately first: re-running the relay handshake
        // makes the host close its peer connection and negotiate a new one, so
        // a live data channel must not be disturbed by a websocket that
        // reconnected underneath it.
        if (this.webRTCReady(connection)) {
            return connection;
        }

        if (!(await this.awaitDeviceWebsocket(awaitCreation))) {
            return null;
        }

        if (this.websocketReady(connection)) {
            // A peer connection that completed and then died gets renegotiated.
            if (connection.webRTCState === 'completed') {
                void this.createWebRTCConnection(connection);
            }
            return connection;
        }

        if (connection.websocketState === 'pending') {
            this.sendInitialization(connection);
        }
        if (!awaitCreation) {
            return null;
        }

        const ready = await this.waitFor(() => this.websocketReady(connection));
        if (!ready) {
            // Back to 'pending' so the next attempt re-sends the handshake.
            // Without this a host that missed one initialization stays stuck in
            // 'initializing', which the branch above skips, and every later
            // request waits out the connect timeout for a handshake that will
            // never be sent again.
            connection.websocketState = 'pending';
            return null;
        }
        if (connection.webRTCState === 'pending') {
            // Not awaited: requests ride the relay websocket until ICE lands.
            void this.createWebRTCConnection(connection);
        }
        return connection;
    }

    private async awaitDeviceWebsocket(awaitCreation: boolean): Promise<boolean> {
        if (this.deviceWebsocketState === 'completed') {
            return true;
        }
        if (this.deviceWebsocketState === 'pending' && !this.reconnecting) {
            void this.openDeviceWebsocket();
        }
        if (!awaitCreation) {
            return false;
        }
        return this.waitFor(() => this.deviceWebsocketState === 'completed');
    }

    /**
     * Exponential backoff poll, capped at 60s a tick.
     *
     * The backoff starts at 25ms rather than the 2s the browser client used.
     * A host that is already up acknowledges the handshake in the same tick the
     * request was sent, but the acknowledgement is processed on a microtask — so
     * the first poll always missed it, and `1000 * 2 ** 1` then charged two
     * seconds of latency to every first request against a live host.
     */
    private async waitFor(predicate: () => boolean): Promise<boolean> {
        const deadline = this.connectTimeoutMs > 0 ? Date.now() + this.connectTimeoutMs : 0;
        let attempts = 0;
        while (!predicate()) {
            if (this.closed) {
                return false;
            }
            if (deadline && Date.now() >= deadline) {
                return false;
            }
            let delay = Math.min(25 * Math.pow(2, attempts), 60000);
            if (deadline) {
                delay = Math.min(delay, Math.max(deadline - Date.now(), 0));
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            attempts += 1;
        }
        return true;
    }

    private sendInitialization(connection: HostConnection): void {
        connection.websocketState = 'initializing';
        connection.connectionId = this.platform.generateId();
        this.emitStatus(connection, 'websocket', 'initiating');
        this.logger.info(
            `ClientTransport: opening relay session ${connection.connectionId} with host ${connection.hostSerial}`
        );
        this.sendSetup(connection, { initialization: { begin: true } });
    }

    private sendSetup(connection: HostConnection, envelope: TransportEnvelope): void {
        if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) {
            this.logger.warn(
                `ClientTransport: cannot send setup message to ${connection.hostSerial}, relay websocket is closed`
            );
            return;
        }
        const message = encodeMessage(
            {
                requestId: BLANK_REQUEST_ID,
                clientDeviceId: this.clientDeviceId,
                hostSerial: connection.paddedHostSerial
            },
            {
                clientDeviceId: this.clientDeviceId,
                hostSerial: connection.hostSerial,
                connectionId: connection.connectionId,
                ...envelope
            }
        );
        try {
            this.ws.send(message);
        } catch (error) {
            this.logger.error(
                `ClientTransport: error sending setup message to ${connection.hostSerial}`,
                error
            );
        }
    }

    // ---------------------------------------------------------------- websocket

    private async openDeviceWebsocket(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.deviceWebsocketState = 'initializing';
        let ws: WebSocketLike;
        try {
            ws = await this.platform.openWebSocket(this.clientDeviceId);
        } catch (error) {
            this.deviceWebsocketState = 'pending';
            this.logger.error('ClientTransport: failed to open relay websocket', error);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onerror = (error: unknown) => {
            this.logger.error('ClientTransport: relay websocket error', error);
        };

        ws.onclose = () => {
            if (this.closed) {
                return;
            }
            this.logger.warn('ClientTransport: relay websocket closed, reconnecting');
            this.deviceWebsocketState = 'pending';
            // Relay sessions do not survive the socket: the next request to a
            // host whose WebRTC is not up re-runs the handshake. A host reached
            // over a live data channel is left alone (see ensureConnection).
            for (const connection of this.hostConnections.values()) {
                if (!this.webRTCReady(connection)) {
                    connection.websocketState = 'pending';
                }
            }
            this.scheduleReconnect();
        };

        ws.onmessage = (event: { data: unknown }) => {
            void this.handleDeviceMessage(event.data);
        };

        ws.onopen = () => this.markDeviceWebsocketOpen();

        // The socket may already be open by the time the handler is attached: a
        // browser websocket fires 'open' on a later task, but an adapter that
        // hands back an already-connected socket never fires it at all.
        if (ws.readyState === WEBSOCKET_OPEN) {
            this.markDeviceWebsocketOpen();
        }
    }

    private markDeviceWebsocketOpen(): void {
        if (this.deviceWebsocketState === 'completed') {
            return;
        }
        this.logger.info('ClientTransport: relay websocket open');
        this.deviceWebsocketState = 'completed';
        this.reconnecting = false;
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnecting) {
            return;
        }
        this.reconnecting = true;
        setTimeout(() => {
            this.reconnecting = false;
            if (!this.closed && this.deviceWebsocketState !== 'completed') {
                void this.openDeviceWebsocket();
            }
        }, 5000);
    }

    private async handleDeviceMessage(data: unknown): Promise<void> {
        let raw: string;
        try {
            raw = await (this.platform.decodeMessageData
                ? this.platform.decodeMessageData(data)
                : decodeFrame(data));
        } catch (error) {
            this.logger.error('ClientTransport: could not decode relay frame', error);
            return;
        }
        let decoded;
        try {
            decoded = decodeMessage(raw);
        } catch (error) {
            this.logger.error('ClientTransport: malformed relay frame', error);
            return;
        }
        if (isSetupMessage(decoded.requestId)) {
            this.handleSetupMessage(decoded.hostSerial, decoded.body);
        } else {
            this.handleResponse(decoded.requestId, decoded.body);
        }
    }

    private handleSetupMessage(paddedHostSerial: string, body: string): void {
        let envelope: TransportEnvelope;
        try {
            envelope = JSON.parse(body);
        } catch (error) {
            this.logger.error('ClientTransport: could not parse setup message', error);
            return;
        }

        // The relay sends this once on connect, with a blank host serial.
        if (envelope.setAuthorization) {
            this.logger.debug('ClientTransport: relay acknowledged authorization');
            return;
        }

        const connection = this.hostConnections.get(paddedHostSerial);
        if (!connection) {
            this.logger.warn(
                `ClientTransport: setup message for unknown host |${paddedHostSerial}|`
            );
            return;
        }
        if (envelope.connectionId !== connection.connectionId) {
            this.logger.warn(
                `ClientTransport: dropping stale setup message for ${connection.hostSerial}, ` +
                `connection ${envelope.connectionId} != ${connection.connectionId}`
            );
            return;
        }

        if (envelope.initialization) {
            const initialization = envelope.initialization as { successful?: boolean; message?: unknown };
            if (initialization.successful) {
                connection.websocketState = 'completed';
                this.emitStatus(connection, 'websocket', 'connected');
                this.logger.info(
                    `ClientTransport: relay session ${connection.connectionId} with ${connection.hostSerial} established`
                );
                void this.createWebRTCConnection(connection);
            } else {
                connection.websocketState = 'pending';
                this.logger.error(
                    `ClientTransport: host ${connection.hostSerial} refused the relay session`,
                    initialization.message
                );
            }
            return;
        }

        if (envelope.connectionStatus) {
            this.logger.info(
                `ClientTransport: host ${connection.hostSerial} reported peer connection ` +
                `${envelope.connectionStatus.status} for ${connection.connectionId}`
            );
            this.emitStatus(connection, 'webrtc', 'connection failed');
            if (connection.webRTCState === 'completed') {
                void this.createWebRTCConnection(connection);
            }
            return;
        }

        if (envelope.ice) {
            connection.pendingIceCandidates.push(envelope.ice);
            void this.flushIceCandidates(connection);
            return;
        }

        if (envelope.answer) {
            void this.applyAnswer(connection, envelope.answer);
        }
    }

    private handleResponse(requestId: string, body: string): void {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
            // A late part of a request that already settled, or a response that
            // arrived after a timeout. Both are expected; neither is an error.
            return;
        }
        let response: TransportResponse;
        try {
            response = (JSON.parse(body) as TransportEnvelope).communication as TransportResponse;
        } catch (error) {
            this.settle(requestId, pending, () =>
                pending.reject(
                    new Error(`ClientTransport: could not parse response for ${requestId}: ${String(error)}`)
                )
            );
            return;
        }
        if (!response || response.requestId !== requestId) {
            return;
        }

        const data = response.data;
        if (response.error === true) {
            this.settle(requestId, pending, () =>
                pending.reject(
                    new TransportRequestError(pending.hostSerial, pending.request.path, data, response.status)
                )
            );
            return;
        }
        switch (pending.request.requestType) {
            case 'chunks': {
                if (isErrorBody(data)) {
                    this.settle(requestId, pending, () => pending.reject(data.message));
                    return;
                }
                const part = data as { seq?: number; data?: unknown; totalChunks?: number };
                if (part.seq !== undefined) {
                    if (pending.chunks[part.seq] === undefined) {
                        pending.chunksReceived += 1;
                    }
                    pending.chunks[part.seq] = part.data;
                }
                if (part.totalChunks !== undefined) {
                    pending.totalChunks = part.totalChunks;
                }
                if (pending.chunksReceived === pending.totalChunks) {
                    const chunks = pending.chunks.filter((chunk) => chunk !== null && chunk !== undefined);
                    this.settle(requestId, pending, () => pending.resolve(chunks));
                }
                return;
            }
            case 'chunkstream': {
                if (!data) {
                    this.settle(requestId, pending, () =>
                        pending.reject(
                            new Error(`ClientTransport: empty chunkstream frame for ${requestId}`)
                        )
                    );
                    return;
                }
                if (isErrorBody(data)) {
                    this.settle(requestId, pending, () => pending.reject(data.message));
                    return;
                }
                const part = data as { type?: string; chunk?: string };
                if (part.type === 'chunk') {
                    pending.chunks.push(part.chunk);
                    return;
                }
                if (part.type === 'eof') {
                    this.settle(requestId, pending, () => pending.resolve(pending.chunks));
                }
                return;
            }
            default: {
                if (isLegacyJsonErrorBody(data)) {
                    this.settle(requestId, pending, () =>
                        pending.reject(new TransportRequestError(pending.hostSerial, pending.request.path, data))
                    );
                    return;
                }
                this.settle(requestId, pending, () => pending.resolve(data));
            }
        }
    }

    private settle(requestId: string, pending: PendingRequest, action: () => void): void {
        if (pending.settled) {
            return;
        }
        pending.settled = true;
        if (pending.timeout) {
            clearTimeout(pending.timeout);
        }
        this.pendingRequests.delete(requestId);
        action();
    }

    // ------------------------------------------------------------------ WebRTC

    private async createWebRTCConnection(connection: HostConnection): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closePeerConnection(connection);

        connection.webRTCState = 'initializing';
        connection.answerReceived = false;
        connection.pendingIceCandidates = [];
        this.emitStatus(connection, 'webrtc', 'initiating');
        this.logger.info(
            `ClientTransport: negotiating WebRTC with ${connection.hostSerial}-${connection.connectionId}`
        );

        let pc: RTCPeerConnectionLike;
        try {
            pc = this.platform.createPeerConnection();
        } catch (error) {
            connection.webRTCState = 'pending';
            this.logger.error(
                `ClientTransport: could not create a peer connection for ${connection.hostSerial}`,
                error
            );
            return;
        }
        connection.pc = pc;

        // The host drops its half if our offer does not arrive within 5 minutes.
        connection.negotiationTimeout = setTimeout(() => {
            if (connection.webRTCState !== 'completed') {
                this.logger.warn(
                    `ClientTransport: WebRTC negotiation with ${connection.hostSerial} timed out, ` +
                    'staying on the relay websocket'
                );
                this.closePeerConnection(connection);
                connection.webRTCState = 'pending';
                this.emitStatus(connection, 'webrtc', 'connection failed');
            }
        }, this.webRTCNegotiationTimeoutMs);

        pc.onicecandidate = (event: { candidate: unknown }) => {
            if (event.candidate) {
                this.sendSetup(connection, { ice: event.candidate });
            }
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            this.logger.debug(
                `ClientTransport: ICE state for ${connection.hostSerial}-${connection.connectionId}: ${state}`
            );
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                this.emitStatus(connection, 'webrtc', 'connection failed');
            } else if (state === 'connected' || state === 'completed') {
                this.emitStatus(connection, 'webrtc', 'connection completed');
            }
        };

        // The host opens a second channel back to us the moment it answers; its
        // 'open' is what proves the path works in both directions, so that is
        // where webRTCState becomes 'completed'.
        pc.ondatachannel = (event: { channel: RTCDataChannelLike }) => {
            const returnChannel = event.channel;
            connection.returnChannel = returnChannel;
            returnChannel.onopen = () => {
                if (connection.negotiationTimeout) {
                    clearTimeout(connection.negotiationTimeout);
                }
                connection.webRTCState = 'completed';
                this.logger.info(
                    `ClientTransport: WebRTC ready for ${connection.hostSerial}-${connection.connectionId}`
                );
                this.emitStatus(connection, 'webrtc', 'connected');
            };
            returnChannel.onclose = () => {
                this.logger.info(
                    `ClientTransport: WebRTC return channel closed for ${connection.hostSerial}-${connection.connectionId}`
                );
            };
            returnChannel.onerror = (error: unknown) => {
                this.logger.error(
                    `ClientTransport: WebRTC return channel error for ${connection.hostSerial}`,
                    error
                );
            };
            returnChannel.onmessage = (messageEvent: { data: unknown }) => {
                void this.handleDeviceMessage(messageEvent.data);
            };
        };

        try {
            // Created before the offer so the channel is part of the SDP.
            connection.requestChannel = pc.createDataChannel('jsonChannel');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.logger.debug(
                `ClientTransport: sending offer to ${connection.hostSerial}-${connection.connectionId}`
            );
            this.sendSetup(connection, { offer });
        } catch (error) {
            this.logger.error(
                `ClientTransport: WebRTC negotiation with ${connection.hostSerial} failed`,
                error
            );
            this.closePeerConnection(connection);
            connection.webRTCState = 'pending';
            this.emitStatus(connection, 'webrtc', 'connection failed');
        }
    }

    private async applyAnswer(connection: HostConnection, answer: unknown): Promise<void> {
        if (!connection.pc) {
            return;
        }
        try {
            const description = this.platform.toSessionDescription
                ? this.platform.toSessionDescription(answer)
                : answer;
            await connection.pc.setRemoteDescription(description);
            connection.answerReceived = true;
            this.emitStatus(connection, 'webrtc', 'answer received');
            await this.flushIceCandidates(connection);
        } catch (error) {
            this.logger.error(
                `ClientTransport: could not apply the answer from ${connection.hostSerial}`,
                error
            );
        }
    }

    private async flushIceCandidates(connection: HostConnection): Promise<void> {
        if (!connection.answerReceived || !connection.pc) {
            return;
        }
        const candidates = connection.pendingIceCandidates;
        connection.pendingIceCandidates = [];
        for (const candidate of candidates) {
            try {
                await connection.pc.addIceCandidate(
                    this.platform.toIceCandidate ? this.platform.toIceCandidate(candidate) : candidate
                );
            } catch (error) {
                this.logger.warn(
                    `ClientTransport: rejected ice candidate from ${connection.hostSerial}`,
                    error
                );
            }
        }
    }

    // ---------------------------------------------------------------- teardown

    /**
     * Closes the data channels, then the peer connection, then forgets it.
     *
     * Order matters and is not cosmetic: `wrtc` crashes the process with a
     * SIGSEGV inside `SctpDataChannel::CloseAbruptlyWith` if a data channel is
     * finalized after its peer connection has already dropped the SCTP
     * transport. The host side learned this the hard way — see
     * `shutdownWebRTCConnections` in webRTCService.mjs. Never throws, because it
     * runs from signal and uncaughtException handlers.
     */
    private closePeerConnection(connection: HostConnection): void {
        if (connection.negotiationTimeout) {
            clearTimeout(connection.negotiationTimeout);
            connection.negotiationTimeout = undefined;
        }
        for (const channel of [connection.requestChannel, connection.returnChannel]) {
            try {
                if (channel && channel.readyState === 'open') {
                    channel.close();
                }
            } catch (error) {
                this.logger.warn(
                    `ClientTransport: error closing a data channel for ${connection.hostSerial}`,
                    error
                );
            }
        }
        connection.requestChannel = null;
        connection.returnChannel = null;
        try {
            if (connection.pc && connection.pc.signalingState !== 'closed') {
                connection.pc.close();
            }
        } catch (error) {
            this.logger.warn(
                `ClientTransport: error closing the peer connection for ${connection.hostSerial}`,
                error
            );
        }
        connection.pc = null;
        connection.answerReceived = false;
        connection.pendingIceCandidates = [];
    }

    /**
     * Shuts every connection down and rejects anything in flight. Safe to call
     * from a process-exit path, and safe to call twice.
     */
    close(): void {
        this.closed = true;
        for (const [requestId, pending] of Array.from(this.pendingRequests)) {
            this.settle(requestId, pending, () =>
                pending.reject(new Error('ClientTransport: closed before the response arrived'))
            );
        }
        for (const connection of this.hostConnections.values()) {
            this.closePeerConnection(connection);
            connection.webRTCState = 'pending';
            connection.websocketState = 'pending';
        }
        try {
            if (this.ws && this.ws.readyState === WEBSOCKET_OPEN) {
                this.ws.close();
            }
        } catch (error) {
            this.logger.warn('ClientTransport: error closing the relay websocket', error);
        }
        this.ws = null;
        this.deviceWebsocketState = 'pending';
        this.emitter.removeAll();
    }

    private emitStatus(connection: HostConnection, transport: TransportKind, status: string): void {
        this.emitter.emit('status', { hostSerial: connection.hostSerial, transport, status });
    }
}
