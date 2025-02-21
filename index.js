#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createSocket } from "node:dgram";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";

const DEFAULT_TIMEOUT = 3000;

/**
 * Parses an XML string into a Document.
 * @param {string} xmlString - The XML string to parse.
 * @returns {Document} The parsed XML document.
 */
function parseXml(xmlString) {
  return new DOMParser().parseFromString(xmlString, "application/xml");
}

/**
 * Utility to extract text content from the first element with a given tag.
 * @param {Element} parentEl - The parent element to search within.
 * @param {string} tag - The tag name to search for.
 * @returns {string} The text content if found; otherwise, an empty string.
 */
function extractTextFromTag(parentEl, tag) {
  const el = parentEl.getElementsByTagName(tag)[0];
  return el ? el.textContent : "";
}

/**
 * Finds the local IPv4 address (non-internal).
 * @returns {string} The local IP address, or "127.0.0.1" if none is found.
 */
function findLocalIp() {
  const nets = Object.values(networkInterfaces()).flat();
  const info = nets.find((net) => net.family === "IPv4" && !net.internal);
  return info ? info.address : "127.0.0.1";
}

/**
 * Normalizes a port input into an object with a port property.
 * @param {number|string|object} port - The port value or configuration.
 * @returns {object} An object containing the port property.
 */
function normalizePort(port) {
  if (typeof port === "number") return { port };
  if (typeof port === "string" && !isNaN(port)) return { port: Number(port) };
  return port || {};
}

/**
 * Normalizes options for port mapping.
 * @param {object} [opts={}] - Options containing public and private definitions.
 * @returns {object} An object with normalized remote and internal port options.
 */
function normalizeOpts(opts = {}) {
  return {
    remote: normalizePort(opts.public),
    internal: normalizePort(opts.private),
  };
}

/**
 * Discovers the UPnP gateway using SSDP.
 * @param {number} [timeout=DEFAULT_TIMEOUT] - Timeout in milliseconds.
 * @returns {Promise<object>} Resolves with an object containing the gateway location.
 */
function findGateway(timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const msg = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: 239.255.255.250:1900\r\n" +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 3\r\n" +
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
    );

    const timer = setTimeout(() => {
      sock.close();
      reject(new Error("Gateway discovery timed out"));
    }, timeout);

    sock.on("error", (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });

    sock.on("message", (data) => {
      clearTimeout(timer);
      sock.close();
      const match = data.toString().match(/LOCATION:\s*(.*)/i);
      if (match && match[1]) {
        resolve({ location: match[1].trim() });
      } else {
        reject(new Error("No LOCATION header found in response"));
      }
    });

    sock.send(msg, 1900, "239.255.255.250", (err) => {
      if (err) {
        clearTimeout(timer);
        sock.close();
        reject(err);
      }
    });
  });
}

/**
 * Fetches XML from a URL and returns the parsed document.
 * @param {string} url - The URL to fetch the XML from.
 * @returns {Promise<Document>} The parsed XML document.
 */
async function fetchXml(url) {
  const res = await fetch(url);
  const text = await res.text();
  return parseXml(text);
}

/**
 * Recursively searches a device element for a service matching one of the given types.
 * @param {Element} device - The device element to search.
 * @param {string[]} types - Array of service types to match.
 * @returns {Element|null} The matching service element, or null if not found.
 */
function searchService(device, types) {
  if (!device) return null;

  // Search within serviceList
  const serviceList = device.getElementsByTagName("serviceList")[0];
  if (serviceList) {
    const services = serviceList.getElementsByTagName("service");
    for (let i = 0; i < services.length; i++) {
      const service = services[i];
      const serviceTypeEl = service.getElementsByTagName("serviceType")[0];
      if (serviceTypeEl && types.includes(serviceTypeEl.textContent)) {
        return service;
      }
    }
  }

  // Recursively search within deviceList
  const deviceList = device.getElementsByTagName("deviceList")[0];
  if (deviceList) {
    const devices = deviceList.getElementsByTagName("device");
    for (let i = 0; i < devices.length; i++) {
      const found = searchService(devices[i], types);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Constructs a SOAP envelope for the given service action and arguments.
 * @param {string} serviceType - The service type.
 * @param {string} action - The action to perform.
 * @param {object} [args={}] - Action arguments.
 * @returns {string} The SOAP envelope as an XML string.
 */
function buildSoapEnvelope(serviceType, action, args = {}) {
  const argsXml = Object.entries(args)
    .map(([key, val]) => `<${key}>${val}</${key}>`)
    .join("");

  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    "<s:Body>" +
    `<u:${action} xmlns:u="${serviceType}">` +
    argsXml +
    `</u:${action}>` +
    "</s:Body></s:Envelope>"
  );
}

/**
 * Sends a SOAP request and returns the response body.
 * @param {string} url - The control URL.
 * @param {string} serviceType - The service type.
 * @param {string} action - The SOAP action.
 * @param {object} [args={}] - SOAP arguments.
 * @returns {Promise<Element>} The SOAP response body element.
 * @throws {Error} If a SOAP fault is encountered.
 */
async function soapRequest(url, serviceType, action, args = {}) {
  const envelope = buildSoapEnvelope(serviceType, action, args);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      "SOAPAction": `"${serviceType}#${action}"`,
    },
    body: envelope,
  });
  const text = await res.text();
  const doc = parseXml(text);

  // Check for SOAP fault
  const fault = doc.getElementsByTagNameNS("http://schemas.xmlsoap.org/soap/envelope/", "Fault")[0];
  if (fault) {
    const upnpError = fault.getElementsByTagName("UPnPError")[0];
    if (upnpError) {
      const errorCode = extractTextFromTag(upnpError, "errorCode");
      const errorDescription = extractTextFromTag(upnpError, "errorDescription");
      throw new Error(`UPnPError ${errorCode}: ${errorDescription}`);
    }
    throw new Error("SOAP fault encountered");
  }
  return doc.getElementsByTagNameNS("http://schemas.xmlsoap.org/soap/envelope/", "Body")[0];
}

/**
 * Class for performing UPnP operations.
 */
export default class UPnP {
  /**
   * Creates an instance of UPnP.
   * @param {number} [timeout=DEFAULT_TIMEOUT] - Discovery timeout in milliseconds.
   */
  constructor(timeout = DEFAULT_TIMEOUT) {
    this.timeout = timeout;
    this._gateway = null;
  }

  /**
   * Clears cached gateway information.
   */
  clearCache() {
    this._gateway = null;
  }

  /**
   * Discovers and caches gateway details.
   * @returns {Promise<object>} Object containing serviceType and controlUrl.
   * @throws {Error} If device description or service is not found.
   * @private
   */
  async _findGateway() {
    if (this._gateway) return this._gateway;

    const gatewayData = await findGateway(this.timeout);
    const location = gatewayData.location;
    const desc = await fetchXml(location);
    const root = desc.documentElement;
    const device = root.getElementsByTagName("device")[0];

    if (!device) {
      throw new Error("Invalid device description: no device element found");
    }

    const service = searchService(device, [
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ]);
    if (!service) throw new Error("UPnP service not found in device description");

    let controlUrl = extractTextFromTag(service, "controlURL");
    if (!controlUrl) {
      throw new Error("Control URL not found in service description");
    }
    if (!/^https?:\/\//i.test(controlUrl)) {
      const base = extractTextFromTag(root, "URLBase") || location;
      controlUrl = new URL(controlUrl, base).href;
    }

    this._gateway = {
      serviceType: extractTextFromTag(service, "serviceType"),
      controlUrl,
    };
    return this._gateway;
  }

  /**
   * Maps a port using UPnP.
   * @param {object} options - Port mapping options.
   * @returns {Promise<Element>} The SOAP response body element.
   */
  async mapPort(options) {
    const normalized = normalizeOpts(options);
    const { remote, internal } = normalized;
    const protocol = (options.protocol || "TCP").toUpperCase();
    const lease = options.ttl || 0;
    const gateway = await this._findGateway();
    const { serviceType, controlUrl } = gateway;
    const localIp = internal.host || findLocalIp();

    const args = {
      NewRemoteHost: remote.host || "",
      NewExternalPort: remote.port,
      NewProtocol: protocol,
      NewInternalPort: internal.port,
      NewInternalClient: localIp,
      NewEnabled: 1,
      NewPortMappingDescription: options.description || "nat-upnp",
      NewLeaseDuration: lease,
    };

    try {
      return await soapRequest(controlUrl, serviceType, "AddPortMapping", args);
    } catch (err) {
      // Error code 718: mapping already exists. Remove it and try again.
      if (err.message.includes("718")) {
        await this.unmapPort(options);
        return await soapRequest(controlUrl, serviceType, "AddPortMapping", args);
      }
      throw err;
    }
  }

  /**
   * Unmaps a previously mapped port.
   * @param {object} options - Port unmapping options.
   * @returns {Promise<Element>} The SOAP response body element.
   */
  async unmapPort(options) {
    const normalized = normalizeOpts(options);
    const { remote } = normalized;
    const protocol = (options.protocol || "TCP").toUpperCase();
    const gateway = await this._findGateway();
    const { serviceType, controlUrl } = gateway;

    return soapRequest(controlUrl, serviceType, "DeletePortMapping", {
      NewRemoteHost: remote.host || "",
      NewExternalPort: remote.port,
      NewProtocol: protocol,
    });
  }

  /**
   * Retrieves the external IP address.
   * @returns {Promise<string|null>} The external IP address, or null if unavailable.
   */
  async getExternalIp() {
    const gateway = await this._findGateway();
    const { serviceType, controlUrl } = gateway;
    const body = await soapRequest(controlUrl, serviceType, "GetExternalIPAddress");
    const externalIp = body.getElementsByTagName("NewExternalIPAddress")[0];
    return externalIp ? externalIp.textContent : null;
  }

  /**
   * Retrieves current port mappings.
   * @param {object} [options={}] - Options to filter mappings.
   * @returns {Promise<Array>} Array of port mapping objects.
   */
  async getMappings(options = {}) {
    const mappings = [];
    let index = 0;
    let firstErrorOnZero = false;

    while (true) {
      try {
        const gateway = await this._findGateway();
        const { controlUrl, serviceType } = gateway;
        const body = await soapRequest(controlUrl, serviceType, "GetGenericPortMappingEntry", {
          NewPortMappingIndex: index,
        });
        const responseEl = body.firstElementChild;
        if (!responseEl || !responseEl.tagName.includes("GetGenericPortMappingEntryResponse")) {
          break;
        }

        mappings.push({
          public: {
            host: extractTextFromTag(responseEl, "NewRemoteHost") || "",
            port: Number(extractTextFromTag(responseEl, "NewExternalPort")),
          },
          private: {
            host: extractTextFromTag(responseEl, "NewInternalClient"),
            port: Number(extractTextFromTag(responseEl, "NewInternalPort")),
          },
          protocol: extractTextFromTag(responseEl, "NewProtocol").toLowerCase(),
          enabled: extractTextFromTag(responseEl, "NewEnabled") === "1",
          description: extractTextFromTag(responseEl, "NewPortMappingDescription"),
          ttl: Number(extractTextFromTag(responseEl, "NewLeaseDuration")),
        });
        index++;
      } catch (err) {
        if (index === 0 && !firstErrorOnZero) {
          // Retry starting at index 1 if the first attempt fails.
          firstErrorOnZero = true;
          index = 1;
          continue;
        }
        break;
      }
    }

    if (options.local) {
      let localIp = (options.internal && options.internal.host) || findLocalIp();
      return mappings.filter((mapping) => mapping.private.host === localIp);
    }
    if (options.description) {
      return mappings.filter((mapping) => {
        if (options.description instanceof RegExp) {
          return options.description.test(mapping.description);
        }
        return mapping.description.indexOf(options.description) !== -1;
      });
    }
    return mappings;
  }
}


if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  (async function main() {
    const args = process.argv.slice(2);
    const usage = `Usage:
    upnp-portmap <public> <private> [protocol] [description] [ttl]
    upnp-portmap --public <port> --private <port> [--protocol TCP] [--description desc] [--ttl 0]`;

    const options = args.some((arg) => arg.startsWith("--"))
      ? parseArgs({
          options: {
            public: { type: "number" },
            private: { type: "number" },
            protocol: { type: "string", default: "TCP" },
            description: { type: "string", default: "nat-upnp" },
            ttl: { type: "number", default: 0 },
          },
        }).values
      : {
          public: Number(args[0]),
          private: Number(args[1]),
          protocol: args[2] || "TCP",
          description: args[3] || "nat-upnp",
          ttl: args[4] ? Number(args[4]) : 0,
        };

    if (!options.public || !options.private || isNaN(options.public) || isNaN(options.private)) {
      console.error("Error: Valid public and private ports required\n" + usage);
      process.exit(1);
    }

    const upnp = new UPnP();
    let currentIp;
    let checkInterval;

    async function cleanup() {
      clearInterval(checkInterval);
      try {
        await upnp.unmapPort(options);
        console.log(`Unmapped port ${options.public}`);
      } catch (err) {
        console.error("Error unmapping port:", err);
      }
      process.exit(0);
    }

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    try {
      console.log(`Mapping ${options.protocol}: external ${options.public} -> internal ${options.private}`);
      await upnp.mapPort(options);
      currentIp = await upnp.getExternalIp();
      console.log(`Success! External IP: http://${currentIp}:${options.public}`);
      console.log("Press Ctrl+C to unmap port and exit");

      // Periodically check external IP and acquire new mapping if it changes.
      checkInterval = setInterval(async () => {
        try {
          const newIp = await upnp.getExternalIp();
          if (newIp !== currentIp) {
            currentIp = newIp;
            console.log(`External IP changed: http://${currentIp}:${options.public}`);
          }
        } catch (err) {
          console.error("Error checking external IP:", err);
        }
      }, 5 * 60 * 1000);
    } catch (err) {
      console.error("Error mapping port:", err);
      process.exit(1);
    }
  })();
}