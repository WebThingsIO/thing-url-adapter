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
const EddystoneBeaconScanner = require('eddystone-beacon-scanner');
const {URL} = require('url');
const WebSocket = require('ws');

let Action, Adapter, Constants, Device, Event, Property;
try {
  Action = null;
  Adapter = require('../adapter');
  Constants = require('../addon-constants');
  Device = require('../device');
  Event = null;
  Property = require('../property');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }

  const gwa = require('gateway-addon');
  Action = gwa.Action;
  Adapter = gwa.Adapter;
  Constants = gwa.Constants;
  Device = gwa.Device;
  Event = gwa.Event;
  Property = gwa.Property;
}

class ThingURLProperty extends Property {
  constructor(device, name, url, propertyDescription) {
    super(device, name, propertyDescription);
    this.url = url;
    this.unit = propertyDescription.unit;
    this.description = propertyDescription.description;
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
    return fetch(this.url, {
      method: 'PUT',
      headers: {
        'Content-type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        [this.name]: value
      })
    }).then(res => {
      return res.json();
    }).then(response => {
      let updatedValue = response[this.name];
      this.setCachedValue(updatedValue);
      this.device.notifyPropertyChanged(this);
      return updatedValue;
    });
  }
}

class ThingURLDevice extends Device {
  constructor(adapter, id, url, description) {
    super(adapter, id);
    this.name = description.name;
    this.type = description.type;
    this.url = url;
    this.actionsUrl = null;
    this.eventsUrl = null;
    this.wsUrl = null;
    this.description = description.description;
    this.propertyPromises = [];
    this.ws = null;
    this.requestedActions = new Map();
    this.baseUrl = new URL(url).origin;
    this.notifiedEvents = new Set();
    this.scheduledUpdate = null;
    this.updateInterval = 5000;

    if (Action !== null) {
      for (const actionName in description.actions) {
        this.addAction(actionName, description.actions[actionName]);
      }
    }

    if (Event !== null) {
      for (const eventName in description.events) {
        this.addEvent(eventName, description.events[eventName]);
      }
    }

    for (const propertyName in description.properties) {
      const propertyDescription = description.properties[propertyName];
      const propertyUrl = this.baseUrl + propertyDescription.href;
      this.propertyPromises.push(
        fetch(propertyUrl, {
          headers: {
            Accept: 'application/json',
          },
        }).then(res => {
          return res.json();
        }).then(res => {
          propertyDescription.value = res[propertyName];
          const property = new ThingURLProperty(
            this, propertyName, propertyUrl, propertyDescription);
          this.properties.set(propertyName, property);
        }).catch(e => {
          console.log('Failed to connect to', propertyUrl, ':', e);
        }));
    }

    // If a websocket endpoint exists, connect to it.
    if (description.hasOwnProperty('links')) {
      for (const link of description.links) {
        if (link.rel === 'actions') {
          this.actionsUrl = this.baseUrl + link.href;
        } else if (link.rel === 'events') {
          this.eventsUrl = this.baseUrl + link.href;
        } else if (link.href.startsWith('ws://') ||
                   link.href.startsWith('wss://')) {
          this.wsUrl = link.href;
          this.createWebsocket();
        }
      }
    }

    // If there's no websocket endpoint, poll the device for updates.
    if (!this.ws) {
      Promise.all(this.propertyPromises).then(() => this.poll());
    }
  }

  createWebsocket() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      if (Event !== null) {
        // Subscribe to all events
        const msg = {
          messageType: Constants.ADD_EVENT_SUBSCRIPTION,
          data: {},
        };

        this.events.forEach((_value, key) => {
          msg.data[key] = {};
        });

        this.ws.send(JSON.stringify(msg));
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        switch (msg.messageType) {
          case Constants.PROPERTY_STATUS: {
            const propertyName = Object.keys(msg.data)[0];
            const property = this.findProperty(propertyName);
            if (property) {
              const newValue = msg.data[propertyName];
              property.getValue().then(value => {
                if (value !== newValue) {
                  property.setCachedValue(newValue);
                  this.notifyPropertyChanged(property);
                }
              });
            }
            break;
          }
          case Constants.ACTION_STATUS: {
            if (Action !== null) {
              const actionName = Object.keys(msg.data)[0];
              const action = msg.data[actionName];
              const requestedAction =
                this.requestedActions.get(action.href);
              if (requestedAction) {
                requestedAction.status = action.status;
                requestedAction.timeRequested = action.timeRequested;
                requestedAction.timeCompleted = action.timeCompleted;
                this.actionNotify(requestedAction);
              }
            }
            break;
          }
          case Constants.EVENT: {
            if (Event !== null) {
              const eventName = Object.keys(msg.data)[0];
              const eventId =
                `${eventName}-${msg.data[eventName].timestamp}`;

              if (!this.notifiedEvents.has(eventId)) {
                this.notifiedEvents.add(eventId);
                const event = new Event(this,
                                        eventName,
                                        msg.data[eventName].data || null);
                event.timestamp = msg.data[eventName].timestamp;

                this.eventNotify(event);
              }
            }
            break;
          }
        }
      } catch (e) {
        console.log(e);
      }
    });

    this.ws.on('close', () => this.createWebsocket());
    this.ws.on('error', () => this.createWebsocket());
  }

  poll() {
    // Update properties
    this.properties.forEach(prop => {
      fetch(prop.url, {
        headers: {
          Accept: 'application/json',
        },
      }).then(res => {
        return res.json();
      }).then(res => {
        const newValue = res[prop.name];
        prop.getValue().then(value => {
          if (value !== newValue) {
            prop.setCachedValue(newValue);
            this.notifyPropertyChanged(prop);
          }
        });
      }).catch(e => {
        console.log('Failed to connect to', prop.url, ':', e);
      });
    });

    // Check for new actions
    if (Action !== null && this.actionsUrl !== null) {
      fetch(this.actionsUrl, {
        headers: {
          Accept: 'application/json',
        },
      }).then(res => {
        return res.json();
      }).then(actions => {
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
      }).catch(e => {
        console.log('Failed to fetch actions list:', e);
      });
    }

    // Check for new events
    if (Event !== null && this.eventsUrl !== null) {
      fetch(this.eventsUrl, {
        headers: {
          Accept: 'application/json',
        },
      }).then(res => {
        return res.json();
      }).then(events => {
        for (let event of events) {
          const eventName = Object.keys(event)[0];
          event = event[eventName];
          const eventId = `${eventName}-${event.timestamp}`;

          if (!this.notifiedEvents.has(eventId)) {
            this.notifiedEvents.add(eventId);
            const e = new Event(this, eventName, event.data || null);
            e.timestamp = event.timestamp;

            this.eventNotify(e);
          }
        }
      }).catch(e => {
        console.log('Failed to fetch events list:', e);
      });
    }

    if (this.scheduledUpdate) {
      clearTimeout(this.scheduledUpdate);
    }
    this.scheduledUpdate = setTimeout(() => this.poll(), this.updateInterval);
  }

  performAction(action) {
    action.start();

    return fetch(this.actionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({[action.name]: {input: action.input}}),
    }).then(res => {
      return res.json();
    }).then(res => {
      this.requestedActions.set(res[action.name].href, action);
    });
  }
}

class ThingURLAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, 'ThingURLPlugin', packageName);
    addonManager.addAdapter(this);
    this.knownUrls = {};
  }

  async loadThing(url) {
    url = url.replace(/\/$/, '');

    let res;
    try {
      res = await fetch(url, {headers: {Accept: 'application/json'}});
    } catch(e) {
      console.log('Failed to connect to', url, ':', e);
      return;
    }

    let text = await res.text();

    const hash = crypto.createHash('md5');
    hash.update(text);
    const dig = hash.digest('hex');
    if (this.knownUrls[url] === dig) {
      return;
    }

    this.knownUrls[url] = dig;

    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      console.log('Failed to parse description at', url, ':', e);
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
        const baseUrl = new URL(url).origin;
        thingUrl = baseUrl + thingDescription.href;
      }

      let id = thingUrl.replace(/[:/]/g, '-');
      if (id in this.devices) {
        await this.removeThing(this.devices[id]);
      }
      await this.addDevice(id, thingUrl, thingDescription);
    }
  }

  /**
   * Add a ThingURLDevice to the ThingURLAdapter
   *
   * @param {String} deviceId ID of the device to add.
   * @return {Promise} which resolves to the device added.
   */
  addDevice(deviceId, deviceURL, description) {
    return new Promise((resolve, reject) => {
      if (deviceId in this.devices) {
        reject('Device: ' + deviceId + ' already exists.');
      } else {
        const device =
          new ThingURLDevice(this, deviceId, deviceURL, description);
        Promise.all(device.propertyPromises).then(() => {
          this.handleDeviceAdded(device);
          resolve(device);
        }).catch(e => reject(e));
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
    return new Promise((resolve, reject) => {
      if (this.devices.hasOwnProperty(device.id)) {
        this.handleDeviceRemoved(device);
        resolve(device);
      } else {
        reject('Device: ' + device.id + ' not found.');
      }
    });
  }
}

function startEddystoneDiscovery(adapter) {
  EddystoneBeaconScanner.on('found', function(beacon) {
    if (beacon.type === 'webthing') {
      adapter.loadThing(beacon.url);
    }
  });
  EddystoneBeaconScanner.startScanning();
}

function startDNSDiscovery(adapter) {
  const browser =
    new dnssd.Browser(new dnssd.ServiceType('_http._tcp,_webthing'));
  browser.on('serviceUp', (service) => {
    adapter.loadThing(service.txt.url);
  });
  browser.start();
}

function loadThingURLAdapter(addonManager, manifest, _errorCallback) {
  const adapter = new ThingURLAdapter(addonManager, manifest.name);

  for (const url of manifest.moziot.config.urls) {
    adapter.loadThing(url);
  }

  startEddystoneDiscovery(adapter);
  startDNSDiscovery(adapter);
}

module.exports = loadThingURLAdapter;
