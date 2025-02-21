# upnp-portmap

A minimal UPnP port mapping library for Node.js. Maps local ports to your router using UPnP protocol.

## Install

```bash
npm install upnp-portmap
```

## Usage

```javascript
import Upnp from 'upnp-portmap';

const upnp = new Upnp();

// Map a port
await upnp.mapPort({
  public: 8080,
  private: 3000,
  protocol: 'TCP',
  description: 'My app'
});

// Get external IP
const ip = await upnp.getExternalIp();
console.log('External IP:', ip);

// List mappings
const mappings = await upnp.getMappings();
console.log('Current mappings:', mappings);

// Remove mapping
await upnp.unmapPort({
  public: 8080,
  protocol: 'TCP'
});
```

## Example: HTTP Server with Port Mapping

```javascript
import http from "http";
import { once } from "events";
import Upnp from "upnp-portmap";

const mapping = {
  public: 8080,
  private: 8000,
  protocol: "TCP",
  description: "Node.js server",
  ttl: 0,
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello, world!\n");
});

const upnp = new Upnp();
server.listen(mapping.private);
await once(server, "listening");
await upnp.mapPort(mapping);
const ip = await upnp.getExternalIp();
console.log("Server running on port", mapping.private, `http://${ip}:${mapping.public}`);

process.on("SIGINT", async () => {
  server.close();
  await upnp.unmapPort(mapping);
  console.log(`Unmapped port ${mapping.public}`);
  process.exit(0);
});
```

## API

### `new Upnp([timeout])`
Creates a new UPnP client. Optional timeout (in ms) for gateway discovery.

### `mapPort(options)`
Maps a port on your router.
- `options.public`: External port number or {port, host}
- `options.private`: Internal port number or {port, host}
- `options.protocol`: 'TCP' or 'UDP' (default: 'TCP')
- `options.description`: Mapping description
- `options.ttl`: Lease duration in seconds (0 for indefinite)

### `unmapPort(options)`
Removes a port mapping.
- `options.public`: External port number or {port, host}
- `options.protocol`: 'TCP' or 'UDP'

### `getExternalIp()`
Returns the external IP address.

### `getMappings([options])`
Lists current port mappings.
- `options.local`: Filter mappings for local machine
- `options.description`: Filter by description (string or RegExp)

### `clearCache()`
Clears cached gateway information.

## Notes
- Requires Node.js 18+
- Not all routers support UPnP or have it enabled
- Public ports may already be in use
- Some routers limit the number of mappings
