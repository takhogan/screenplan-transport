import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientTransport, padHostSerial } from '../dist/index.js';
import {
    FakeHost,
    FakePeerConnection,
    FakeWebSocket,
    fakeId,
    resetIds,
    silentLogger
} from './fakes.mjs';

const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const HOST_SERIAL = '00f3a1b2c3d4e5f60718293a4b5c6d7e8f90';

function harness(overrides = {}) {
    resetIds();
    const socket = new FakeWebSocket();
    const { logger, calls } = silentLogger();
    const peerConnections = [];
    const transport = new ClientTransport({
        clientDeviceId: CLIENT_ID,
        requestTimeoutMs: 2000,
        connectTimeoutMs: 5000,
        platform: {
            openWebSocket: () => socket,
            createPeerConnection: () => {
                const pc = new FakePeerConnection();
                peerConnections.push(pc);
                return pc;
            },
            generateId: fakeId,
            logger
        },
        ...overrides
    });
    const host = new FakeHost(socket, HOST_SERIAL, CLIENT_ID);
    return { socket, transport, host, peerConnections, calls };
}

const jsonRequest = (path = '/api/list-scripts') => ({
    requestId: null,
    method: 'GET',
    requestType: 'json',
    path,
    payload: {}
});

/** Poll until `predicate` holds. Timing here is real, so nothing is guessed. */
async function until(predicate, label = 'condition', timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`until: ${label} was not met within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** Wait for the frame carrying a request for `path`, whichever channel it took. */
async function requestFrame(carrier, path) {
    let frame;
    await until(() => {
        frame = carrier
            .decodedSent()
            .find((f) => f.envelope.communication && f.envelope.communication.path === path);
        return !!frame;
    }, `a request for ${path}`);
    return frame;
}

test('a request is served over the relay websocket without waiting for WebRTC', async () => {
    const { transport, host, socket } = harness();
    await transport.start();

    const pending = transport.doRequest(HOST_SERIAL, jsonRequest(), true);

    const request = await requestFrame(socket, '/api/list-scripts');
    assert.equal(request.hostSerial, padHostSerial(HOST_SERIAL));
    assert.equal(request.clientDeviceId, CLIENT_ID);

    host.respond(request.requestId, { scripts: ['a', 'b'] });
    assert.deepEqual(await pending, { scripts: ['a', 'b'] });

    // WebRTC negotiation started but was never required.
    assert.equal(transport.getHostState(HOST_SERIAL).websocket, 'completed');
    transport.close();
});

test('once the WebRTC return channel opens, requests switch to the data channel', async () => {
    const { transport, host, socket, peerConnections } = harness();
    await transport.start();

    const first = transport.doRequest(HOST_SERIAL, jsonRequest('/api/get-ping'), true);
    const firstFrame = await requestFrame(socket, '/api/get-ping');
    host.respond(firstFrame.requestId, { ping: 1 });
    await first;

    await until(() => peerConnections.length === 1, 'negotiation to begin');
    const pc = peerConnections[0];
    await until(() => !!pc.remoteDescription, 'the answer to be applied');
    assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'fake-answer' });
    pc.completeNegotiation();
    assert.equal(transport.getHostState(HOST_SERIAL).webRTC, 'completed');

    const channel = pc.channels.find((c) => c.label === 'jsonChannel');
    const second = transport.doRequest(HOST_SERIAL, jsonRequest('/api/capture'), true);
    const secondFrame = await requestFrame(channel, '/api/capture');
    assert.equal(channel.sent.length, 1, 'the second request took the data channel');
    assert.ok(
        !socket.decodedSent().some((f) => f.envelope.communication?.path === '/api/capture'),
        'and did not also go over the relay'
    );
    host.respond(secondFrame.requestId, { captured: true }, pc.returnChannel);
    assert.deepEqual(await second, { captured: true });
    transport.close();
});

test('chunks are reassembled in sequence order regardless of arrival order', async () => {
    const { transport, host, socket } = harness();
    await transport.start();
    const pending = transport.doRequest(
        HOST_SERIAL,
        { requestId: null, method: 'GET', requestType: 'chunks', path: '/api/serve', payload: {} },
        true
    );
    const frame = await requestFrame(socket, '/api/serve');

    host.respond(frame.requestId, { totalChunks: 3 });
    host.respond(frame.requestId, { seq: 2, data: 'c' });
    host.respond(frame.requestId, { seq: 0, data: 'a' });
    host.respond(frame.requestId, { seq: 1, data: 'b' });

    assert.deepEqual(await pending, ['a', 'b', 'c']);
    transport.close();
});

test('a chunkstream resolves on eof with the frames in order', async () => {
    const { transport, host, socket } = harness();
    await transport.start();
    const pending = transport.doRequest(
        HOST_SERIAL,
        {
            requestId: null,
            method: 'GET',
            requestType: 'chunkstream',
            path: '/api/capture',
            payload: {}
        },
        true
    );
    const frame = await requestFrame(socket, '/api/capture');

    host.respond(frame.requestId, { type: 'chunk', chunk: 'AA' });
    host.respond(frame.requestId, { type: 'chunk', chunk: 'BB' });
    host.respond(frame.requestId, { type: 'eof' });

    assert.deepEqual(await pending, ['AA', 'BB']);
    transport.close();
});

test("a host's error body rejects the request", async () => {
    const { transport, host, socket } = harness();
    await transport.start();
    const pending = transport.doRequest(HOST_SERIAL, jsonRequest('/api/nope'), true);
    const frame = await requestFrame(socket, '/api/nope');

    host.respond(frame.requestId, { message: '404 Not Found' });
    // 'json' resolves with whatever data the host sent; the error shape is only
    // special-cased for the chunked types, which cannot carry it any other way.
    assert.deepEqual(await pending, { message: '404 Not Found' });

    const chunked = transport.doRequest(
        HOST_SERIAL,
        { requestId: null, method: 'GET', requestType: 'chunks', path: '/api/serve', payload: {} },
        true
    );
    const chunkedFrame = await requestFrame(socket, '/api/serve');
    host.respond(chunkedFrame.requestId, { message: 'boom' });
    await assert.rejects(chunked, (error) => error === 'boom' || error.message === 'boom');
    transport.close();
});

test('a request that goes unanswered rejects on the timeout', async () => {
    const { transport } = harness({ requestTimeoutMs: 60 });
    await transport.start();
    await assert.rejects(
        transport.doRequest(HOST_SERIAL, jsonRequest('/api/slow'), true),
        /timed out after 60ms/
    );
    transport.close();
});

test('setup traffic from a superseded negotiation is ignored', async () => {
    const { transport, host, socket, calls } = harness();
    await transport.start();
    const pending = transport.doRequest(HOST_SERIAL, jsonRequest(), true);
    const frame = await requestFrame(socket, '/api/list-scripts');

    host.sendSetup({ answer: { type: 'answer', sdp: 'stale' } }, 'a-stale-connection-id');
    await until(
        () => calls.warn.some((args) => String(args[0]).includes('stale setup message')),
        'the stale frame to be dropped with a warning'
    );

    host.respond(frame.requestId, { ok: true });
    assert.deepEqual(await pending, { ok: true });
    transport.close();
});

test("the relay's setAuthorization frame carries no host and is not an error", async () => {
    const { transport, host, calls } = harness();
    await transport.start();
    host.sendSetAuthorization();
    assert.equal(
        calls.error.length,
        0,
        `setAuthorization produced errors: ${JSON.stringify(calls.error)}`
    );
    transport.close();
});

test('awaitCreation false rejects rather than queueing against a cold host', async () => {
    const { transport } = harness();
    await transport.start();
    await assert.rejects(
        transport.doRequest(HOST_SERIAL, jsonRequest(), false),
        /uninitialized/
    );
    transport.close();
});

test('ice candidates that arrive before the answer are flushed after it', async () => {
    const { transport, host, socket, peerConnections } = harness();
    await transport.start();
    host.autoAcceptInitialization = true;

    // Suppress the automatic answer so candidates have to queue.
    const originalHandle = host.handle.bind(host);
    host.socket.onSend = (raw) => {
        const parsed = JSON.parse(raw.substring(92));
        if (parsed.offer) {
            host.offer = parsed.offer;
            return;
        }
        originalHandle(raw);
    };

    const pending = transport.doRequest(HOST_SERIAL, jsonRequest(), true);
    await until(() => peerConnections.length === 1, 'negotiation to begin');
    const pc = peerConnections[0];

    host.sendSetup({ ice: { candidate: 'one' } });
    host.sendSetup({ ice: { candidate: 'two' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pc.addedIceCandidates.length, 0, 'queued while the answer is outstanding');

    host.sendSetup({ answer: { type: 'answer', sdp: 'fake-answer' } });
    await until(() => pc.addedIceCandidates.length === 2, 'the queued candidates to flush');
    assert.deepEqual(pc.addedIceCandidates, [{ candidate: 'one' }, { candidate: 'two' }]);

    const frame = await requestFrame(socket, '/api/list-scripts');
    host.respond(frame.requestId, { ok: true });
    await pending;
    transport.close();
});

test('close rejects everything in flight and shuts the peer connection down', async () => {
    const { transport, socket, peerConnections } = harness({ requestTimeoutMs: 0 });
    await transport.start();
    const pending = transport.doRequest(HOST_SERIAL, jsonRequest(), true);
    await requestFrame(socket, '/api/list-scripts');
    await until(() => peerConnections.length === 1, 'negotiation to begin');
    peerConnections[0].completeNegotiation();

    transport.close();
    await assert.rejects(pending, /closed before the response arrived/);
    assert.equal(peerConnections[0].closed, true);
});
