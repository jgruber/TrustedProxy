/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const http = require('http');
const localauth = 'Basic ' + new Buffer('admin:').toString('base64');

/**
 * Trusted Device Proxy which handles only POST requests
 * @constructor
 */
class TrustedProxyWorker {

    constructor() {
        this.WORKER_URI_PATH = "shared/TrustedProxy";
        this.isPassThrough = true;
        this.isPublic = true;
    }

    /**
     * handle onGet HTTP request - get the query paramater token for a trusted device.
     * @param {Object} restOperation
     */
    onGet(restOperation) {
        const paths = restOperation.uri.pathname.split('/');
        this.getTrustedDevices()
            .then((trustedDevices) => {
                let targetHost = null;
                if (paths.length > 3) {
                    targetHost = paths[3];
                } else {
                    const query = restOperation.getUri().query;
                    targetHost = query.targetHost;
                }
                if (targetHost) {
                    const tokenPromises = [];
                    let targetHostFound = false;
                    trustedDevices.map((trustedDevice) => {
                        if (trustedDevice.address == targetHost) {
                            targetHostFound = true;
                            const tokenPromise = this.getToken(targetHost)
                                .then((token) => {
                                    restOperation.statusCode = 200;
                                    restOperation.body = token;
                                    this.completeRestOperation(restOperation);
                                });
                            tokenPromise.push(tokenPromise);
                        }
                    });
                    Promise.all(tokenPromises)
                        .then(() => {
                            if (!targetHostFound) {
                                const err = new Error('targetHost ' + targetHost + ' is not a trusted device');
                                err.httpStatusCode = 404;
                                restOperation.fail(err);
                            }
                        });
                } else {
                    const tokens = {};
                    const tokenPromises = [];
                    trustedDevices.map((trustedDevice) => {
                        const tokenPromise = this.getToken(trustedDevice.address)
                            .then((token) => {
                                tokens[trustedDevice.address] = token;
                            });
                        tokenPromises.push(tokenPromise);
                    });
                    Promise.all(tokenPromises)
                        .then(() => {
                            restOperation.statusCode = 200;
                            restOperation.body = JSON.stringify(tokens);
                            this.completeRestOperation(restOperation);
                        });
                }
            });
    }

    /**
     * handle onPost HTTP request - proxy reuest to trusted device.
     * @param {Object} restOperation
     */
    onPost(restOperation) {
        const body = restOperation.getBody();
        const refThis = this;
        // Create the framework request RestOperation to proxy to a trusted device.
        let identifiedDeviceRequest = this.restOperationFactory.createRestOperationInstance()
            // Tell the ASG to resolve trusted device for this request.
            .setIdentifiedDeviceRequest(true)
            .setIdentifiedDeviceGroupName(body.groupName)
            // Discern the type of request to proxy from the 'method' attributes in the request body.
            .setMethod(body.method || "Get")
            // Discern the URI for the request to proxy from the 'uri' attribute in the request body. 
            .setUri(this.url.parse(body.uri))
            // Discern the HTTP headers for the request to proxy from the 'headers' attribute in the request body.
            .setHeaders(body.headers || restOperation.getHeaders())
            // Discern the HTTP body for the request to proxy from the 'body' attribute in the request body.
            .setBody(body.body)
            // Derive the referer from the parsed URI.
            .setReferer(this.getUri().href);

        this.eventChannel.emit(this.eventChannel.e.sendRestOperation, identifiedDeviceRequest,
            function (resp) {
                // Return the HTTP status code from the proxied response.
                restOperation.statusCode = resp.statusCode;
                // Return the HTTP headers from the proxied response.
                restOperation.headers = resp.headers;
                // Return the body from the proxied response.
                restOperation.body = resp.body;
                // emmit event to complete this response through the REST framework.
                refThis.completeRestOperation(restOperation);
            },
            function (err) {
                // The proxied response was an error. Forward the error through the REST framework.
                refThis.logger.severe("Request to %s failed: \n%s", body.uri, err ? err.message : "");
                restOperation.fail(err);
            }
        );
    }

    /**
     * handle trusted devices request - all trusted devices.
     * @param {Array} trusted devices
     */
    getTrustedDevices() {
        return new Promise((resolve) => {
            const getDeviceGroupsOptions = {
                host: 'localhost',
                port: 8100,
                path: '/mgmt/shared/resolver/device-groups',
                headers: {
                    'Authorization': localauth
                },
                method: 'GET'
            };
            const deviceGroupRequest = http.request(getDeviceGroupsOptions, (res) => {
                let body = '';
                res.on('data', (seg) => {
                    body += seg;
                });
                res.on('end', () => {
                    if (res.statusCode < 400) {
                        const deviceGroups = JSON.parse(body).items;
                        const trustedGroups = [];
                        const trustedDevicePromises = [];
                        const trustedDevices = [];
                        deviceGroups.map((deviceGroup) => {
                            if (deviceGroup.groupName.startsWith('TrustProxy')) {
                                trustedGroups.push(deviceGroup.groupName);
                            }
                        });
                        trustedGroups.map((groupName) => {
                            const devicePromise = new Promise((resolve, reject) => {
                                const getDevicesOptions = {
                                    host: 'localhost',
                                    port: 8100,
                                    path: '/mgmt/shared/resolver/device-groups/' + groupName + '/devices',
                                    headers: {
                                        'Authorization': localauth
                                    },
                                    method: 'GET'
                                };
                                const deviceRequest = http.request(getDevicesOptions, (res) => {
                                    let body = '';
                                    res.on('data', (seg) => {
                                        body += seg;
                                    });
                                    res.on('end', () => {
                                        if (res.statusCode < 400) {
                                            const devices = JSON.parse(body).items;
                                            devices.map((device) => {
                                                trustedDevices.push(device);
                                            });
                                        }
                                        resolve();
                                    });
                                });
                                deviceRequest.end();
                            });
                            trustedDevicePromises.push(devicePromise);
                        });
                        Promise.all(trustedDevicePromises)
                            .then(() => {
                                resolve(trustedDevices);
                            });
                    } else {
                        this.logger.severe('no device groups found');
                        resolve([]);
                    }
                });
                res.on('error', (err) => {
                    this.logger.severe('error getting trusted devices:' + err.message);
                    resolve([]);
                });
            });
            deviceGroupRequest.end();
        });
    }

    /**
     * handle getToken request - get the query paramater token for a trusted device.
     * @param {String} trust token good for 10 minutes
     */
    getToken(targetHost) {
        return new Promise((resolve) => {
            const tokenBody = JSON.stringify({
                address: targetHost
            });
            let body = '';
            const postOptions = {
                host: 'localhost',
                port: 8100,
                path: '/shared/token',
                headers: {
                    'Authorization': localauth,
                    'Content-Type': 'application/json',
                    'Content-Length': tokenBody.length
                },
                method: 'POST'
            };
            const request = http.request(postOptions, (res) => {
                res.on('data', (seg) => {
                    body += seg;
                });
                res.on('end', () => {
                    resolve(body);
                });
                res.on('error', (err) => {
                    this.logger.severe('error: ' + err);
                    resolve(null);
                });
            });
            request.write(tokenBody);
            request.end();
        });
    }
}

module.exports = TrustedProxyWorker;