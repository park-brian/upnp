import { networkInterfaces } from "os";
import { Buffer } from "buffer";
import { createSocket } from "dgram";
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
  var el = parentEl.getElementsByTagName(tag)[0];
  return el ? el.textContent : "";
}

/**
 * Finds the local IPv4 address (non-internal).
 * @returns {string} The local IP address, or "127.0.0.1" if none is found.
 */
function findLocalIp() {
  var nets = Object.values(networkInterfaces()).flat();
  var info = nets.find(function(net) {
    return net.family === "IPv4" && !net.internal;
  });
  return info ? info.address : "127.0.0.1";
}

/**
 * Normalizes a port input into an object with a port property.
 * @param {number|string|object} port - The port value or configuration.
 * @returns {object} An object containing the port property.
 */
function normalizePort(port) {
  if (typeof port === "number") return { port: port };
  if (typeof port === "string" && !isNaN(port)) return { port: Number(port) };
  return port || {};
}

/**
 * Normalizes options for port mapping.
 * @param {object} [opts={}] - Options containing public and private definitions.
 * @returns {object} An object with normalized remote and internal port options.
 */
function normalizeOpts(opts) {
  opts = opts || {};
  return {
    remote: normalizePort(opts.public),
    internal: normalizePort(opts.private)
  };
}

/**
 * Discovers the UPnP gateway using SSDP.
 * @param {number} [timeout=DEFAULT_TIMEOUT] - Timeout in milliseconds.
 * @returns {Promise<object>} Resolves with an object containing the gateway location.
 */
function findGateway(timeout) {
  timeout = timeout || DEFAULT_TIMEOUT;
  return new Promise(function(resolve, reject) {
    var sock = createSocket("udp4");
    var msg = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: 239.255.255.250:1900\r\n" +
        "MAN: \"ssdp:discover\"\r\n" +
        "MX: 3\r\n" +
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
    );

    var timer = setTimeout(function() {
      sock.close();
      reject(new Error("Gateway discovery timed out"));
    }, timeout);

    sock.on("error", function(err) {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });

    sock.on("message", function(data) {
      clearTimeout(timer);
      sock.close();
      var match = data.toString().match(/LOCATION:\s*(.*)/i);
      if (match && match[1]) {
        resolve({ location: match[1].trim() });
      } else {
        reject(new Error("No LOCATION header found in response"));
      }
    });

    sock.send(msg, 1900, "239.255.255.250", function(err) {
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
  var res = await fetch(url);
  var text = await res.text();
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
  var serviceList = device.getElementsByTagName("serviceList")[0];
  if (serviceList) {
    var services = serviceList.getElementsByTagName("service");
    for (var i = 0; i < services.length; i++) {
      var service = services[i];
      var serviceTypeEl = service.getElementsByTagName("serviceType")[0];
      if (serviceTypeEl && types.indexOf(serviceTypeEl.textContent) !== -1) {
        return service;
      }
    }
  }

  // Recursively search within deviceList
  var deviceList = device.getElementsByTagName("deviceList")[0];
  if (deviceList) {
    var devices = deviceList.getElementsByTagName("device");
    for (var j = 0; j < devices.length; j++) {
      var found = searchService(devices[j], types);
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
function buildSoapEnvelope(serviceType, action, args) {
  args = args || {};
  var argsXml = Object.entries(args)
    .map(function(entry) {
      var key = entry[0],
        val = entry[1];
      return "<" + key + ">" + val + "</" + key + ">";
    })
    .join("");
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    "<s:Body>" +
    '<u:' + action + ' xmlns:u="' + serviceType + '">' +
    argsXml +
    "</u:" + action + ">" +
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
async function soapRequest(url, serviceType, action, args) {
  args = args || {};
  var envelope = buildSoapEnvelope(serviceType, action, args);
  var res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: '"' + serviceType + "#" + action + '"'
    },
    body: envelope
  });
  var text = await res.text();
  var doc = parseXml(text);

  // Check for SOAP fault
  var fault = doc.getElementsByTagNameNS("http://schemas.xmlsoap.org/soap/envelope/", "Fault")[0];
  if (fault) {
    var upnpError = fault.getElementsByTagName("UPnPError")[0];
    if (upnpError) {
      var errorCode = extractTextFromTag(upnpError, "errorCode");
      var errorDescription = extractTextFromTag(upnpError, "errorDescription");
      throw new Error("UPnPError " + errorCode + ": " + errorDescription);
    }
    throw new Error("SOAP fault encountered");
  }
  return doc.getElementsByTagNameNS("http://schemas.xmlsoap.org/soap/envelope/", "Body")[0];
}

/**
 * Class for performing NAT UPnP operations.
 */
export default class NatUpnp {
  /**
   * Creates an instance of NatUpnp.
   * @param {number} [timeout=DEFAULT_TIMEOUT] - Discovery timeout in milliseconds.
   */
  constructor(timeout) {
    this.timeout = timeout || DEFAULT_TIMEOUT;
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

    var gatewayData = await findGateway(this.timeout);
    var location = gatewayData.location;
    var desc = await fetchXml(location);
    var root = desc.documentElement;
    var device = root.getElementsByTagName("device")[0];
    if (!device) {
      throw new Error("Invalid device description: no device element found");
    }

    var service = searchService(device, [
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1"
    ]);
    if (!service) throw new Error("UPnP service not found in device description");

    var controlUrl = extractTextFromTag(service, "controlURL");
    if (!controlUrl) {
      throw new Error("Control URL not found in service description");
    }
    if (!/^https?:\/\//i.test(controlUrl)) {
      var base = extractTextFromTag(root, "URLBase") || location;
      controlUrl = new URL(controlUrl, base).href;
    }

    this._gateway = {
      serviceType: extractTextFromTag(service, "serviceType"),
      controlUrl: controlUrl
    };
    return this._gateway;
  }

  /**
   * Maps a port using UPnP.
   * @param {object} options - Port mapping options.
   * @returns {Promise<Element>} The SOAP response body element.
   */
  async mapPort(options) {
    var normalized = normalizeOpts(options);
    var remote = normalized.remote;
    var internal = normalized.internal;
    var protocol = (options.protocol || "TCP").toUpperCase();
    var lease = options.ttl || 0;
    var gateway = await this._findGateway();
    var serviceType = gateway.serviceType;
    var controlUrl = gateway.controlUrl;
    var localIp = internal.host || findLocalIp();

    var args = {
      NewRemoteHost: remote.host || "",
      NewExternalPort: remote.port,
      NewProtocol: protocol,
      NewInternalPort: internal.port,
      NewInternalClient: localIp,
      NewEnabled: 1,
      NewPortMappingDescription: options.description || "nat-upnp",
      NewLeaseDuration: lease
    };

    try {
      return await soapRequest(controlUrl, serviceType, "AddPortMapping", args);
    } catch (err) {
      // Error code 718: mapping already exists. Remove it and try again.
      if (err.message.indexOf("718") !== -1) {
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
    var normalized = normalizeOpts(options);
    var remote = normalized.remote;
    var protocol = (options.protocol || "TCP").toUpperCase();
    var gateway = await this._findGateway();
    var serviceType = gateway.serviceType;
    var controlUrl = gateway.controlUrl;
    return soapRequest(controlUrl, serviceType, "DeletePortMapping", {
      NewRemoteHost: remote.host || "",
      NewExternalPort: remote.port,
      NewProtocol: protocol
    });
  }

  /**
   * Retrieves the external IP address.
   * @returns {Promise<string|null>} The external IP address, or null if unavailable.
   */
  async getExternalIp() {
    var gateway = await this._findGateway();
    var serviceType = gateway.serviceType;
    var controlUrl = gateway.controlUrl;
    var body = await soapRequest(controlUrl, serviceType, "GetExternalIPAddress");
    var externalIp = body.getElementsByTagName("NewExternalIPAddress")[0];
    return externalIp ? externalIp.textContent : null;
  }

  /**
   * Retrieves current port mappings.
   * @param {object} [options={}] - Options to filter mappings.
   * @returns {Promise<Array>} Array of port mapping objects.
   */
  async getMappings(options) {
    options = options || {};
    var mappings = [];
    var index = 0;
    var firstErrorOnZero = false;

    while (true) {
      try {
        var gateway = await this._findGateway();
        var controlUrl = gateway.controlUrl;
        var serviceType = gateway.serviceType;
        var body = await soapRequest(controlUrl, serviceType, "GetGenericPortMappingEntry", {
          NewPortMappingIndex: index
        });
        var responseEl = body.firstElementChild;
        if (!responseEl || responseEl.tagName.indexOf("GetGenericPortMappingEntryResponse") === -1) {
          break;
        }
        mappings.push({
          public: {
            host: extractTextFromTag(responseEl, "NewRemoteHost") || "",
            port: Number(extractTextFromTag(responseEl, "NewExternalPort"))
          },
          private: {
            host: extractTextFromTag(responseEl, "NewInternalClient"),
            port: Number(extractTextFromTag(responseEl, "NewInternalPort"))
          },
          protocol: extractTextFromTag(responseEl, "NewProtocol").toLowerCase(),
          enabled: extractTextFromTag(responseEl, "NewEnabled") === "1",
          description: extractTextFromTag(responseEl, "NewPortMappingDescription"),
          ttl: Number(extractTextFromTag(responseEl, "NewLeaseDuration"))
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
      var localIp = (options.internal && options.internal.host) || findLocalIp();
      return mappings.filter(function(mapping) {
        return mapping.private.host === localIp;
      });
    }
    if (options.description) {
      return mappings.filter(function(mapping) {
        if (options.description instanceof RegExp) {
          return options.description.test(mapping.description);
        }
        return mapping.description.indexOf(options.description) !== -1;
      });
    }
    return mappings;
  }
}
