/**
 * Which network path a peer connection actually uses, out of its `getStats()`
 * report: the selected candidate pair and its two candidates. Both the browser
 * and `@koush/wrtc` return an `RTCStatsReport` (a Map-like with `forEach`);
 * wrtc names the pair through `transport.selectedCandidatePairId`, older
 * stacks only mark it `nominated` or `selected`.
 *
 * Shared by the client (ClientTransport.getConnectionStats) and the host
 * (Script-Engine-Controller's webRTCService), so both describe a path the same
 * way: LAN, ZeroTier or the internet, host or reflexive or relayed, and its RTT.
 */

export interface CandidateDescription {
    /** 'host' | 'srflx' | 'prflx' | 'relay' */
    candidateType: string | null;
    protocol: string | null;
    address: string | null;
    port: number | null;
    networkType: string | null;
}

export interface SelectedCandidatePair {
    state: string | null;
    local: CandidateDescription | null;
    remote: CandidateDescription | null;
    /** From the latest STUN consent check, in ms. */
    currentRoundTripTimeMs: number | null;
    /** bits/s, where the stack estimates it (Chromium does, wrtc 0.5 does not). */
    availableOutgoingBitrate: number | null;
    bytesSent: number | null;
    bytesReceived: number | null;
}

type StatsEntry = Record<string, unknown> & { id?: string; type?: string };

function entriesOf(report: unknown): StatsEntry[] {
    const entries: StatsEntry[] = [];
    if (!report || typeof report !== 'object') {
        return entries;
    }
    const iterable = report as { forEach?: (callback: (value: unknown) => void) => void };
    if (typeof iterable.forEach === 'function') {
        iterable.forEach((value) => entries.push(value as StatsEntry));
        return entries;
    }
    // The legacy shape: a plain object keyed by stats id.
    for (const value of Object.values(report as Record<string, unknown>)) {
        entries.push(value as StatsEntry);
    }
    return entries;
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function describeCandidate(entry: StatsEntry | undefined): CandidateDescription | null {
    if (!entry) {
        return null;
    }
    return {
        candidateType: asString(entry.candidateType),
        protocol: asString(entry.protocol),
        address: asString(entry.address) ?? asString(entry.ip),
        port: asNumber(entry.port),
        networkType: asString(entry.networkType)
    };
}

/** The selected pair in a `getStats()` report, or null when none is selected yet. */
export function selectedCandidatePair(report: unknown): SelectedCandidatePair | null {
    const entries = entriesOf(report);
    const byId = new Map(entries.filter((entry) => typeof entry.id === 'string').map((entry) => [entry.id as string, entry]));
    const transport = entries.find((entry) => entry.type === 'transport' && typeof entry.selectedCandidatePairId === 'string');
    let pair = transport ? byId.get(transport.selectedCandidatePairId as string) : undefined;
    pair ??= entries.find((entry) => entry.type === 'candidate-pair' && entry.selected === true);
    pair ??= entries.find((entry) => entry.type === 'candidate-pair' && entry.nominated === true && entry.state === 'succeeded');
    if (!pair) {
        return null;
    }
    const rtt = asNumber(pair.currentRoundTripTime);
    return {
        state: asString(pair.state),
        local: describeCandidate(byId.get(pair.localCandidateId as string)),
        remote: describeCandidate(byId.get(pair.remoteCandidateId as string)),
        currentRoundTripTimeMs: rtt === null ? null : Math.round(rtt * 1000 * 10) / 10,
        availableOutgoingBitrate: asNumber(pair.availableOutgoingBitrate),
        bytesSent: asNumber(pair.bytesSent),
        bytesReceived: asNumber(pair.bytesReceived)
    };
}

/** One line for a log: `udp host 10.0.0.2:5000 -> srflx 73.1.2.3:6000, rtt 42 ms`. */
export function formatCandidatePair(pair: SelectedCandidatePair | null): string {
    if (!pair) {
        return 'no selected candidate pair';
    }
    const side = (candidate: CandidateDescription | null) =>
        candidate ? `${candidate.candidateType ?? '?'} ${candidate.address ?? '?'}:${candidate.port ?? '?'}` : '?';
    const protocol = pair.local?.protocol ?? pair.remote?.protocol ?? '?';
    const rtt = pair.currentRoundTripTimeMs === null ? 'rtt unknown' : `rtt ${pair.currentRoundTripTimeMs} ms`;
    return `${protocol} ${side(pair.local)} -> ${side(pair.remote)}, ${rtt}`;
}
