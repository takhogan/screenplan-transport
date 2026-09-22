# @screenplan/transport

The client half of the ScreenPlan relay protocol, shared by
[script-studio](https://github.com/takhogan/script-studio) (browser) and
[Script-Engine-Controller](https://github.com/takhogan/Script-Engine-Controller)
(Electron main process).

## Why

A ScreenPlan host runs an HTTP API on `https://localhost:3849` that never faces
the network. To reach it from somewhere else, a *client* connects to the relay
(`script-studio-backend-websocket`), the relay routes by Google account, and the
host replays the tunnelled request against its own loopback API — supplying its
own `Authorization` header as it does, so a caller never holds a credential for
the remote machine.

The browser was the only client, so the protocol lived inside an Angular
service. This package is that logic with the Angular, rxjs and DOM taken out, so
the controller can be a client too and drive scripts on another machine.

## What is in here

| Module | Contents |
|---|---|
| `routing` | The fixed-width 92-char routing prefix codec. The relay routes on byte offsets alone, so these offsets are a hard contract between three codebases. |
| `protocol` | The message bodies behind the prefix: initialization, offer/answer/ice, `communication`, and the chunk and chunkstream reply shapes. |
| `platform` | The three primitives an adapter injects — websocket, peer connection, frame decoder — plus auth, which lives inside `openWebSocket`. |
| `clientConnection` | `ClientTransport`: one relay websocket for every host, a peer connection per host negotiated over it, and `doRequest`. |

## Transport selection

`doRequest` picks a channel per call: WebRTC when its data channel is open,
otherwise the relay websocket. WebRTC negotiation is started but never awaited,
because ICE can take seconds — so the first request to a host goes over the
relay immediately and later ones move to the data channel once it is up. Bulk
replies (screenshots, log archives) then bypass the relay.

## Using it

```ts
import { ClientTransport } from '@screenplan/transport';

const transport = new ClientTransport({
    clientDeviceId: uuidv4(),   // must be 36 chars; the prefix width depends on it
    requestTimeoutMs: 120000,
    platform: {
        openWebSocket: async (clientDeviceId) => new WebSocket(
            `${endpoint}/ws/websocket?script-studio-client-device-id=${clientDeviceId}`,
            { headers: { Authorization: `Bearer ${await freshAccessToken()}` } }
        ),
        createPeerConnection: () => new wrtc.RTCPeerConnection({ iceServers }),
        generateId: () => uuidv4(),
        logger
    }
});
await transport.start();

const scripts = await transport.doRequest(hostSerial, {
    requestId: null,
    method: 'GET',
    requestType: 'json',
    path: '/api/list-scripts',
    payload: {}
}, true);
```

`openWebSocket` **must** put `script-studio-client-device-id` in the query string
and **must not** send a `script-studio-host-id` header. The relay files a
connection under `hosts` or `clients` by exactly that test, and a connection
filed as a host is never a routing destination for a reply.

`openWebSocket` is called again on every reconnect, so an adapter that mints the
token inside it never sends an expired one.

## Scripts

- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — build, then run the unit suite (`node --test`) against fake
  sockets and peer connections. The fakes stand in for the relay and a host, so
  the handshake, the WebRTC upgrade, chunk reassembly and teardown are all
  covered without a second machine.
