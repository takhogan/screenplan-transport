import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BLANK_REQUEST_ID,
    NULL_CLIENT_DEVICE_ID,
    ROUTING_PREFIX_LENGTH,
    decodeMessage,
    encodeMessage,
    encodePrefix,
    isSetupMessage,
    padHostSerial
} from '../dist/index.js';

const CLIENT_ID = '11111111-2222-4333-8444-555555555555';

test('the routing prefix is 92 characters, as the relay assumes', () => {
    assert.equal(ROUTING_PREFIX_LENGTH, 92);
    const prefix = encodePrefix({
        requestId: BLANK_REQUEST_ID,
        clientDeviceId: CLIENT_ID,
        hostSerial: 'abc'
    });
    assert.equal(prefix.length, 92);
});

test('a cert serial longer than the slot keeps its last 20 characters', () => {
    const serial = '00f3a1b2c3d4e5f60718293a4b5c6d7e8f90';
    assert.equal(padHostSerial(serial), serial.slice(-20));
    assert.equal(padHostSerial(serial).length, 20);
});

test('a short host serial is left-padded with spaces', () => {
    assert.equal(padHostSerial('abc'), '                 abc');
});

test('encode then decode round-trips every field and the body', () => {
    const serial = '00f3a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const raw = encodeMessage(
        { requestId: BLANK_REQUEST_ID, clientDeviceId: CLIENT_ID, hostSerial: serial },
        { initialization: { begin: true } }
    );
    const decoded = decodeMessage(raw);
    assert.equal(decoded.requestId, BLANK_REQUEST_ID);
    assert.equal(decoded.clientDeviceId, CLIENT_ID);
    assert.equal(decoded.hostSerial, serial.slice(-20));
    assert.deepEqual(JSON.parse(decoded.body), { initialization: { begin: true } });
});

test('a mis-sized id is rejected instead of silently shifting later fields', () => {
    assert.throws(
        () => encodePrefix({ requestId: 'too-short', clientDeviceId: CLIENT_ID, hostSerial: 'x' }),
        /requestId must be 36 chars/
    );
    assert.throws(
        () => encodePrefix({ requestId: BLANK_REQUEST_ID, clientDeviceId: 'nope', hostSerial: 'x' }),
        /clientDeviceId must be 36 chars/
    );
});

test('decoding a frame shorter than the prefix fails loudly', () => {
    assert.throws(() => decodeMessage('too short'), /shorter than the 92-char routing prefix/);
});

test('setup traffic is told apart from responses by the blank request id', () => {
    assert.equal(isSetupMessage(BLANK_REQUEST_ID), true);
    assert.equal(isSetupMessage(CLIENT_ID), false);
});

test('the relay echo sentinel is 36 zeroes', () => {
    assert.equal(NULL_CLIENT_DEVICE_ID.length, 36);
    assert.equal(NULL_CLIENT_DEVICE_ID, '0'.repeat(36));
});
