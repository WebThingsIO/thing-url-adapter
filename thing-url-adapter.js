/**
 * example-plugin-adapter.js - ThingURL adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const crypto = require('crypto');
const dnssd = require('dnssd');
const fetch = require('node-fetch');
const manifest = require('./manifest.json');
const {URL} = require('url');
const WebSocket = require('ws');

const {
  Adapter,
  Database,
  Device,
  Event,
  Property,
} = require('gateway-addon');

let webthingBrowser;
let subtypeBrowser;
let httpBrowser;

const ACTION_STATUS = 'actionStatus';
const ADD_EVENT_SUBSCRIPTION = 'addEventSubscription';
const EVENT = 'event';
const PROPERTY_STATUS = 'propertyStatus';
const SET_PROPERTY = 'setProperty';

const PING_INTERVAL = 30 * 1000;
const POLL_INTERVAL = 5 * 1000;
const WS_INITIAL_BACKOFF = 1000;
const WS_MAX_BACKOFF = 30 * 1000;

class ThingURLProperty extends Property {
  constructor(device, name, url, propertyDescription) {
    super(device, name, propertyDescription);
    this.url = url;
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
  }

  /**
   * @method setValue
   * @returns {Promise} resolves to the updated value
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    if (this.device.ws && this.device.ws.readyState === WebSocket.OPEN) {
      const msg = {
        messageType: SET_PROPERTY,
        data: {[this.name]: value},
      };

      this.device.ws.send(JSON.stringify(msg));

      // If the value is the same, we probably won't get a propertyStatus back
      // via the WebSocket, so let's go ahead and notify now.
      if (value === this.value) {
        this.device.notifyPropertyChanged(this);
      }

      return Promise.resolve(value);
    }

    return fetch(this.url, {
      method: 'PUT',
      headers: {
        'Content-type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        [this.name]: value,
      }),
    }).then((res) => {
      return res.json();
    }).then((response) => {
      const updatedValue = response[this.name];
      this.setCachedValue(updatedValue);
      this.device.notifyPropertyChanged(this);
      return updatedValue;
    }).catch((e) => {
      console.log(`Failed to set ${this.name}: ${e}`);
      return this.value;
    });
  }
}

class ThingURLDevice extends Device {
  constructor(adapter, id, url, description, mdnsUrl) {
    super(adapter, id);
    this.title = this.name = description.title || description.name;
    this.type = description.type;
    this['@context'] =
      description['@context'] || 'https://iot.mozilla.org/schemas';
    this['@type'] = description['@type'] || [];
    this.url = url;
    this.mdnsUrl = mdnsUrl;
    this.actionsUrl = null;
    this.eventsUrl = null;
    this.wsUrl = null;
    this.description = description.description;
    this.propertyPromises = [];
    this.ws = null;
    this.wsBackoff = WS_INITIAL_BACKOFF;
    this.pingInterval = null;
    this.requestedActions = new Map();
    this.baseHref = new URL(url).origin;
    this.notifiedEvents = new Set();
    this.scheduledUpdate = null;
    this.closing = false;

    for (const actionName in description.actions) {
      const action = description.actions[actionName];
      if (action.hasOwnProperty('links')) {
        action.links = action.links.map((l) => {
          if (!l.href.startsWith('http://') && !l.href.startsWith('https://')) {
            l.proxy = true;
          }
          return l;
        });
      }
      this.addAction(actionName, action);
    }

    for (const eventName in description.events) {
      const event = description.events[eventName];
      if (event.hasOwnProperty('links')) {
        event.links = event.links.map((l) => {
          if (!l.href.startsWith('http://') && !l.href.startsWith('https://')) {
            l.proxy = true;
          }
          return l;
        });
      }
      this.addEvent(eventName, event);
    }

    for (const propertyName in description.properties) {
      const propertyDescription = description.properties[propertyName];

      let propertyUrl;
      if (propertyDescription.hasOwnProperty('links')) {
        for (const link of propertyDescription.links) {
          if (!link.rel || link.rel === 'property') {
            propertyUrl = this.baseHref + link.href;
            break;
          }
        }
      }

      if (!propertyUrl) {
        if (!propertyDescription.href) {
          continue;
        }

        propertyUrl = this.baseHref + propertyDescription.href;
      }

      this.propertyPromises.push(
        fetch(propertyUrl, {
          headers: {
            Accept: 'application/json',
          },
        }).then((res) => {
          return res.json();
        }).then((res) => {
          propertyDescription.value = res[propertyName];
          if (propertyDescription.hasOwnProperty('links')) {
            propertyDescription.links = propertyDescription.links.map((l) => {
              if (!l.href.startsWith('http://') &&
                  !l.href.startsWith('https://')) {
                l.proxy = true;
              }
              return l;
            });
          }
          const property = new ThingURLProperty(
            this, propertyName, propertyUrl, propertyDescription);
          this.properties.set(propertyName, property);
        }).catch((e) => {
          console.log(`Failed to connect to ${propertyUrl}: ${e}`);
        })
      );
    }

    // If a websocket endpoint exists, connect to it.
    if (description.hasOwnProperty('links')) {
      for (const link of description.links) {
        if (link.rel === 'actions') {
          this.actionsUrl = this.baseHref + link.href;
        } else if (link.rel === 'events') {
          this.eventsUrl = this.baseHref + link.href;
        } else if (link.rel === 'properties') {
          // pass
        } else if (link.rel === 'alternate') {
          if (link.mediaType === 'text/html') {
            if (!link.href.startsWith('http://') &&
                !link.href.startsWith('https://')) {
              link.proxy = true;
            }
            this.links.push(link);
          } else if (link.href.startsWith('ws://') ||
                     link.href.startsWith('wss://')) {
            this.wsUrl = link.href;
            this.createWebSocket();
          } else {
            this.links.push(link);
          }
        } else {
          if (!link.href.startsWith('http://') &&
              !link.href.startsWith('https://')) {
            link.proxy = true;
          }
          this.links.push(link);
        }
      }
    }

    // If there's no websocket endpoint, poll the device for updates.
    if (!this.ws) {
      Promise.all(this.propertyPromises).then(() => this.poll());
    }
  }

  closeWebSocket() {
    this.closing = true;
    if (this.ws !== null) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }

      // Allow the cleanup code in createWebSocket to handle shutdown
    } else if (this.scheduledUpdate) {
      clearTimeout(this.scheduledUpdate);
    }
  }

  createWebSocket() {
    if (this.closing) {
      return;
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.wsBackoff = WS_INITIAL_BACKOFF;

      if (this.events.size > 0) {
        // Subscribe to all events
        const msg = {
          messageType: ADD_EVENT_SUBSCRIPTION,
          data: {},
        };

        this.events.forEach((_value, key) => {
          msg.data[key] = {};
        });

        this.ws.send(JSON.stringify(msg));
      }

      this.pingInterval = setInterval(() => {
        this.ws.ping();
      }, PING_INTERVAL);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        switch (msg.messageType) {
          case PROPERTY_STATUS: {
            for (const [name, value] of Object.entries(msg.data)) {
              const property = this.findProperty(name);
              if (property) {
                property.getValue().then((oldValue) => {
                  if (value !== oldValue) {
                    property.setCachedValue(value);
                    this.notifyPropertyChanged(property);
                  }
                });
              }
            }
            break;
          }
          case ACTION_STATUS: {
            for (const action of Object.values(msg.data)) {
              const requestedAction = this.requestedActions.get(action.href);
              if (requestedAction) {
                requestedAction.status = action.status;
                requestedAction.timeRequested = action.timeRequested;
                requestedAction.timeCompleted = action.timeCompleted;
                this.actionNotify(requestedAction);
              }
            }
            break;
          }
          case EVENT: {
            for (const [name, event] of Object.entries(msg.data)) {
              this.createEvent(name, event);
            }
            break;
          }
        }
      } catch (e) {
        console.log(`Error receiving websocket message: ${e}`);
      }
    });

    const cleanupAndReopen = () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      this.ws.removeAllListeners('close');
      this.ws.removeAllListeners('error');
      this.ws.close();
      this.ws = null;

      setTimeout(() => {
        this.wsBackoff = Math.min(this.wsBackoff * 2, WS_MAX_BACKOFF);
        this.createWebSocket();
      }, this.wsBackoff);
    };

    this.ws.on('close', cleanupAndReopen);
    this.ws.on('error', cleanupAndReopen);
  }

  async poll() {
    if (this.closing) {
      return;
    }

    // Update properties
    await Promise.all(Array.from(this.properties.values()).map((prop) => {
      return fetch(prop.url, {
        headers: {
          Accept: 'application/json',
        },
      }).then((res) => {
        return res.json();
      }).then((res) => {
        const newValue = res[prop.name];
        prop.getValue().then((value) => {
          if (value !== newValue) {
            prop.setCachedValue(newValue);
            this.notifyPropertyChanged(prop);
          }
        });
      }).catch((e) => {
        console.log(`Failed to connect to ${prop.url}: ${e}`);
      });
    }));

    // Check for new actions
    if (this.actionsUrl !== null) {
      await fetch(this.actionsUrl, {
        headers: {
          Accept: 'application/json',
        },
      }).then((res) => {
        return res.json();
      }).then((actions) => {
        for (let action of actions) {
          const actionName = Object.keys(action)[0];
          action = action[actionName];
          const requestedAction =
            this.requestedActions.get(action.href);

          if (requestedAction && action.status !== requestedAction.status) {
            requestedAction.status = action.status;
            requestedAction.timeRequested = action.timeRequested;
            requestedAction.timeCompleted = action.timeCompleted;
            this.actionNotify(requestedAction);
          }
        }
      }).catch((e) => {
        console.log(`Failed to fetch actions list: ${e}`);
      });
    }

    // Check for new events
    if (this.eventsUrl !== null) {
      await fetch(this.eventsUrl, {
        headers: {
          Accept: 'application/json',
        },
      }).then((res) => {
        return res.json();
      }).then((events) => {
        for (let event of events) {
          const eventName = Object.keys(event)[0];
          event = event[eventName];
          this.createEvent(eventName, event);
        }
      }).catch((e) => {
        console.log(`Failed to fetch events list: ${e}`);
      });
    }

    if (this.scheduledUpdate) {
      clearTimeout(this.scheduledUpdate);
    }
    this.scheduledUpdate = setTimeout(
      () => this.poll(),
      this.adapter.pollInterval
    );
  }

  createEvent(eventName, event) {
    const eventId = (event.data && event.data.hasOwnProperty('id')) ?
      event.data.id :
      `${eventName}-${event.timestamp}`;

    if (this.notifiedEvents.has(eventId)) {
      return;
    }
    if (!event.hasOwnProperty('timestamp')) {
      event.timestamp = new Date().toISOString();
    }
    this.notifiedEvents.add(eventId);
    const e = new Event(this,
                        eventName,
                        event.data || null);
    e.timestamp = event.timestamp;

    this.eventNotify(e);
  }

  performAction(action) {
    action.start();

    return fetch(this.actionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({[action.name]: {input: action.input}}),
    }).then((res) => {
      return res.json();
    }).then((res) => {
      this.requestedActions.set(res[action.name].href, action);
    }).catch((e) => {
      console.log(`Failed to perform action: ${e}`);
      action.status = 'error';
      this.actionNotify(action);
    });
  }

  cancelAction(actionId, actionName) {
    let promise;

    this.requestedActions.forEach((action, actionHref) => {
      if (action.name === actionName && action.id === actionId) {
        promise = fetch(actionHref, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
          },
        }).catch((e) => {
          console.log(`Failed to cancel action: ${e}`);
        });

        this.requestedActions.delete(actionHref);
      }
    });

    if (!promise) {
      promise = Promise.resolve();
    }

    return promise;
  }
}

class ThingURLAdapter extends Adapter {
  constructor(addonManager) {
    super(addonManager, manifest.id, manifest.id);
    addonManager.addAdapter(this);
    this.knownUrls = {};
    this.pollInterval = POLL_INTERVAL;
  }

  async loadThing(url, retryCounter) {
    if (typeof retryCounter === 'undefined') {
      retryCounter = 0;
    }

    url = url.replace(/\/$/, '');

    if (!this.knownUrls[url]) {
      this.knownUrls[url] = {
        digest: '',
        timestamp: 0,
      };
    }

    if (this.knownUrls[url].timestamp + 5000 > Date.now()) {
      return;
    }

    let res;
    try {
      res = await fetch(url, {headers: {Accept: 'application/json'}});
    } catch (e) {
      // Retry the connection at a 2 second interval up to 5 times.
      if (retryCounter >= 5) {
        console.log(`Failed to connect to ${url}: ${e}`);
      } else {
        setTimeout(() => this.loadThing(url, retryCounter + 1), 2000);
      }

      return;
    }

    const text = await res.text();

    const hash = crypto.createHash('md5');
    hash.update(text);
    const dig = hash.digest('hex');
    let known = false;
    if (this.knownUrls[url].digest === dig) {
      known = true;
    }

    this.knownUrls[url] = {
      digest: dig,
      timestamp: Date.now(),
    };

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.log(`Failed to parse description at ${url}: ${e}`);
      return;
    }

    let things;
    if (Array.isArray(data)) {
      things = data;
    } else {
      things = [data];
    }

    for (const thingDescription of things) {
      let thingUrl = url;
      if (thingDescription.hasOwnProperty('href')) {
        const baseHref = new URL(url).origin;
        thingUrl = baseHref + thingDescription.href;
      }

      const id = thingUrl.replace(/[:/]/g, '-');
      if (id in this.devices) {
        if (known) {
          continue;
        }
        await this.removeThing(this.devices[id]);
      }
      await this.addDevice(id, thingUrl, thingDescription, url);
    }
  }

  unloadThing(url) {
    url = url.replace(/\/$/, '');

    for (const id in this.devices) {
      const device = this.devices[id];
      if (device.mdnsUrl === url) {
        device.closeWebSocket();
        this.removeThing(device);
      }
    }

    if (this.knownUrls[url]) {
      delete this.knownUrls[url];
    }
  }

  /**
   * Add a ThingURLDevice to the ThingURLAdapter
   *
   * @param {String} deviceId ID of the device to add.
   * @return {Promise} which resolves to the device added.
   */
  addDevice(deviceId, deviceURL, description, mdnsUrl) {
    return new Promise((resolve, reject) => {
      if (deviceId in this.devices) {
        reject(`Device: ${deviceId} already exists.`);
      } else {
        const device =
          new ThingURLDevice(this, deviceId, deviceURL, description, mdnsUrl);
        Promise.all(device.propertyPromises).then(() => {
          this.handleDeviceAdded(device);
          resolve(device);
        }).catch((e) => reject(e));
      }
    });
  }

  /**
   * Remove a ThingURLDevice from the ThingURLAdapter.
   *
   * @param {Object} device The device to remove.
   * @return {Promise} which resolves to the device removed.
   */
  removeThing(device) {
    return this.removeDeviceFromConfig(device).then(() => {
      if (this.devices.hasOwnProperty(device.id)) {
        this.handleDeviceRemoved(device);
        device.closeWebSocket();
        return device;
      } else {
        throw new Error(`Device: ${device.id} not found.`);
      }
    });
  }

  /**
   * Remove a device's URL from this adapter's config if it was manually added.
   *
   * @param {Object} device The device to remove.
   */
  async removeDeviceFromConfig(device) {
    try {
      const db = new Database(this.packageName);
      await db.open();
      const config = await db.loadConfig();

      // If the device's URL is saved in the config, remove it.
      const urlIndex = config.urls.indexOf(device.url);
      if (urlIndex >= 0) {
        config.urls.splice(urlIndex, 1);
        await db.saveConfig(config);

        // Remove from list of known URLs as well.
        const adjustedUrl = device.url.replace(/\/$/, '');
        if (this.knownUrls.hasOwnProperty(adjustedUrl)) {
          delete this.knownUrls[adjustedUrl];
        }
      }
    } catch (err) {
      console.error(`Failed to remove device ${device.id} from config: ${err}`);
    }
  }

  startPairing() {
    for (const knownUrl in this.knownUrls) {
      this.loadThing(knownUrl).catch((err) => {
        console.warn(`Unable to reload Thing(s) from ${knownUrl}: ${err}`);
      });
    }
  }

  unload() {
    if (webthingBrowser) {
      webthingBrowser.stop();
    }

    if (subtypeBrowser) {
      subtypeBrowser.stop();
    }

    if (httpBrowser) {
      httpBrowser.stop();
    }

    for (const id in this.devices) {
      this.devices[id].closeWebSocket();
    }

    return super.unload();
  }
}

function startDNSDiscovery(adapter) {
  console.log('Starting mDNS discovery');

  webthingBrowser =
    new dnssd.Browser(new dnssd.ServiceType('_webthing._tcp'));
  webthingBrowser.on('serviceUp', (service) => {
    const host = service.host.replace(/\.$/, '');
    adapter.loadThing(`http://${host}:${service.port}${service.txt.path}`);
  });
  webthingBrowser.on('serviceDown', (service) => {
    const host = service.host.replace(/\.$/, '');
    adapter.unloadThing(`http://${host}:${service.port}${service.txt.path}`);
  });
  webthingBrowser.start();

  // Support legacy devices
  subtypeBrowser =
    new dnssd.Browser(new dnssd.ServiceType('_http._tcp,_webthing'));
  subtypeBrowser.on('serviceUp', (service) => {
    adapter.loadThing(service.txt.url);
  });
  subtypeBrowser.on('serviceDown', (service) => {
    adapter.unloadThing(service.txt.url);
  });
  subtypeBrowser.start();

  httpBrowser = new dnssd.Browser(new dnssd.ServiceType('_http._tcp'));
  httpBrowser.on('serviceUp', (service) => {
    if (typeof service.txt === 'object' &&
        service.txt.hasOwnProperty('webthing')) {
      adapter.loadThing(service.txt.url);
    }
  });
  httpBrowser.on('serviceDown', (service) => {
    if (typeof service.txt === 'object' &&
        service.txt.hasOwnProperty('webthing')) {
      adapter.unloadThing(service.txt.url);
    }
  });
  httpBrowser.start();
}

function loadThingURLAdapter(addonManager) {
  const adapter = new ThingURLAdapter(addonManager);

  const db = new Database(manifest.id);
  db.open().then(() => {
    return db.loadConfig();
  }).then((config) => {
    if (typeof config.pollInterval === 'number') {
      adapter.pollInterval = config.pollInterval * 1000;
    }

    for (const url of config.urls) {
      adapter.loadThing(url);
    }

    startDNSDiscovery(adapter);
  }).catch(console.error);
}

module.exports = loadThingURLAdapter;
