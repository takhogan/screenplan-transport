import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedCandidatePair, formatCandidatePair } from '../dist/index.js';

// The field set @koush/wrtc 0.5.3 reports (captured from the data-channel
// benchmark): the transport names the pair, which is still 'in-progress'.
const wrtcReport = () => {
    const report = new Map();
    report.set('T01', { id: 'T01', type: 'transport', selectedCandidatePairId: 'CPa' });
    report.set('CPa', { id: 'CPa', type: 'candidate-pair', state: 'in-progress', nominated: true, localCandidateId: 'Ia', remoteCandidateId: 'Ib', currentRoundTripTime: 0.022, bytesSent: 1833, bytesReceived: 0 });
    report.set('CPb', { id: 'CPb', type: 'candidate-pair', state: 'succeeded', nominated: false, localCandidateId: 'Ic', remoteCandidateId: 'Ib' });
    report.set('Ia', { id: 'Ia', type: 'local-candidate', candidateType: 'prflx', protocol: 'udp', address: '10.0.0.2', port: 49457, networkType: 'unknown' });
    report.set('Ib', { id: 'Ib', type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '10.0.0.2', port: 51101 });
    return report;
};

test('the pair the transport selected wins over any other', () => {
    const pair = selectedCandidatePair(wrtcReport());
    assert.equal(pair.state, 'in-progress');
    assert.equal(pair.local.candidateType, 'prflx');
    assert.equal(pair.remote.address, '10.0.0.2');
    assert.equal(pair.currentRoundTripTimeMs, 22);
    assert.equal(pair.availableOutgoingBitrate, null);
    assert.equal(formatCandidatePair(pair), 'udp prflx 10.0.0.2:49457 -> host 10.0.0.2:51101, rtt 22 ms');
});

test('without a transport entry, a nominated succeeded pair is used', () => {
    const report = wrtcReport();
    report.delete('T01');
    report.get('CPb').nominated = true;
    assert.equal(selectedCandidatePair(report).local, null, 'Ic is not in the report');
    assert.equal(selectedCandidatePair(report).state, 'succeeded');
});

test('nothing selected, an empty report, or a legacy plain-object report', () => {
    assert.equal(selectedCandidatePair(new Map()), null);
    assert.equal(selectedCandidatePair(null), null);
    assert.equal(formatCandidatePair(null), 'no selected candidate pair');
    const legacy = Object.fromEntries(wrtcReport());
    assert.equal(selectedCandidatePair(legacy).remote.candidateType, 'host');
});
