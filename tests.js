import test from "node:test";
import assert from "node:assert";
import NatUpnp from "./index.js";

global.fetch = _fetch;

/**
 * Subclass of NatUpnp that overrides _findGateway to avoid real SSDP discovery.
 * This class also caches the gateway so clearCache can be tested.
 */
class DummyNatUpnp extends NatUpnp {
  async _findGateway() {
    if (this._gateway) return this._gateway;
    this._gateway = {
      serviceType: "urn:dummy",
      controlUrl: "http://dummy",
    };
    return this._gateway;
  }
}

/**
 * Mock fetch to simulate SOAP responses.
 * @param {string} url 
 * @param {RequestInit} options 
 * @returns {Promise<Response>} Response object with text method.
 */
async function _fetch(url, options) {
  const soapAction = options.headers.SOAPAction;

  if (soapAction.includes("AddPortMapping")) {
    if (!global.addMappingCallCount) global.addMappingCallCount = 0;
    global.addMappingCallCount++;
    // Simulate error code 718 on the first call (mapping exists) then succeed.
    if (global.addMappingCallCount === 1) {
      const errorXML = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <detail>
        <UPnPError>
          <errorCode>718</errorCode>
          <errorDescription>Mapping already exists</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
      return { text: async () => errorXML };
    } else {
      const successXML = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <AddPortMappingResponse xmlns="urn:dummy"></AddPortMappingResponse>
  </s:Body>
</s:Envelope>`;
      return { text: async () => successXML };
    }
  }

  if (soapAction.includes("DeletePortMapping")) {
    const successXML = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <DeletePortMappingResponse xmlns="urn:dummy"></DeletePortMappingResponse>
  </s:Body>
</s:Envelope>`;
    return { text: async () => successXML };
  }

  if (soapAction.includes("GetExternalIPAddress")) {
    const successXML = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetExternalIPAddressResponse xmlns="urn:dummy">
      <NewExternalIPAddress>1.2.3.4</NewExternalIPAddress>
    </GetExternalIPAddressResponse>
  </s:Body>
</s:Envelope>`;
    return { text: async () => successXML };
  }

  if (soapAction.includes("GetGenericPortMappingEntry")) {
    // Instead of using a regex, simply check if the body contains index 0.
    if (options.body.includes("<NewPortMappingIndex>0</NewPortMappingIndex>")) {
      const successXML = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetGenericPortMappingEntryResponse xmlns="urn:dummy">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>8080</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>3000</NewInternalPort>
      <NewInternalClient>192.168.1.100</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>nat-upnp</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>
    </GetGenericPortMappingEntryResponse>
  </s:Body>
</s:Envelope>`;
      return { text: async () => successXML };
    } else {
      throw new Error("No mapping");
    }
  }
  return { text: async () => "" };
};

test("getExternalIp returns expected IP", async () => {
  const nat = new DummyNatUpnp();
  const ip = await nat.getExternalIp();
  assert.strictEqual(ip, "1.2.3.4");
});

test("mapPort retries on mapping exists error and succeeds", async () => {
  // Reset call count for a clean test.
  global.addMappingCallCount = 0;
  const options = {
    public: 8080,
    private: 3000,
    protocol: "TCP",
    description: "nat-upnp",
    ttl: 0,
  };
  const nat = new DummyNatUpnp();
  const response = await nat.mapPort(options);
  const responseXML = response.toString();
  assert.ok(responseXML.includes("AddPortMappingResponse"));
});

test("unmapPort returns success response", async () => {
  const options = {
    public: 8080,
    protocol: "TCP",
  };
  const nat = new DummyNatUpnp();
  const response = await nat.unmapPort(options);
  const responseXML = response.toString();
  assert.ok(responseXML.includes("DeletePortMappingResponse"));
});

test("getMappings returns array of mappings", async () => {
  const nat = new DummyNatUpnp();
  const mappings = await nat.getMappings();
  assert.ok(Array.isArray(mappings));
});

test("clearCache resets gateway cache", async () => {
  const nat = new DummyNatUpnp();
  // Prime the cache.
  await nat.getExternalIp();
  // At this point, _gateway should be set.
  assert.ok(nat._gateway);
  nat.clearCache();
  assert.strictEqual(nat._gateway, null);
});
