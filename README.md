# upnp-portmap

A minimal UPnP port mapping library for Node.js that maps local ports to your router using the UPnP protocol. The preferred way to use this tool is as a CLI via npx.

## Prerequisites

- Node.js 18+
- Router with UPnP enabled

## Quick Start

Map a local port to your router with a single command:

```bash
npx upnp-portmap 8080 3000
```

This maps external port 8080 to your local port 3000 using TCP (default protocol).

Need more control? Add protocol, description, and duration:

```bash
npx upnp-portmap 8080 3000 UDP "My App" 3600
# Or use named arguments
npx upnp-portmap --public 8080 --private 3000 --protocol UDP --description "My App" --ttl 3600
```

This maps UDP port 8080 to port 3000 with a custom description and a one-hour (3600 seconds) lease duration.

## Command Options

The CLI accepts parameters in the following order, or as named parameters:
- **public**: The external port number
- **private**: The internal port number
- **protocol** (optional): `TCP` or `UDP` (default: `TCP`)
- **description** (optional): A description for the mapping (default: `nat-upnp`)
- **ttl** (optional): Lease duration in seconds (default: `0` for indefinite)

## Library Usage

You can also use **upnp-portmap** as a Node.js library. Below are examples of how to import and use it programmatically.

### Basic Example

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

### Example: HTTP Server with Port Mapping

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
server.listen(mapping.private);
await once(server, "listening");

const upnp = new Upnp();
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
Creates a new UPnP client. The optional `timeout` (in ms) is used for gateway discovery.

### `mapPort(options)`
Maps a port on your router.

- **options.public**: External port number or `{ port, host }`
- **options.private**: Internal port number or `{ port, host }`
- **options.protocol**: `'TCP'` or `'UDP'` (default: `'TCP'`)
- **options.description**: Mapping description
- **options.ttl**: Lease duration in seconds (0 for indefinite)

### `unmapPort(options)`
Removes a port mapping.

- **options.public**: External port number or `{ port, host }`
- **options.protocol**: `'TCP'` or `'UDP'`

### `getExternalIp()`
Returns the external IP address.

### `getMappings([options])`
Lists current port mappings.

- **options.local**: Filter mappings for the local machine
- **options.description**: Filter by description (string or RegExp)

### `clearCache()`
Clears cached gateway information.

## Notes

- **Node.js Version**: Requires Node.js 18+
- **Router Compatibility**: Not all routers support UPnP or have it enabled.
- **Port Availability**: Public ports may already be in use, and some routers limit the number of mappings.
